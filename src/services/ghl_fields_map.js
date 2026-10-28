/**
 * ==============================================================================
 * MAPA DE CAMPOS PERSONALIZADOS DE GHL — id -> nombre
 * ==============================================================================
 * DEFECTO REAL (descubierto al correr las auditorías en producción)
 * El endpoint `GET /contacts/{id}` de GHL devuelve los campos personalizados así:
 *
 *     customFields: [ { id: "RV3opVc8o1I7rCnQZnhS", value: "Potencia" }, ... ]
 *
 * Es decir: SOLO `id` y `value`. NO incluye el `name`.
 * Cualquier código que intente leer un campo por NOMBRE sobre esa respuesta
 * obtiene vacío siempre — y produce reportes 100% falsos (nos pasó: la auditoría
 * de campos comerciales marcaba todo como hueco).
 *
 * La solución correcta es la MISMA que usa el motor por dentro: resolver primero
 * el diccionario de campos de la subcuenta (`/locations/{id}/customFields`, que
 * sí trae id + nombre) y luego leer los valores por ID.
 *
 * Este módulo centraliza ese mapa y lo cachea 10 minutos para no golpear la API.
 * ==============================================================================
 */

import { ghlFetch } from '../utils/ghl_http_client.js';
import { resolveSedeContext, resolveSedeCustomFields } from '../config/sedes_gateway.js';

const cache = new Map();
const TTL_MS = 10 * 60 * 1000;

/**
 * Devuelve el diccionario de campos de una subcuenta.
 * @returns {Promise<{porId: Map<string,string>, porNombre: Map<string,string>}>}
 */
export async function obtenerMapaCamposGhl(locationId, headers) {
  if (!locationId) return { porId: new Map(), porNombre: new Map() };

  const cacheado = cache.get(locationId);
  if (cacheado && Date.now() - cacheado.ts < TTL_MS) return cacheado.mapa;

  const mapa = { porId: new Map(), porNombre: new Map() };
  try {
    const r = await ghlFetch(
      `https://services.leadconnectorhq.com/locations/${locationId}/customFields`,
      { headers },
      1,
      'CamposMapa'
    );
    if (r.status === 200) {
      const d = await r.json();
      for (const f of (d.customFields || [])) {
        if (!f?.id) continue;
        mapa.porId.set(f.id, f.name || f.fieldKey || f.id);
        if (f.name) mapa.porNombre.set(String(f.name).toLowerCase(), f.id);
      }
    }
  } catch { /* fail-safe: devuelve un mapa vacío y el llamador decide */ }

  cache.set(locationId, { ts: Date.now(), mapa });
  return mapa;
}

/**
 * Normaliza un nombre de campo para comparar: minúsculas, sin tildes/diacríticos y
 * con espacios colapsados.
 *
 * DEFECTO REAL (detectado auditando): GHL tiene el campo como
 * "Total Historico Gastado USD" (SIN tilde) mientras el código lo buscaba como
 * "Total Histórico Gastado USD" (CON tilde). La comparación exacta fallaba y la
 * auditoría reportaba un 100% de huecos INEXISTENTES en el monto.
 */
export function normalizarNombreCampo(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quita tildes
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lee un valor del contacto por NOMBRE del campo, resolviendo el id->nombre.
 * Tolerante: acepta varias variantes y compara SIN tildes ni diferencias de caja.
 *
 * @param {object} contacto  el `contact` de GHL (con customFields [{id,value}])
 * @param {Map<string,string>} porId  mapa id->nombre de la subcuenta
 * @param {string[]} nombres  variantes aceptadas del nombre del campo
 */
export function leerCampoPorNombre(contacto, porId, nombres = []) {
  const lista = contacto?.customFields || [];
  const buscados = nombres.map(normalizarNombreCampo);
  for (const cf of lista) {
    const nombre = normalizarNombreCampo(porId.get(cf.id) || cf.name || '');
    if (!nombre) continue;
    if (buscados.includes(nombre)) {
      const v = cf.value ?? cf.field_value;
      if (Array.isArray(v)) return v.join(', ');
      if (v !== undefined && v !== null) return String(v).trim();
    }
  }
  return '';
}

/**
 * ==============================================================================
 * [ACTIVACIÓN SUBCUENTAS STANDBY — 28/10]
 * ==============================================================================
 * Roosevelt y Piura no tienen `SEDE_CUSTOM_FIELDS` estático en routing_tables.js
 * (es `null`). Antes el router caía al fallback de PALACIOS y escribía en campos
 * equivocados de esas subcuentas. Aquí se resuelven los 29 campos de la tarjeta
 * dinámicamente: nombre GHL -> ID real contra `/customFields`.
 * ==============================================================================
 */

/** Nombres GHL (con alias) de los campos que el ROUTER escribe por ID. */
export const NOMBRES_CAMPOS_ROUTER = {
  idAnuncio: ['id de anuncio', 'id anuncio', 'ad id'],
  adIdAlt: ['ad id'],
  tratamientoComprado: ['tratamiento comprado', 'tratamiento', 'v tiger tratamiento comprado'],
  utmCampaign: ['utm campaign', 'campana origen'],
  utmSource: ['utm source'],
  utmMedium: ['utm medium'],
  utmContent: ['utm content'],
  utmTerm: ['utm term'],
  adsetId: ['conjunto de anuncios', 'ad set meta', 'conjunto meta'],
  sedeAsignada: ['sede asignada', 'sede origen', 'oficina origen'],
  origenLead: ['origen lead', 'origen del lead'],
  tieneTelefono: ['tiene telefono', 'tiene teléfono'],
  ultimaInteraccion: ['ultima interaccion'],
  estadoComercial: ['estado comercial', 'v tiger estado comercial'],
  statusContacto: ['status del contacto', 'estado del contacto'],
  fechaAsignacion: ['fecha ultima asignacion', 'fecha asignacion'],
  fechaCompra: ['fecha de compra'],
  fechaPrimeraCompra: ['fecha primera compra', 'v tiger fecha primera compra'],
  fechaUltimaCompra: ['fecha ultima compra', 'ultima compra', 'v tiger fecha ultima compra'],
  fechaUltimaFactura: ['fecha ultima factura'],
  precioVenta: ['precio venta', 'monto invertido', 'v tiger precio venta'],
  numCompras: ['total compras', 'numero de compras', 'num compras', 'v tiger total compras'],
  estadoCompraLista: ['estado de compra'],
  sedeTiendaCompra: ['sede tienda compra', 'v tiger sede tienda compra'],
  anotacionesRedes: ['anotaciones redes', 'v tiger anotaciones redes'],
  canalCaptacion: ['canal captacion', 'canal', 'v tiger canal captacion'],
  contactNo: ['contact no', 'numero de contacto', 'v tiger contact no'],
  idCliente: ['id cliente', 'id de cliente', 'v tiger id cliente'],
  historialCompleto: ['historial completo', 'v tiger historial completo']
};

/**
 * Resuelve dinámicamente los IDs de los campos del router para una subcuenta,
 * mapeando NOMBRE GHL -> ID real. Devuelve un mapa con la MISMA forma que
 * `SEDE_CUSTOM_FIELDS` (29 llaves).
 *
 * @param {string} locationId
 * @param {object} headers
 * @returns {Promise<object>} { idAnuncio, adIdAlt, ..., historialCompleto }
 */
export async function resolverSedeCamposDinamicos(locationId, headers) {
  const mapa = await obtenerMapaCamposGhl(locationId, headers);
  const out = {};
  for (const [key, alias] of Object.entries(NOMBRES_CAMPOS_ROUTER)) {
    for (const nombre of alias) {
      const id = mapa.porNombre.get(normalizarNombreCampo(nombre));
      if (id) { out[key] = id; break; }
    }
  }
  return out;
}

/**
 * Resuelve el mapa de campos OPERATIVOS de una subcuenta (la MISMA forma que
 * `SEDE_CUSTOM_FIELDS`, 29 llaves):
 *  - Si tiene mapa estático (PALACIOS/BENAVIDES), lo usa tal cual.
 *  - Si está en standby (Roosevelt/Piura, customFields = null), resuelve por NOMBRE
 *    contra /customFields (y solo como último recurso cae al fallback estático).
 *
 * @param {string} locationId
 * @param {object} headers
 * @returns {Promise<object>}
 */
export async function resolverCamposSedeOperativos(locationId, headers) {
  const ctx = resolveSedeContext({ locationId });
  if (ctx && ctx.customFields) return ctx.customFields;
  const dinamicos = await resolverSedeCamposDinamicos(locationId, headers);
  return (dinamicos && Object.keys(dinamicos).length > 0)
    ? dinamicos
    : resolveSedeCustomFields({ locationId });
}
