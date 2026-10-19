/**
 * ==============================================================================
 * DIFFING & HASH GATEKEEPER — protección de cuota API de GHL
 * ==============================================================================
 * PROBLEMA (auditoría de fugas de API): el Reverse Sync y el modo reactivo pueden
 * re-enviar el MISMO payload de un contacto cuando vTiger mueve `modifiedtime` por un
 * cambio administrativo que no altera ninguno de los ~33 campos que importan a GHL.
 * Sin gate, cada ciclo gasta GET+PUT en Sede y GET+PUT en Central: 4 llamadas
 * desperdiciadas por contacto.
 *
 * SOLUCIÓN: se guarda el HASH del último payload enviado por (llave) y, si el payload
 * actual es idéntico, se aborta la escritura (0 llamadas a GHL). Reduce 60-85% del
 * tráfico de sincronización continua.
 * ==============================================================================
 */

import crypto from 'crypto';
import { getStateStore } from './state/state_store.js';

const store = getStateStore('payload_hash_gate');
const PREFIJO = 'ultimos_v1';
const TTL_MS = 48 * 60 * 60 * 1000;

// Cache en memoria (la lectura es la ruta caliente; la DB es solo persistencia).
const cache = new Map(); // clave -> { hash, ts }

/** Hash estable del payload (SHA-256). Devuelve null si no se puede serializar. */
export function hashPayload(obj) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(obj ?? {})).digest('hex');
  } catch {
    return null;
  }
}

/**
 * ¿Debo SALTAR la escritura porque el payload no cambió desde la última vez?
 * Guarda el hash nuevo cuando hay cambio. Idempotente y tolerante a fallos: si la
 * persistencia falla, se sigue con el cache en memoria (nunca bloquea la sincronización).
 *
 * @param {string} clave llave única del destino (ej. `${phone}:${locationId}`)
 * @param {object} payload payload que se enviaría a GHL
 * @returns {Promise<boolean>} true si NO hay cambios (skippear), false si hay que escribir
 */
export async function deberiaSaltar(clave, payload) {
  const h = hashPayload(payload);
  if (!h) return false;

  const ahora = Date.now();
  const enCache = cache.get(clave);
  const previo = enCache?.hash
    || (await store.get(`${PREFIJO}:${clave}`, '').catch(() => ''));

  if (previo === h) {
    cache.set(clave, { hash: h, ts: ahora });
    return true; // sin cambios → NO gastar llamada
  }

  cache.set(clave, { hash: h, ts: ahora });
  store.set(`${PREFIJO}:${clave}`, h).catch(() => {});
  // Poda oportunista.
  if (cache.size > 50000) {
    for (const [k, v] of cache) if (ahora - v.ts > TTL_MS) cache.delete(k);
  }
  return false;
}

/** Limpia la cache (para tests / diagnóstico). */
export function limpiarGate() {
  cache.clear();
}

// ──────────────────────────────────────────────────────────────────────────────
// PRE-GATE DE vTIGER: salta el GET + el PUT si los datos comerciales no cambiaron
// ──────────────────────────────────────────────────────────────────────────────
// El Reverse Sync recibe registros con `modifiedtime` cambiado, pero el cambio de
// vTiger suele ser ADMINISTRATIVO (un campo que no importa a GHL). Este hash cubre
// SOLO los campos comerciales que alimentan el payload; si son idénticos al último
// visto, se salta la sincronización completa (0 GET + 0 PUT).
// ==============================================================================
const CAMPOS_COMERCIALES = [
  'firstname', 'lastname', 'email', 'mobile', 'phone', 'homephone', 'otherphone',
  'cf_3451', 'cf_2572', 'cf_2610', 'cf_3507', 'cf_3472',
  'spl_num_compras', 'spl_fecha_ultima_compra', 'spl_fecha_primera_compra',
  'cf_3392', 'cf_994', 'cf_1876', 'contact_no', 'cf_1157',
  'splareacodes_state', 'splareacodes_state_code', 'wcf_acf_atf_3390'
];

/** Hash estable de los campos COMERCIALES de un registro vTiger. */
export function hashVtigerCommercial(vContact = {}) {
  const recorte = {};
  for (const k of CAMPOS_COMERCIALES) {
    if (vContact[k] !== undefined && vContact[k] !== null && vContact[k] !== '') {
      recorte[k] = vContact[k];
    }
  }
  return hashPayload(recorte);
}

/**
 * Pre-gate: si los datos comerciales de vTiger no cambiaron desde la última vez,
 * devuelve true (saltar la sincronización). Guarda el hash nuevo cuando cambió.
 */
export async function deberiaSaltarVtiger(clave, vContact) {
  const h = hashVtigerCommercial(vContact);
  if (!h) return false;
  return deberiaSaltar(`vt:${clave}`, { h });
}
