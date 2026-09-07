import { logApiTelemetry } from './telemetry.js';

export async function fetchWithRetry(url, options, attempt = 1) {
  const startTime = Date.now();
  try {
    const res = await fetch(url, options);
    
    const duration = Date.now() - startTime;
    logApiTelemetry('NodeJS', options?.method || 'GET', url, res.status, duration);

    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 2000 * attempt;
      console.log(`[Rate Limit] 429 Detectado. Esperando ${waitTime}ms (Intento ${attempt})...`);
      await new Promise(r => setTimeout(r, waitTime));
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (err) {
    if (err.name === 'FetchError' || err.code === 'ECONNRESET') {
      console.log(`[Red] Error de conexión detectado. Reintentando en 2s (Intento ${attempt})...`);
      await new Promise(r => setTimeout(r, 2000));
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    
    // Si falla definitivamente o hay otro error, logear como 500
    const duration = Date.now() - startTime;
    logApiTelemetry('NodeJS', options?.method || 'GET', url, 500, duration);
    throw err;
  }
}
