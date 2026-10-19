/**
 * ==============================================================================
 * COOLDOWN UNIFICADO reactivo ↔ batch (vTiger)
 * ==============================================================================
 * PROBLEMA (auditoría B): /webhook/vtiger/reactive procesa un registro en el
 * segundo 0, y a los ~2 min el Reverse Sync (poll de 3 min) lo vuelve a leer y lo
 * reenvía a GHL. Ambos motores deben compartir un cooldown por registro.
 *
 * CLAVE: `vtiger_record_id` + teléfono normalizado. Si el reactivo ya tocó el
 * registro hace menos de N minutos, el batch debe IGNORARLO.
 * ==============================================================================
 */

import { getStateStore } from './state/state_store.js';

const store = getStateStore('reactive_cooldown');
const PREFIJO = 'cooldown_v1';
const COOLDOWN_MS = 10 * 60 * 1000; // 10 min

const cache = new Map(); // clave -> ts

/** Clave única de cooldown por registro vTiger. */
export function claveCooldown(vtigerId, phone) {
  return `${String(vtigerId || '').trim()}:${String(phone || '').replace(/\D/g, '')}`;
}

/** Marca que un registro fue procesado por el motor REACTIVO ahora. */
export async function marcarProcesadoReactivo(vtigerId, phone) {
  const clave = claveCooldown(vtigerId, phone);
  const ts = Date.now();
  cache.set(clave, ts);
  await store.set(`${PREFIJO}:${clave}`, ts).catch(() => {});
}

/**
 * ¿Este registro está en cooldown (lo acaba de procesar el reactivo)?
 * El batch (Reverse Sync / Sales Bridge) debe saltarlo si es true.
 */
export async function estaEnCooldown(vtigerId, phone) {
  const clave = claveCooldown(vtigerId, phone);
  const ts = cache.get(clave) || (await store.get(`${PREFIJO}:${clave}`, 0).catch(() => 0));
  return (Date.now() - Number(ts || 0)) < COOLDOWN_MS;
}
