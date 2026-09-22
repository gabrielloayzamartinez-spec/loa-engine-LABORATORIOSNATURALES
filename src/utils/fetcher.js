/**
 * Adaptador centralizado: Canaliza todo el tráfico legacy de fetchWithRetry
 * directamente a través de ghlFetch en ghl_http_client.js.
 * 
 * Garantiza que TODOS los módulos (30+) que usan fetchWithRetry queden
 * gobernados por el TokenBucketQueue y el Rate Limiter aislado por subcuenta.
 */
import { ghlFetch } from './ghl_http_client.js';

export async function fetchWithRetry(url, options = {}, attempt = 1, caller = 'LegacyFetcher') {
  return ghlFetch(url, options, attempt, caller);
}
