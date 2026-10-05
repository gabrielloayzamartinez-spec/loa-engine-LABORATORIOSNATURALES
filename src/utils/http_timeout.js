/**
 * TIMEOUT DURO PARA LLAMADAS HTTP EXTERNAS.
 *
 * POR QUE EXISTE
 * --------------
 * El cliente de GHL (ghl_http_client.js) no tenia timeout y una respuesta que
 * nunca llegaba colgo el backfill de compradores ~30 HORAS: el ciclo no cerro, la
 * guarda del scheduler quedo trabada y el trabajo murio en silencio.
 *
 * Al auditar todo el sistema aparecieron 26 llamadas mas a `fetch()` sin tope
 * (Meta, atribucion, agentes), todas en el camino critico. Este helper centraliza
 * la proteccion para que NINGUNA llamada externa pueda colgarse.
 *
 * USO
 * ---
 *   import { fetchConTimeout } from '../utils/http_timeout.js';
 *   const res = await fetchConTimeout(url, options);          // tope por defecto
 *   const res = await fetchConTimeout(url, options, 15000);   // tope explicito
 *
 * Es compatible con `fetch`: devuelve la misma `Response`. Si se agota el tiempo,
 * lanza un error con `code = 'HTTP_TIMEOUT'` y `timeoutMs`, que el `catch` del
 * llamador puede tratar como error transitorio (reintentar) o definitivo.
 *
 * CONFIGURACION
 * -------------
 *   HTTP_TIMEOUT_DEFAULT_MS  (default 30000)
 *   HTTP_TIMEOUT_META_MS     (default 20000)  -- Meta suele responder rapido
 *   HTTP_TIMEOUT_GHL_MS      (default 30000)  -- usado por ghl_http_client.js
 */

const leerEntero = (valor, porDefecto, minimo, maximo) => {
  const n = parseInt(valor, 10);
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(Math.max(n, minimo), maximo);
};

/** Tope por defecto para cualquier llamada externa (ms). */
export const HTTP_TIMEOUT_DEFAULT_MS = leerEntero(process.env.HTTP_TIMEOUT_DEFAULT_MS, 30000, 3000, 180000);

/** Error tipado para que el llamador pueda distinguir un timeout de otro fallo. */
export class HttpTimeoutError extends Error {
  constructor(url, timeoutMs) {
    super(`HTTP_TIMEOUT: sin respuesta en ${timeoutMs}ms (${String(url).slice(0, 120)})`);
    this.name = 'HttpTimeoutError';
    this.code = 'HTTP_TIMEOUT';
    this.timeoutMs = timeoutMs;
    this.url = url;
  }
}

/**
 * `fetch` con tope duro de tiempo.
 *
 * @param {string} url
 * @param {object} [options] - opciones de fetch (method, headers, body...)
 * @param {number} [timeoutMs] - tope en ms (por defecto HTTP_TIMEOUT_DEFAULT_MS)
 * @returns {Promise<Response>}
 */
export async function fetchConTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_DEFAULT_MS) {
  const tope = leerEntero(timeoutMs, HTTP_TIMEOUT_DEFAULT_MS, 1000, 600000);
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), tope);

  // Si el llamador ya trae su propia señal, se respeta abortando tambien la nuestra.
  const senalExterna = options?.signal;
  if (senalExterna) {
    if (senalExterna.aborted) controlador.abort();
    else senalExterna.addEventListener('abort', () => controlador.abort(), { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controlador.signal });
  } catch (err) {
    // `AbortController.abort()` produce un AbortError sin contexto: se convierte en
    // un error tipado para que el llamador sepa que fue un TOPE y no un fallo de red.
    if (err?.name === 'AbortError' || controlador.signal.aborted) {
      throw new HttpTimeoutError(url, tope);
    }
    throw err;
  } finally {
    clearTimeout(temporizador);
  }
}

export default fetchConTimeout;
