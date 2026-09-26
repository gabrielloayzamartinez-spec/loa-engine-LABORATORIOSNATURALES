/**
 * ==============================================================================
 * LOA ENGINE - CIRCUIT BREAKER PARA APIs EXTERNAS
 * ==============================================================================
 * Toda llamada a GHL / vTiger / Meta pasa por aquí. Un endpoint caído NO debe
 * matar el proceso principal ni consumir la cuota de reintentos completa:
 * el breaker se abre, las llamadas se rechazan en microsegundos y el job se
 * reencola o se archiva en la DLQ según la política del llamante.
 *
 * Estrategia "half-open" de Opossum: tras `resetTimeout`, se permite UNA
 * llamada de prueba. Si vuelve a fallar, el breaker se reabre y el
 * `errorFilter` decide qué errores cuentan (los 4xx de negocio no abren el
 * circuito: son fallos del dato, no de la infraestructura).
 * ==============================================================================
 */

import CircuitBreaker from 'opossum';
import { envInt } from '../config/secrets.js';

const DEFAULTS = {
  timeout: envInt('CB_TIMEOUT_MS', 15000),
  errorThresholdPercentage: envInt('CB_ERROR_THRESHOLD', 50),
  resetTimeout: envInt('CB_RESET_TIMEOUT_MS', 30000),
  volumeThreshold: envInt('CB_VOLUME_THRESHOLD', 10)
};

const breakers = new Map();

/**
 * Errores que NO deben abrir el circuito.
 * - HTTP 400/404/422: payload inválido o recurso inexistente (culpa del dato).
 * - HTTP 401/403: credenciales/configuración; ya lo detecta el sanity check.
 * Un 429 o un 5xx SÍ cuentan: son señales de saturación del proveedor.
 */
function defaultErrorFilter(err) {
  const status = err?.status || err?.statusCode || err?.response?.status;
  if (status === 429) return false; // 429 cuenta como fallo de infraestructura
  if (status >= 400 && status < 500) return true;
  // Abortos por timeout del propio breaker cuentan como fallo.
  return false;
}

/**
 * Envuelve una función asíncrona en un circuit breaker nombrado.
 *
 * @param {string} name Identificador del circuito (ej. 'ghl:PALACIOS')
 * @param {Function} fn Función a proteger
 * @param {Object} [options] Overrides de configuración
 * @returns {Function} Función protegida (misma firma que `fn`)
 */
export function withCircuitBreaker(name, fn, options = {}) {
  if (breakers.has(name)) return breakers.get(name).fire.bind(breakers.get(name));

  const breaker = new CircuitBreaker(fn, { ...DEFAULTS, ...options, errorFilter: options.errorFilter || defaultErrorFilter });

  breaker.on('open', () => console.error(`[BREAKER:${name}] [OPEN] Circuito abierto: llamadas a ${name} rechazadas temporalmente.`));
  breaker.on('halfOpen', () => console.warn(`[BREAKER:${name}] [HALF-OPEN] Probando recuperación de ${name} con una llamada de sondeo.`));
  breaker.on('close', () => console.log(`[BREAKER:${name}] [CLOSED] ${name} recuperado. Tráfico normal restablecido.`));
  breaker.on('timeout', () => console.warn(`[BREAKER:${name}] [TIMEOUT] La llamada superó ${DEFAULTS.timeout}ms.`));
  breaker.on('reject', () => console.warn(`[BREAKER:${name}] [REJECT] Llamada rechazada: circuito abierto.`));

  breakers.set(name, breaker);
  return breaker.fire.bind(breaker);
}

/**
 * Ejecuta una llamada protegida SIN lanzar excepción hacia arriba.
 * Devuelve un resultado discriminado para que el job decida reencolar o archivar.
 *
 * @returns {Promise<{ok: boolean, data?: any, error?: string, circuitOpen?: boolean}>}
 */
export async function safeCall(name, fn, options = {}) {
  const protectedFn = withCircuitBreaker(name, fn, options);
  try {
    const data = await protectedFn();
    return { ok: true, data };
  } catch (err) {
    const circuitOpen = err?.code === 'EOPENBREAKER' || /open/i.test(err?.message || '');
    return { ok: false, error: err?.message || String(err), circuitOpen };
  }
}

/**
 * Estado de todos los circuitos (para /health y /api/stats).
 */
export function getBreakersStatus() {
  const out = {};
  for (const [name, b] of breakers.entries()) {
    out[name] = {
      state: b.opened ? 'OPEN' : b.halfOpen ? 'HALF_OPEN' : 'CLOSED',
      stats: b.stats
    };
  }
  return out;
}

export function resetBreaker(name) {
  const b = breakers.get(name);
  if (!b) return false;
  b.close();
  return true;
}
