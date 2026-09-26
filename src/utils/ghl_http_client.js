/**
 * LOA ENGINE - GHL HTTP Client Centralizado
 * 
 * Un único rate limiter global compartido por TODOS los módulos del sistema.
 * Evita que el Radar, el Router y el Reverse Sync se pisen entre sí con
 * bloqueadores de rate-limit independientes.
 * 
 * Con 300K+ contactos en la base, es crítico no desperdiciar llamadas API.
 */

import { GHL_CONFIG, SEDES_GATEWAY } from '../config/index.js';
import { tokenBucketQueue } from '../services/token_bucket_queue.js';
import { logApiTelemetry } from './telemetry.js';

const { apiKey } = GHL_CONFIG;

// Headers reutilizables
export const GHL_HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

export const GHL_HEADERS_READ = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Accept': 'application/json'
};

// ==========================================
// RATE LIMITER AISLADO POR SUBCUENTA CON ETIQUETADO CLARO
// ==========================================
const rateLimiters = new Map();
const consecutive429Counts = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Resuelve el nombre de la subcuenta a partir del Location ID (URL) o, en su
 * defecto, del PIT presente en los headers.
 *
 * ARQUITECTURA DESCENTRALIZADA: la resolución es estrictamente por locationId
 * contra el gateway de sedes. Ya NO existen huellas de token hardcodeadas
 * (ej. '4d48784c' / cuenta central) ni una subcuenta "CENTRAL" pasiva.
 */
export function getSubaccountName(options = {}, url = '') {
  const headers = options.headers || {};
  const auth = String(headers.Authorization || headers.authorization || '');
  const urlStr = String(url);

  // 1. Resolución primaria: Location ID presente en la URL de la petición.
  for (const sede of Object.values(SEDES_GATEWAY)) {
    const locId = sede?.ghl?.locationId;
    if (locId && urlStr.includes(locId)) return sede.sedeId;
  }

  // 2. Resolución secundaria: PIT exacto de la sede en el header Authorization.
  if (auth) {
    for (const sede of Object.values(SEDES_GATEWAY)) {
      const key = sede?.ghl?.apiKey;
      if (key && auth.includes(key)) return sede.sedeId;
    }
  }

  // 3. Sin coincidencia: identificador efímero y no reversible para logs.
  return auth ? `SUBCUENTA_NO_REGISTRADA:${auth.substring(0, 12)}...` : 'GENERAL';
}

function getLimiterKey(options = {}, url = '') {
  return getSubaccountName(options, url);
}

/**
 * Indica si la subcuenta resuelta está pausada preventivamente por rate limit.
 * Fail-safe: una subcuenta desconocida nunca se considera pausada.
 */
function isSubaccountPaused(subaccount) {
  const sede = SEDES_GATEWAY?.[subaccount];
  return Boolean(sede?.isPaused);
}

/**
 * Fetch con reintentos y rate limiter AISLADO por subcuenta.
 * 
 * @param {string} url - URL del endpoint de GHL
 * @param {object} options - Opciones de fetch (method, headers, body)
 * @param {number} attempt - Intento actual (1-based, max 4)
 * @param {string} caller - Identificador del módulo que llama (para logs)
 * @returns {Response}
 */
export async function ghlFetch(url, options = {}, attempt = 1, caller = 'GHL') {
  const subaccount = getSubaccountName(options, url);

  // [BLINDAJE 429]: Si la subcuenta está pausada preventivamente, omitir peticiones externas a GHL
  if (isSubaccountPaused(subaccount)) {
    console.log(`[${caller}] [SUBACCOUNT-PAUSED] Subcuenta [${subaccount}] pausada preventivamente por rate limit 429 activo en GHL. Petición omitida.`);
    return {
      status: 429,
      ok: false,
      paused: true,
      headers: new Headers({ 'retry-after': '3600' }),
      json: async () => ({ message: `Subcuenta ${subaccount} pausada preventivamente por rate limit 429 activo en GHL.` }),
      text: async () => `Subcuenta ${subaccount} pausada preventivamente por rate limit 429 activo en GHL.`
    };
  }
  const limiterKey = subaccount;
  const now = Date.now();
  const blockedUntil = rateLimiters.get(limiterKey) || 0;

  if (now < blockedUntil) {
    const waitMs = blockedUntil - now;
    console.log(`[${caller}] [RATE-LIMIT-ACTIVE] Subcuenta [${subaccount}]: En espera de ventana (${Math.ceil(waitMs / 1000)}s restantes)...`);
    await sleep(waitMs);
  }

  const startTime = Date.now();
  try {
    if (global.apiCounters) global.apiCounters.ghl++;
    const priority = (caller === 'Radar' || caller === 'Router' || caller.includes('Webhook')) ? 'HIGH' : 'LOW';
    const res = await tokenBucketQueue.enqueue(() => fetch(url, options), priority);
    
    // Telemetría nativa (No bloqueante, alimenta telemetry.db)
    const duration = Date.now() - startTime;
    logApiTelemetry(`GHL-${caller}-${subaccount}`, options?.method || 'GET', url, res.status, duration);

    if (res.status === 429) {
      // Bloqueo inteligente con Backoff progresivo por subcuenta
      const currentConsecutive = (consecutive429Counts.get(limiterKey) || 0) + 1;
      consecutive429Counts.set(limiterKey, currentConsecutive);

      const serverRetryAfter = parseInt(res.headers.get('retry-after') || '60', 10);
      const retryAfter = Math.min(serverRetryAfter * currentConsecutive, 300);
      const blockMs = retryAfter * 1000;
      rateLimiters.set(limiterKey, Date.now() + blockMs);

      console.warn(`[${caller}] [RATE-LIMIT-429] Subcuenta [${subaccount}]: GHL retorno 429 (racha x${currentConsecutive}). Pausa de ${retryAfter}s en esta subcuenta.`);
      
      await sleep(blockMs);
      if (attempt < 4) return ghlFetch(url, options, attempt + 1, caller);
    } else if (res.ok) {
      // Éxito: reiniciamos el contador de 429
      consecutive429Counts.delete(limiterKey);
    }

    return res;
  } catch (e) {
    const duration = Date.now() - startTime;
    logApiTelemetry(`GHL-${caller}-${subaccount}`, options?.method || 'GET', url, 500, duration);
    if (attempt < 4) {
      const backoff = 2000 * attempt;
      console.warn(`[${caller}] [NETWORK-RETRY] Subcuenta [${subaccount}]: Reintentando en ${backoff}ms (intento ${attempt}/4)...`);
      await sleep(backoff);
      return ghlFetch(url, options, attempt + 1, caller);
    }
    throw e;
  }
}

/**
 * Métricas del rate limiter (para el dashboard /health)
 */
export function getRateLimiterStatus() {
  const now = Date.now();
  let maxBlocked = 0;
  for (const [, blocked] of rateLimiters.entries()) {
    if (blocked > maxBlocked) maxBlocked = blocked;
  }
  return {
    isBlocked: now < maxBlocked,
    blockedForMs: now < maxBlocked ? maxBlocked - now : 0,
    blockedUntil: maxBlocked > 0 ? new Date(maxBlocked).toISOString() : null
  };
}
