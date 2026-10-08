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
import { readSecret } from '../config/secrets.js';
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

/**
 * [AISLAMIENTO DE PRIORIDAD — TOPE DE ESPERA DEL TRABAJO EN VIVO]
 *
 * DEFECTO REAL EN PRODUCCION: cuando GHL devolvia 429, el motor bloqueaba la
 * SUBCUENTA COMPLETA hasta 300 s. Ese castigo lo pagaba tambien el trabajo EN
 * VIVO (radar y router): los mensajes de los leads dejaban de sincronizarse
 * durante minutos por culpa de un 429 que habia provocado el BACKFILL.
 *
 * Un lead que escribe es la razon de ser del sistema; el relleno historico es
 * prescindible. Por eso la via EN VIVO nunca espera mas de este tope: reintenta
 * pronto en lugar de quedarse dormida. La via de fondo (LOW) sigue respetando el
 * bloqueo completo para no empeorar el 429.
 */
const MAX_ESPERA_VIVO_MS = Math.min(Math.max(parseInt(process.env.GHL_MAX_ESPERA_VIVO_MS || '2000', 10) || 2000, 500), 10000);

/**
 * [OBSERVABILIDAD DE CONSUMO — POR SERVICIO]
 *
 * La auditoria de rate limit demostro que era IMPOSIBLE saber quien consumia la
 * cuota de GHL: solo existia un total por subcuenta. Sin esa visibilidad se
 * aceleraron ritmos a ciegas y aparecieron los 429.
 *
 * Ahora cada llamada registra su `caller` y /api/health expone el ranking de
 * consumo: se ve DE UN VISTAZO quien gasta la cuota antes de tocarla.
 */
const consumoPorServicio = new Map();

/** Ranking de llamadas a GHL por servicio (mayor consumo primero). */
export function getConsumoPorServicio() {
  const total = [...consumoPorServicio.values()].reduce((a, b) => a + b, 0);
  return {
    total,
    porServicio: Object.fromEntries([...consumoPorServicio.entries()].sort((a, b) => b[1] - a[1]))
  };
}

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

  // 0. CUENTA EMPRESA: su location NO vive en SEDES_GATEWAY (el gateway es de
  // sedes operativas), asi que antes caia en el caso "sin coincidencia" y cada
  // peticion generaba una clave EFIMERA distinta. Efecto: el rate limiter y el
  // contador de 429 de la Empresa nunca se acumulaban, de modo que un 429 de esa
  // cuenta no activaba su pausa preventiva. Se resuelve explicitamente AQUI.
  const centralLoc = readSecret('GHL_LOCATION_ID_CENTRAL');
  if (centralLoc && urlStr.includes(centralLoc)) return 'EMPRESA';

  // 1. Resolución primaria: Location ID presente en la URL de la petición.
  for (const sede of Object.values(SEDES_GATEWAY)) {
    const locId = sede?.ghl?.locationId;
    if (locId && urlStr.includes(locId)) return sede.sedeId;
  }

  // 2. Resolución secundaria: PIT exacto de la sede en el header Authorization.
  if (auth) {
    const centralKey = readSecret('GHL_API_KEY_CENTRAL');
    if (centralKey && auth.includes(centralKey)) return 'EMPRESA';

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

  // [PRIORIDAD — SE CALCULA ANTES DE CUALQUIER BLOQUEO]
  // El trabajo EN VIVO (radar, router, webhooks) es la razon de ser del sistema:
  // un lead que escribe no puede quedarse sin sincronizar porque el BACKFILL
  // agoto la cuota y GHL devolvio 429. Por eso la prioridad se resuelve ARRIBA y
  // gobierna tanto la espera previa como el backoff del 429.
  const priority = (caller === 'Radar' || caller === 'Router' || caller.includes('Webhook')) ? 'HIGH' : 'LOW';
  const esVivo = priority === 'HIGH';

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
    // [AISLAMIENTO DE PRIORIDAD] El trabajo de fondo (LOW) respeta el bloqueo
    // completo. El trabajo EN VIVO solo espera un tope corto: nunca se queda
    // minutos sin atender un mensaje por culpa de un 429 del backfill.
    const espera = esVivo ? Math.min(waitMs, MAX_ESPERA_VIVO_MS) : waitMs;
    console.log(`[${caller}] [RATE-LIMIT-ACTIVE] Subcuenta [${subaccount}]: en espera de ventana (${Math.ceil(waitMs / 1000)}s restantes)${esVivo ? ` — prioridad EN VIVO, espera acotada a ${espera}ms` : ''}.`);
    if (espera > 0) await sleep(espera);
  }

  const startTime = Date.now();
  try {
    if (global.apiCounters) global.apiCounters.ghl++;
    // [OBSERVABILIDAD] Se registra el consumo por servicio para /api/health.
    consumoPorServicio.set(caller, (consumoPorServicio.get(caller) || 0) + 1);
    // [AISLAMIENTO POR SUBCUENTA] Se pasa la subcuenta para que cada location use
    // su PROPIO cubo. Antes todas las sedes compartian una sola cola global y se
    // serializaban entre si, usando menos del 10% del limite de GHL. La cuota de
    // GHL es "per app per resource": cada location tiene su presupuesto aparte.
    //
    // [TIMEOUT DURO — CAUSA RAIZ DE LOS ESTANCAMIENTOS]
    // Este `fetch` NO tenia timeout: una llamada que nunca respondia colgaba el
    // ciclo completo del scheduler, el `.finally()` que libera la guarda no se
    // ejecutaba y el trabajo MORIA EN SILENCIO (caso real: el backfill de
    // compradores estuvo ~30 h detenido, y los schedulers de ordenes y de ventas
    // tenian el mismo defecto).
    //
    // Con AbortController NINGUNA llamada puede pasar del tope: se aborta, el
    // `catch` la trata como error transitorio y reintenta, y el ciclo SIEMPRE
    // termina. Es la proteccion en el origen, no solo el rescate posterior.
    //
    // Tope configurable con GHL_HTTP_TIMEOUT_MS (default 30 s; GHL normal responde
    // en menos de 1 s, asi que 30 s ya es holgado).
    const GHL_HTTP_TIMEOUT_MS = Math.min(Math.max(parseInt(process.env.GHL_HTTP_TIMEOUT_MS || '30000', 10) || 30000, 5000), 120000);
    const res = await tokenBucketQueue.enqueue(() => {
      const controlador = new AbortController();
      const temporizador = setTimeout(() => {
        controlador.abort(new Error(`GHL_HTTP_TIMEOUT_${GHL_HTTP_TIMEOUT_MS}ms`));
      }, GHL_HTTP_TIMEOUT_MS);
      return fetch(url, { ...options, signal: controlador.signal })
        .finally(() => clearTimeout(temporizador));
    }, priority, subaccount);
    
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

      // [AISLAMIENTO DE PRIORIDAD] El bloqueo queda registrado para TODOS (asi el
      // fondo frena de verdad), pero la via EN VIVO no duerme el backoff completo:
      // espera un tope corto y reintenta. Un lead que escribe no puede quedar
      // minutos sin sincronizar por un 429 que provoco el backfill.
      const espera429 = esVivo ? Math.min(blockMs, MAX_ESPERA_VIVO_MS) : blockMs;
      if (espera429 > 0) await sleep(espera429);
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
