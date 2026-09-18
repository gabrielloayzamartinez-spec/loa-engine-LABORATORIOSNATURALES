/**
 * LOA ENGINE - GHL HTTP Client Centralizado
 * 
 * Un único rate limiter global compartido por TODOS los módulos del sistema.
 * Evita que el Radar, el Router y el Reverse Sync se pisen entre sí con
 * bloqueadores de rate-limit independientes.
 * 
 * Con 300K+ contactos en la base, es crítico no desperdiciar llamadas API.
 */

import { GHL_CONFIG } from '../config/index.js';

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
// RATE LIMITER AISLADO POR SUBCUENTA
// ==========================================
const rateLimiters = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getLimiterKey(options = {}) {
  const headers = options.headers || {};
  const auth = headers.Authorization || headers.authorization || headers['Authorization'] || 'default';
  return String(auth).substring(0, 25);
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
  const limiterKey = getLimiterKey(options);
  const now = Date.now();
  const blockedUntil = rateLimiters.get(limiterKey) || 0;

  if (now < blockedUntil) {
    const waitMs = blockedUntil - now;
    console.log(`[${caller}] ⏸️ Rate limiter activo para subcuenta. Esperando ${Math.ceil(waitMs / 1000)}s...`);
    await sleep(waitMs);
  }

  try {
    if (global.apiCounters) global.apiCounters.ghl++;
    const res = await fetch(url, options);

    if (res.status === 429) {
      // Bloqueo AISLADO: solo se pausa la subcuenta que recibió el 429
      const retryAfter = parseInt(res.headers.get('retry-after') || '60', 10);
      const blockMs = retryAfter * 1000;
      rateLimiters.set(limiterKey, Date.now() + blockMs);
      console.warn(`[${caller}] ⚠️ GHL retornó 429 para subcuenta (${limiterKey.substring(0, 10)}...). Pausa de ${retryAfter}s en esta subcuenta.`);
      
      await sleep(blockMs);
      if (attempt < 4) return ghlFetch(url, options, attempt + 1, caller);
    }

    return res;
  } catch (e) {
    if (attempt < 4) {
      const backoff = 2000 * attempt;
      console.warn(`[${caller}] ⚠️ Error de red (intento ${attempt}/4). Reintentando en ${backoff}ms...`);
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
