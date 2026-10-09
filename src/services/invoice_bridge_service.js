/**
 * ==============================================================================
 * LOA ENGINE - PUENTE DE FACTURA PDF (vTiger -> Cuenta Empresa Central -> GHL)
 * ==============================================================================
 * RESPONSABILIDAD UNICA: traducir "hay una compra nueva con PDF disponible" al
 * CONTRATO DE DATOS que la Cuenta Empresa Central entiende, y decidir con
 * IDEMPOTENCIA ESTRICTA si corresponde publicar o no.
 *
 * POR QUE EXISTE ESTE MODULO (y no se escribe suelto en el servicio de sync):
 *   1. La Cuenta Empresa es un Data Warehouse de solo lectura/analitica. Un
 *      error de idempotencia aqui NO se queda en un contacto: dispara el workflow
 *      de GHL y manda un WhatsApp/SMS REAL al cliente. Un reenvio masivo es el
 *      peor dano posible del sistema.
 *   2. La decision "publicar / no publicar" debe poder probarse SIN red, sin
 *      vTiger y sin GHL. Por eso vive en funciones PURAS (cero fetch, cero env).
 *   3. El contrato (nombres de campo y tags) debe estar en UN solo lugar: el
 *      workflow de GHL se arma contra estos literales exactos.
 *
 * CONTRATO PUBLICADO (el workflow de GHL se dispara con esto):
 *   Campo  `URL Factura PDF`      -> URL publica del PDF en la Media Library.
 *   Campo  `Factura Nº Orden`     -> numero de orden YA publicada (IDEMPOTENCIA).
 *   Tag    `FACTURA_LISTA`        -> disparador del workflow de envio.
 *   Tag    `FACTURA_ENVIADA`      -> cierre: impide reenvios.
 *
 * NOTA DE DISENO: los IDs reales de los campos se resuelven por NOMBRE contra la
 * location correspondiente (`resolveCustomFieldIds` de dual_sync_service.js), asi
 * que este modulo recibe un mapa `fieldIds` y nunca hardcodea IDs de GHL.
 * ==============================================================================
 */

/** Tag que dispara el workflow de envio en la Cuenta Empresa. */
export const TAG_FACTURA_LISTA = 'FACTURA_LISTA';

/** Tag de cierre: marca que la factura ya viajo al cliente. */
export const TAG_FACTURA_ENVIADA = 'FACTURA_ENVIADA';

/** Claves logicas de los campos puente (lo que se resuelve por nombre en GHL). */
export const CLAVES_PUENTE_FACTURA = {
  urlFacturaPdf: 'urlFacturaPdf',
  facturaNumeroOrden: 'facturaNumeroOrden'
};

/** Motivos de la decision de publicacion (observabilidad / auditoria). */
export const MOTIVOS_PUBLICACION = {
  COMPRA_NUEVA: 'COMPRA_NUEVA',
  YA_PUBLICADA: 'YA_PUBLICADA',
  ORDEN_SIN_NUMERO: 'ORDEN_SIN_NUMERO',
  ORDEN_SIN_ID: 'ORDEN_SIN_ID',
  SIN_PDF: 'SIN_PDF'
};

/**
 * Nombre de archivo seguro para el PDF publicado.
 * Evita caracteres que rompen URLs o el storage de GHL.
 */
export function nombreArchivoFactura(numeroOrden = '') {
  const limpio = String(numeroOrden)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `factura_${limpio || 'sin-numero'}.pdf`;
}

/**
 * Decide si corresponde publicar la factura de una orden.
 *
 * REGLA DE ORO (idempotencia): el campo `Factura Nº Orden` del contacto es la
 * UNICA fuente de verdad. Si ya contiene el numero de la orden evaluada, la
 * factura ya fue publicada y NO se vuelve a publicar, aunque el ciclo se repita
 * cien veces. Una recompra (numero distinto) SI se publica.
 *
 * @param {object} orden          Orden normalizada (ver normalizeOrder).
 * @param {object} estadoActual   Estado puente leido del contacto en GHL.
 * @param {string} urlPdf         URL publica ya obtenida para esa orden.
 * @param {boolean} requerirPdf   `false` permite el CORTE TEMPRANO: decidir antes
 *                                de descargar el PDF (ahorra trabajo cuando la
 *                                orden ya fue publicada). La validacion final,
 *                                previa a escribir en GHL, siempre usa `true`.
 * @returns {{ publicar: boolean, motivo: string }}
 */
export function decidirPublicacion({ orden = {}, estadoActual = {}, urlPdf = '', requerirPdf = true } = {}) {
  const numeroOrden = String(orden.numeroOrden || '').trim();
  if (!numeroOrden) return { publicar: false, motivo: MOTIVOS_PUBLICACION.ORDEN_SIN_NUMERO };
  if (!String(orden.id || '').trim()) return { publicar: false, motivo: MOTIVOS_PUBLICACION.ORDEN_SIN_ID };
  if (requerirPdf && !String(urlPdf || '').trim()) return { publicar: false, motivo: MOTIVOS_PUBLICACION.SIN_PDF };

  const yaPublicada = String(estadoActual.facturaNumeroOrden || '').trim();
  if (yaPublicada && yaPublicada === numeroOrden) {
    return { publicar: false, motivo: MOTIVOS_PUBLICACION.YA_PUBLICADA };
  }

  return { publicar: true, motivo: MOTIVOS_PUBLICACION.COMPRA_NUEVA };
}

/**
 * Construye el payload de campos + tags para la Cuenta Empresa.
 * Solo incluye los campos cuyos IDs fueron resueltos (fail-safe: si un ID no se
 * resolvio, no se inventa ni se manda basura).
 *
 * @throws {TypeError} si falta la URL o el numero de orden (error de programacion).
 */
export function construirPuenteFactura({ urlPdf = '', numeroOrden = '', fieldIds = {} } = {}) {
  const url = String(urlPdf).trim();
  const numero = String(numeroOrden).trim();

  if (!url || !numero) {
    throw new TypeError('construirPuenteFactura requiere urlPdf y numeroOrden no vacios.');
  }

  const customFields = [];
  if (fieldIds[CLAVES_PUENTE_FACTURA.urlFacturaPdf]) {
    customFields.push({ id: fieldIds[CLAVES_PUENTE_FACTURA.urlFacturaPdf], field_value: url });
  }
  if (fieldIds[CLAVES_PUENTE_FACTURA.facturaNumeroOrden]) {
    customFields.push({ id: fieldIds[CLAVES_PUENTE_FACTURA.facturaNumeroOrden], field_value: numero });
  }

  return { customFields, tags: [TAG_FACTURA_LISTA] };
}

/** Tags de cierre, una vez que el mensaje salio. */
export function construirCierreEnvio() {
  return { agregar: [TAG_FACTURA_ENVIADA], quitar: [TAG_FACTURA_LISTA] };
}

/**
 * Lee el estado puente actual de un contacto de GHL.
 * Tolera las dos formas en que GHL devuelve un campo personalizado (`value` o
 * `field_value`) y busca por `id` o por `key` indistintamente.
 */
export function leerEstadoPuenteFactura(contactoGhl = {}, fieldIds = {}) {
  // BLINDAJE: GHL puede devolver `null` (contacto borrado, respuesta no-JSON).
  // Un estado ilegible NO debe tumbar el flujo: se reporta vacio.
  const contacto = contactoGhl || {};
  const campos = Array.isArray(contacto.customFields) ? contacto.customFields : [];

  const valorDe = (id = '', key = '') => {
    const encontrado = campos.find(c => (id && (c.id === id || c.key === id)) || (key && c.key === key));
    if (!encontrado) return '';
    return String(encontrado.value ?? encontrado.field_value ?? '').trim();
  };

  return {
    urlFacturaPdf: valorDe(fieldIds[CLAVES_PUENTE_FACTURA.urlFacturaPdf], 'contact.url_factura_pdf'),
    facturaNumeroOrden: valorDe(fieldIds[CLAVES_PUENTE_FACTURA.facturaNumeroOrden], 'contact.factura_numero_orden'),
    tags: Array.isArray(contacto.tags) ? [...contacto.tags] : []
  };
}
