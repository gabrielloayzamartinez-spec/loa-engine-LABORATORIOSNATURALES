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
