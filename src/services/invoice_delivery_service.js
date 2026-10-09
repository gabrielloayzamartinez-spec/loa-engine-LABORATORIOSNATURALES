/**
 * ==============================================================================
 * LOA ENGINE - ENTREGA DE LA FACTURA PDF (ORQUESTADOR DEL FLUJO COMPLETO)
 * ==============================================================================
 * Une las piezas del objetivo en UN solo caso de uso, en este orden:
 *
 *   1. CORTE TEMPRANO   -> si la orden ya fue publicada, no se descarga nada.
 *   2. PDF              -> descarga el PDF oficial (sesion web de vTiger).
 *   3. PUBLICACION      -> sube el PDF a la Media Library y obtiene la URL.
 *   4. VALIDACION FINAL -> con la URL real en mano, se confirma la publicacion.
 *   5. PUENTE           -> escribe campos + tag en el contacto de la Cuenta
 *                          Empresa; el workflow de GHL hace el ENVIO.
 *
 * POR QUE LAS DEPENDENCIAS SE INYECTAN (`deps`):
 *   El caso de uso debe poder probarse de punta a punta SIN vTiger y SIN GHL.
 *   Cada efecto externo entra por una funcion: `descargarPdf`, `subirPdf`,
 *   `escribirContacto`. En produccion se conectan las implementaciones reales
 *   (vtiger_web_session.js + ghl_media_service.js + dual_sync_service.js).
 *
 * POR QUE NO ENVIA EL MENSAJE:
 *   El envio vive en el workflow de GHL (asi lo decidio el dueno). Este modulo
 *   termina cuando el contacto queda marcado; a partir de ahi, el unico camino
 *   al cliente es el tag `FACTURA_LISTA`.
 *
 * GARANTIA ANTI-DUPLICADO: el campo `Factura Nº Orden` es la fuente de verdad.
 * Si el flujo se repite (scheduler, reintento, backfill), el cliente NO recibe
 * un segundo mensaje: el corte temprano lo bloquea antes de descargar el PDF.
 * ==============================================================================
 */

import { recordAuditEvent } from './audit_logger.js';
import {
  decidirPublicacion, construirPuenteFactura, leerEstadoPuenteFactura,
  nombreArchivoFactura, MOTIVOS_PUBLICACION
} from './invoice_bridge_service.js';

/** Resultados posibles del caso de uso (observabilidad / auditoria). */
export const MOTIVOS_ENTREGA = {
  PUBLICADA: 'PUBLICADA',
  DESACTIVADO: 'DESACTIVADO',
  SIN_CONTACTO: 'SIN_CONTACTO',
  ORDEN_INVALIDA: 'ORDEN_INVALIDA',
  YA_PUBLICADA: 'YA_PUBLICADA',
  PDF_NO_DISPONIBLE: 'PDF_NO_DISPONIBLE',
  MEDIA_NO_DISPONIBLE: 'MEDIA_NO_DISPONIBLE',
  ESCRITURA_FALLIDA: 'ESCRITURA_FALLIDA',
  DEPS_INCOMPLETAS: 'DEPS_INCOMPLETAS'
};

/**
 * Feature flag del flujo. Nace APAGADO: nada se publica hasta que el dueno lo
 * active explicitamente (`INVOICE_PDF_ENABLED=true`).
 */
export function facturaPdfHabilitada(env = process.env) {
  return String(env?.INVOICE_PDF_ENABLED ?? '').trim().toLowerCase() === 'true';
}

function auditar(evento) {
  try { recordAuditEvent(evento); } catch { /* la auditoria nunca tumba el flujo */ }
}

/**
 * Ejecuta el caso de uso completo para UNA orden de UN contacto.
 *
 * @param {object}   args
 * @param {object}   args.orden          Orden normalizada (numeroOrden, id...).
 * @param {object}   [args.contactoGhl]  Contacto actual de la Cuenta Empresa.
 * @param {string}   args.contactId      ID del contacto destino en GHL.
 * @param {object}   [args.fieldIds]     IDs resueltos de los campos puente.
 * @param {object}   args.deps           { descargarPdf, subirPdf, escribirContacto }
 * @param {boolean}  [args.habilitado]   Override del feature flag (pruebas).
 * @param {string}   [args.sede]         Etiqueta de sede para la auditoria.
 * @returns {Promise<{publicado: boolean, motivo: string, url: string|null, numeroOrden: string|null, fileId: string|null, detalle: string|null, pasos: string[]}>}
 */
export async function entregarFacturaDeOrden({
  orden = {},
  contactoGhl = {},
  contactId = '',
  fieldIds = {},
  deps = {},
  habilitado = null,
  sede = null
} = {}) {
  const resultado = { publicado: false, motivo: null, url: null, numeroOrden: null, fileId: null, detalle: null, pasos: [] };

  // 0. Interruptor general.
  const activo = habilitado === null ? facturaPdfHabilitada() : Boolean(habilitado);
  if (!activo) return { ...resultado, motivo: MOTIVOS_ENTREGA.DESACTIVADO };
  resultado.pasos.push('flag_ok');

  // 1. Datos minimos.
  if (!contactId) return { ...resultado, motivo: MOTIVOS_ENTREGA.SIN_CONTACTO };
  if (!String(orden?.numeroOrden || '').trim() || !String(orden?.id || '').trim()) {
    return { ...resultado, motivo: MOTIVOS_ENTREGA.ORDEN_INVALIDA };
  }
  resultado.numeroOrden = String(orden.numeroOrden).trim();

  const faltantes = ['descargarPdf', 'subirPdf', 'escribirContacto'].filter(k => typeof deps[k] !== 'function');
  if (faltantes.length) {
    return { ...resultado, motivo: MOTIVOS_ENTREGA.DEPS_INCOMPLETAS, detalle: `Faltan: ${faltantes.join(', ')}` };
  }

  // 2. CORTE TEMPRANO: idempotencia ANTES de gastar trabajo y cuota.
  const estado = leerEstadoPuenteFactura(contactoGhl, fieldIds);
  const previo = decidirPublicacion({ orden, estadoActual: estado, requerirPdf: false });
  if (!previo.publicar) {
    const motivo = previo.motivo === MOTIVOS_PUBLICACION.YA_PUBLICADA ? MOTIVOS_ENTREGA.YA_PUBLICADA : MOTIVOS_ENTREGA.ORDEN_INVALIDA;
    return { ...resultado, motivo, detalle: previo.motivo };
  }
  resultado.pasos.push('corte_temprano_ok');

  // 3. PDF oficial.
  let pdf = null;
  try {
    pdf = await deps.descargarPdf({ orden, numeroOrden: resultado.numeroOrden });
  } catch (e) {
    pdf = { ok: false, motivo: 'EXCEPCION_DESCARGA', detalle: e.message };
  }
  if (!pdf?.ok || !pdf?.buf) {
    auditar({
      type: 'INVOICE_PDF_DESCARGA_FALLIDA', severity: 'warn', sede,
      vTigerId: orden.id, message: `No se obtuvo el PDF de la orden ${resultado.numeroOrden}: ${pdf?.motivo || 'sin detalle'}`
    });
    return { ...resultado, motivo: MOTIVOS_ENTREGA.PDF_NO_DISPONIBLE, detalle: pdf?.motivo || pdf?.detalle || null, pasos: [...resultado.pasos, 'pdf_fallido'] };
  }
  resultado.pasos.push('pdf_ok');

  // 4. Publicacion en la Media Library.
  const nombreArchivo = nombreArchivoFactura(resultado.numeroOrden);
  let subida = null;
  try {
    subida = await deps.subirPdf({ nombreArchivo, contenido: pdf.buf, orden, numeroOrden: resultado.numeroOrden });
  } catch (e) {
    subida = { ok: false, motivo: 'EXCEPCION_SUBIDA', detalle: e.message };
  }
  if (!subida?.ok || !subida?.url) {
    auditar({
      type: 'INVOICE_PDF_PUBLICACION_FALLIDA', severity: 'warn', sede,
      vTigerId: orden.id, message: `No se pudo publicar el PDF de ${resultado.numeroOrden}: ${subida?.motivo || 'sin detalle'}`
    });
    return { ...resultado, motivo: MOTIVOS_ENTREGA.MEDIA_NO_DISPONIBLE, detalle: subida?.motivo || subida?.detalle || null, pasos: [...resultado.pasos, 'media_fallida'] };
  }
  resultado.url = subida.url;
  resultado.fileId = subida.fileId || null;
  resultado.pasos.push('media_ok');

  // 5. Validacion FINAL con la URL real (la idempotencia se reevalua).
  const final = decidirPublicacion({ orden, estadoActual: estado, urlPdf: subida.url });
  if (!final.publicar) {
    return { ...resultado, motivo: MOTIVOS_ENTREGA.YA_PUBLICADA, detalle: final.motivo, pasos: [...resultado.pasos, 'validacion_final_bloqueo'] };
  }

  const puente = construirPuenteFactura({ urlPdf: subida.url, numeroOrden: resultado.numeroOrden, fieldIds });
  if (!puente.customFields.length) {
    return { ...resultado, motivo: MOTIVOS_ENTREGA.DEPS_INCOMPLETAS, detalle: 'No se resolvio ningun campo puente en la location destino.', pasos: [...resultado.pasos, 'sin_campos'] };
  }

  // 6. Escritura del puente en el contacto (dispara el workflow de GHL).
  let escritura = null;
  try {
    escritura = await deps.escribirContacto({ contactId, customFields: puente.customFields, tags: puente.tags, orden, url: subida.url });
  } catch (e) {
    escritura = { ok: false, detalle: e.message };
  }
  if (escritura && escritura.ok === false) {
    auditar({
      type: 'INVOICE_PDF_ESCRITURA_FALLIDA', severity: 'warn', sede,
      vTigerId: orden.id, message: `El PDF se publico (${resultado.url}) pero no se pudo marcar el contacto: ${escritura.detalle || 'sin detalle'}`
    });
    return { ...resultado, motivo: MOTIVOS_ENTREGA.ESCRITURA_FALLIDA, detalle: escritura.detalle || null, pasos: [...resultado.pasos, 'escritura_fallida'] };
  }
  resultado.pasos.push('escritura_ok');

  auditar({
    type: 'INVOICE_PDF_PUBLICADA', severity: 'info', sede,
    vTigerId: orden.id,
    message: `Factura de la orden ${resultado.numeroOrden} publicada y marcada para envio (tag FACTURA_LISTA).`
  });

  return { ...resultado, publicado: true, motivo: MOTIVOS_ENTREGA.PUBLICADA };
}
