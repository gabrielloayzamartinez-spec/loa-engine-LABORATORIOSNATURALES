/**
 * ==============================================================================
 * LOA ENGINE - CONECTOR DE PUBLICACION DE FACTURAS (DEPENDENCIAS REALES)
 * ==============================================================================
 * Une el caso de uso (`invoice_delivery_service.js`) con las implementaciones
 * REALES de cada borde:
 *
 *   descargarPdf     -> sesion web de vTiger (`vtiger_web_session.js`)
 *   subirPdf         -> Media Library de la Cuenta Empresa (`ghl_media_service.js`)
 *   escribirContacto -> custom fields (PUT /contacts/:id) + tags
 *                       (POST /contacts/:id/tags), el MISMO patron que ya usa el
 *                       resto del motor.
 *
 * POR QUE ESTE ARCHIVO EXISTE APARTE:
 *   El caso de uso no debe saber de tokens, URLs ni endpoints. Aqui vive el
 *   "cableado", y por eso recibe `fetchImpl`: asi el flujo COMPLETO (vTiger +
 *   GHL) se prueba de punta a punta sin tocar ningun sistema real.
 *
 * CONTRATO DEL PUENTE (lo que el workflow de GHL consume):
 *   Campo `URL Factura PDF`   + Tag `FACTURA_LISTA`  -> dispara el envio.
 *   Campo `Factura Nº Orden`                          -> idempotencia.
 * ==============================================================================
 */

import { readSecret } from '../config/secrets.js';
import { ghlFetch } from '../utils/ghl_http_client.js';
import { crearClienteSesionWeb } from './vtiger_web_session.js';
import { subirPdfAMediaLibrary } from './ghl_media_service.js';
import { entregarFacturaDeOrden } from './invoice_delivery_service.js';
import { CLAVES_PUENTE_FACTURA } from './invoice_bridge_service.js';
import { resolveCustomFieldIds } from './dual_sync_service.js';

const BASE_GHL = 'https://services.leadconnectorhq.com';

/**
 * Nombres EXACTOS de los campos puente en GHL.
 * Deben coincidir con lo que se cree en la Cuenta Empresa: si el nombre cambia,
 * la resolucion por nombre falla y el flujo se detiene en seco (fail-safe), en
 * lugar de escribir en un campo equivocado.
 */
export const NOMBRES_CAMPOS_FACTURA = {
  [CLAVES_PUENTE_FACTURA.urlFacturaPdf]: 'URL Factura PDF',
  [CLAVES_PUENTE_FACTURA.facturaNumeroOrden]: 'Factura Nº Orden'
};

/** Cabeceras para la API v2 de GHL con el PIT de la location destino. */
export function headersCentral(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

/** Wrapper de red: usa `fetchImpl` en pruebas y `ghlFetch` (con freno y 429) en produccion. */
function enviarCon(fetchImpl, caller) {
  return fetchImpl
    ? (url, opciones) => fetchImpl(url, opciones)
    : (url, opciones) => ghlFetch(url, opciones, 1, caller);
}

/** Lee el contacto en GHL (para el estado puente / idempotencia). */
export async function leerContactoGhl(contactId, { headers, fetchImpl = null, caller = 'InvoicePublisher' } = {}) {
  const enviar = enviarCon(fetchImpl, caller);
  try {
    const res = await enviar(`${BASE_GHL}/contacts/${encodeURIComponent(contactId)}`, { method: 'GET', headers });
    const texto = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
    if (!res.ok) return { ok: false, status: res.status, contacto: null, detalle: String(texto).slice(0, 180) };
    let cuerpo = null;
    try { cuerpo = JSON.parse(texto); } catch { cuerpo = null; }
    return { ok: true, status: res.status, contacto: cuerpo?.contact || cuerpo || null, detalle: null };
  } catch (e) {
    return { ok: false, status: 0, contacto: null, detalle: e.message };
  }
}

/** Escribe los custom fields del puente (una sola llamada). */
export async function escribirCamposPuente(contactId, customFields, { headers, fetchImpl = null, caller = 'InvoicePublisher' } = {}) {
  if (!contactId || !Array.isArray(customFields) || !customFields.length) {
    return { ok: false, skipped: true, detalle: 'sin campos' };
  }
  const enviar = enviarCon(fetchImpl, caller);
  try {
    const res = await enviar(`${BASE_GHL}/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ customFields })
    });
    const texto = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
    return { ok: res.ok, status: res.status, detalle: res.ok ? null : String(texto).slice(0, 180) };
  } catch (e) {
    return { ok: false, status: 0, detalle: e.message };
  }
}

/** Agrega tags al contacto (dispara el workflow en GHL). */
export async function agregarTagsContacto(contactId, tags, { headers, fetchImpl = null, caller = 'InvoicePublisher' } = {}) {
  if (!contactId || !Array.isArray(tags) || !tags.length) return { ok: false, skipped: true, detalle: 'sin tags' };
  const enviar = enviarCon(fetchImpl, caller);
  try {
    const res = await enviar(`${BASE_GHL}/contacts/${encodeURIComponent(contactId)}/tags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags })
    });
    const texto = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
    return { ok: res.ok, status: res.status, detalle: res.ok ? null : String(texto).slice(0, 180) };
  } catch (e) {
    return { ok: false, status: 0, detalle: e.message };
  }
}

/**
 * Construye las dependencias REALES del caso de uso.
 *
 * @param {object}   args
 * @param {string}   args.apiKeyCentral    PIT de la Cuenta Empresa.
 * @param {string}   args.locationIdCentral Location de la Cuenta Empresa.
 * @param {Function} [args.fetchImpl]      Inyectable para pruebas.
 * @param {object}   [args.clienteSesionWeb] Cliente de sesion web ya construido.
 */
export function crearDepsFactura({ apiKeyCentral, locationIdCentral, fetchImpl = null, clienteSesionWeb = null } = {}) {
  const headers = headersCentral(apiKeyCentral);
  const cliente = clienteSesionWeb || crearClienteSesionWeb(fetchImpl ? { fetchImpl } : {});

  return {
    /** PDF oficial desde vTiger (sesion web). */
    descargarPdf: async ({ orden }) => {
      const r = await cliente.descargarPdfAuto({ record: orden.id, modulo: 'SalesOrder' });
      return r.ok
        ? { ok: true, buf: r.buf, folderId: r.folderId }
        : { ok: false, motivo: 'EXPORT_PDF_SIN_PDF' };
    },

    /** Publicacion en la Media Library -> URL publica. */
    subirPdf: async ({ nombreArchivo, contenido }) => subirPdfAMediaLibrary({
      locationId: locationIdCentral,
      nombreArchivo,
      contenido,
      apiKey: apiKeyCentral,
      fetchImpl
    }),

    /** Marca el contacto: campos del puente + tag que dispara el workflow. */
    escribirContacto: async ({ contactId, customFields, tags }) => {
      const campos = await escribirCamposPuente(contactId, customFields, { headers, fetchImpl });
      if (!campos.ok) return { ok: false, detalle: `customFields: ${campos.detalle || campos.status}` };
      const etiquetas = await agregarTagsContacto(contactId, tags, { headers, fetchImpl });
      if (!etiquetas.ok) return { ok: false, detalle: `tags: ${etiquetas.detalle || etiquetas.status}` };
      return { ok: true, detalle: null };
    }
  };
}

/**
 * Publica la factura de UNA orden para UN contacto de la Cuenta Empresa.
 *
 * Flujo: leer contacto -> (resolver campos) -> caso de uso completo.
 * Devuelve siempre un objeto (nunca lanza): el motor no se cae por una factura.
 */
export async function publicarFacturaDeContacto({
  contactId,
  orden,
  apiKeyCentral = readSecret('GHL_API_KEY_CENTRAL'),
  locationIdCentral = readSecret('GHL_LOCATION_ID_CENTRAL'),
  fieldIds = null,
  sede = null,
  habilitado = null,
  fetchImpl = null,
  deps = null
} = {}) {
  if (!contactId) return { publicado: false, motivo: 'SIN_CONTACTO', url: null, numeroOrden: null, fileId: null, detalle: null, pasos: [] };
  if (!apiKeyCentral || !locationIdCentral) {
    return { publicado: false, motivo: 'CUENTA_EMPRESA_NO_CONFIGURADA', url: null, numeroOrden: null, fileId: null, detalle: 'Faltan GHL_API_KEY_CENTRAL / GHL_LOCATION_ID_CENTRAL', pasos: [] };
  }

  const headers = headersCentral(apiKeyCentral);

  // 1. Estado actual del contacto (fuente de verdad de la idempotencia).
  const lectura = await leerContactoGhl(contactId, { headers, fetchImpl });
  if (!lectura.ok || !lectura.contacto) {
    // Sin estado del contacto NO hay idempotencia verificable: no se publica a ciegas.
    return { publicado: false, motivo: 'CONTACTO_ILEGIBLE', url: null, numeroOrden: null, fileId: null, detalle: `${lectura.status || 0} ${lectura.detalle || 'respuesta sin contacto'}`.trim(), pasos: [] };
  }

  // 2. IDs de los campos puente (por nombre). Se pueden inyectar ya resueltos.
  let ids = fieldIds;
  if (!ids) {
    try {
      const mapa = await resolveCustomFieldIds(locationIdCentral, headers);
      ids = {
        [CLAVES_PUENTE_FACTURA.urlFacturaPdf]: mapa?.urlFacturaPdf || null,
        [CLAVES_PUENTE_FACTURA.facturaNumeroOrden]: mapa?.facturaNumeroOrden || null
      };
    } catch (e) {
      return { publicado: false, motivo: 'CAMPOS_NO_RESUELTOS', url: null, numeroOrden: null, fileId: null, detalle: e.message, pasos: [] };
    }
  }

  // 3. Caso de uso (con las deps reales o las inyectadas en pruebas).
  const depsEfectivas = deps || crearDepsFactura({ apiKeyCentral, locationIdCentral, fetchImpl });
  return entregarFacturaDeOrden({
    orden,
    contactoGhl: lectura.contacto,
    contactId,
    fieldIds: ids,
    deps: depsEfectivas,
    habilitado,
    sede
  });
}
