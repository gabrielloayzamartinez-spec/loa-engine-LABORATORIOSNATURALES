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
// RATE LIMITER GLOBAL ÚNICO
// ==========================================
let globalBlockedUntil = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch con reintentos y rate limiter GLOBAL compartido.
 * 
 * @param {string} url - URL del endpoint de GHL
 * @param {object} options - Opciones de fetch (method, headers, body)
 * @param {number} attempt - Intento actual (1-based, max 4)
 * @param {string} caller - Identificador del módulo que llama (para logs)
 * @returns {Response}
 */
export async function ghlFetch(url, options, attempt = 1, caller = 'GHL') {
  // Respetar el bloqueo global antes de hacer cualquier llamada
  const now = Date.now();
  if (now < globalBlockedUntil) {
    const waitMs = globalBlockedUntil - now;
    console.log(`[${caller}] ⏸️ Rate limiter global activo. Esperando ${Math.ceil(waitMs / 1000)}s...`);
    await sleep(waitMs);
  }

  try {
    if (global.apiCounters) global.apiCounters.ghl++;
    const res = await fetch(url, options);

    if (res.status === 429) {
      // Bloqueo GLOBAL: si cualquier módulo recibe 429, TODOS se pausan
      const retryAfter = parseInt(res.headers.get('retry-after') || '60', 10);
      const blockMs = retryAfter * 1000;
      globalBlockedUntil = Date.now() + blockMs;
      console.warn(`[${caller}] ⚠️ GHL retornó 429. Rate Limiter GLOBAL activado por ${retryAfter}s. Todos los módulos pausados.`);
      
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
 * Métricas del rate limiter global (para el dashboard /health)
 */
export function getRateLimiterStatus() {
  const now = Date.now();
  return {
    isBlocked: now < globalBlockedUntil,
    blockedForMs: now < globalBlockedUntil ? globalBlockedUntil - now : 0,
    blockedUntil: globalBlockedUntil > 0 ? new Date(globalBlockedUntil).toISOString() : null
  };
}
