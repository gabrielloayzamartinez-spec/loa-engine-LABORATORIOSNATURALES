import fs from 'fs';
import path from 'path';
import { checkVTigerHealth } from './vtiger_api_service.js';
import { processMasterContact } from '../agents/master_processor.js';
import { getStateStore } from './state/state_store.js';
import { recordAuditEvent } from './audit_logger.js';
import { envInt } from '../config/secrets.js';

// ==============================================================================
// COLA DE REINTENTOS vTiger CON BACKOFF EXPONENCIAL E IDEMPOTENCIA
// ==============================================================================
// ANTES: array plano de contactId en un JSON con reintento cada 2 s en tiempo
// real, sin backoff ni control de intentos → condición de carrera (dos ciclos
// podían tomar el mismo contacto) y riesgo de bucle infinito contra vTiger.
//
// AHORA:
//  - Cada entrada lleva `attempts`, `nextRetryAt` y `dedupeKey` (idempotencia).
//  - Backoff exponencial con jitter: 2^intentos * base, acotado por un máximo.
//  - Sólo se procesan las entradas cuyo `nextRetryAt` ya venció (no bloquea el ciclo).
//  - Estado en el `StateStore` (stateless): sobrevive a un redeploy de Render.
//  - DLQ: al agotar los intentos, el contacto se archiva y se audita.
// ==============================================================================

const QUEUE_FILE = path.join(process.cwd(), 'vtiger_retry_queue.json');
const STORE_NAMESPACE = 'vtiger_retry_queue';
const STORE_KEY = 'cola_v1';

const MAX_ATTEMPTS = envInt('VTIGER_RETRY_MAX_ATTEMPTS', 5);
const BASE_DELAY_MS = envInt('VTIGER_RETRY_BASE_MS', 2000);
const MAX_DELAY_MS = envInt('VTIGER_RETRY_MAX_MS', 30 * 60 * 1000); // tope: 30 min

const store = getStateStore(STORE_NAMESPACE);

/** @type {Map<string, {contactId:string, attempts:number, nextRetryAt:number, firstQueuedAt:string, lastError:string|null}>} */
let queue = new Map();
let hydrated = false;

/** Backoff exponencial con jitter (evita que 2 sedes reintenten sincronizadas). */
export function computeRetryDelay(attempts, base = BASE_DELAY_MS, max = MAX_DELAY_MS) {
  const exponential = Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), max);
  return Math.min(Math.round(exponential + Math.random() * exponential * 0.25), max);
}

/** Migración transparente desde el formato legado (array de IDs). */
function loadLegacyFile() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Hidrata la cola desde el almacén durable (llamar una vez en el arranque). */
export async function hydrateVtigerRetryQueue() {
  if (hydrated) return { size: queue.size };
  const persisted = await store.get(STORE_KEY, null);

  if (persisted && Array.isArray(persisted)) {
    for (const entry of persisted) {
      if (entry?.contactId) queue.set(entry.contactId, entry);
    }
  } else {
    // Migración: entradas legadas se reencolan con backoff completo.
    for (const contactId of loadLegacyFile()) {
      if (typeof contactId === 'string' && contactId) {
        queue.set(contactId, {
          contactId,
          attempts: 0,
          nextRetryAt: Date.now(),
          firstQueuedAt: new Date().toISOString(),
          lastError: 'migrado desde cola legada'
        });
      }
    }
    if (queue.size > 0) await persist();
  }

  hydrated = true;
  if (queue.size > 0) {
    console.log(`[vTiger Retry Queue] [HYDRATE] ${queue.size} contactos en cola restaurados desde el almacén durable.`);
  }
  return { size: queue.size };
}

async function persist() {
  const ok = await store.set(STORE_KEY, [...queue.values()]);
  if (!ok) {
    // Espejo local best-effort para no perder la cola si el almacén no responde.
    try {
      fs.writeFileSync(QUEUE_FILE, JSON.stringify([...queue.keys()], null, 2), 'utf-8');
    } catch { /* opcional */ }
  }
  return ok;
}

/**
 * Encola (o reprograma) un contacto para reintento.
 * IDEMPOTENTE: encolar dos veces el mismo contacto no duplica la entrada ni
 * reinicia el contador de intentos.
 */
export function enqueueVtigerRetry(contactId, error = null) {
  const id = String(contactId || '').trim();
  if (!id) return { queued: false, reason: 'contactId vacío' };

  const existing = queue.get(id);
  if (existing) {
    // Ya está en cola: sólo se actualiza el último error, sin reiniciar intentos.
    existing.lastError = error ? String(error).slice(0, 180) : existing.lastError;
    queue.set(id, existing);
    persist().catch(() => {});
    return { queued: true, deduplicated: true, attempts: existing.attempts };
  }

  const entry = {
    contactId: id,
    attempts: 0,
    nextRetryAt: Date.now(),
    firstQueuedAt: new Date().toISOString(),
    lastError: error ? String(error).slice(0, 180) : null
  };
  queue.set(id, entry);
  persist().catch(() => {});
  console.log(`[vTiger Retry Queue] [QUEUED] Contacto ${id} encolado para reintento. Total en cola: ${queue.size}.`);
  return { queued: true, deduplicated: false, attempts: 0 };
}

let isProcessingQueue = false;

/**
 * Procesa las entradas cuyo backoff ya venció.
 * Nunca lanza: cualquier fallo se audita y se reprograma.
 */
export async function processVtigerRetryQueue() {
  if (isProcessingQueue) return { skipped: true, reason: 'ya en ejecución' };
  if (queue.size === 0) return { processed: 0, queueSize: 0 };

  const now = Date.now();
  const due = [...queue.values()].filter(e => e.nextRetryAt <= now);
  if (due.length === 0) {
    const nextIn = Math.min(...[...queue.values()].map(e => e.nextRetryAt)) - now;
    return { processed: 0, queueSize: queue.size, nextRetryInMs: Math.max(0, nextIn) };
  }

  // Sólo se intenta si vTiger está vivo: no se consumen intentos contra un servicio caído.
  const health = await checkVTigerHealth();
  if (health.status !== 'OK') {
    console.warn(`[vTiger Retry Queue] [UNREACHABLE] vTiger inaccesible (${health.message}). ${queue.size} contactos en espera; no se consumen intentos.`);
    recordAuditEvent({ type: 'VTIGER_RETRY_POSTPONED', severity: 'warn', queueSize: queue.size, message: health.message });
    return { processed: 0, queueSize: queue.size, postponed: true };
  }

  isProcessingQueue = true;
  let succeeded = 0;
  let failed = 0;
  let deadLettered = 0;

  try {
    console.log(`[vTiger Retry Queue] [PROCESSING] ${due.length} contactos listos para reintento (cola total: ${queue.size}).`);

    for (const entry of due) {
      // Re-verificar en el momento de procesar (otra instancia pudo resolverlo).
      if (!queue.has(entry.contactId)) continue;

      try {
        const result = await processMasterContact(entry.contactId, { silent: true, isRetry: true });

        if (result?.success) {
          queue.delete(entry.contactId);
          succeeded++;
          console.log(`[vTiger Retry Queue] [SUCCESS] Contacto ${entry.contactId} sincronizado en el intento ${entry.attempts + 1}.`);
          recordAuditEvent({ type: 'VTIGER_RETRY_SUCCESS', severity: 'info', contactId: entry.contactId, attempts: entry.attempts + 1 });
        } else {
          throw new Error(result?.error || result?.message || 'processMasterContact sin éxito');
        }
      } catch (err) {
        failed++;
        entry.attempts++;
        entry.lastError = String(err.message || err).slice(0, 180);

        if (entry.attempts >= MAX_ATTEMPTS) {
          // Dead Letter Queue: se archiva con contexto forense y se audita.
          queue.delete(entry.contactId);
          deadLettered++;
          console.error(`[vTiger Retry Queue] [DLQ] Contacto ${entry.contactId} agotó ${MAX_ATTEMPTS} intentos. Archivado. Último error: ${entry.lastError}`);
          recordAuditEvent({
            type: 'VTIGER_RETRY_DLQ',
            severity: 'critical',
            contactId: entry.contactId,
            attempts: entry.attempts,
            firstQueuedAt: entry.firstQueuedAt,
            message: entry.lastError
          });
        } else {
          entry.nextRetryAt = Date.now() + computeRetryDelay(entry.attempts);
          queue.set(entry.contactId, entry);
          const waitS = Math.round((entry.nextRetryAt - Date.now()) / 1000);
          console.warn(`[vTiger Retry Queue] [BACKOFF] ${entry.contactId} intento ${entry.attempts}/${MAX_ATTEMPTS}. Próximo en ${waitS}s.`);
          recordAuditEvent({
            type: 'VTIGER_RETRY_SCHEDULED',
            severity: 'warn',
            contactId: entry.contactId,
            attempts: entry.attempts,
            nextRetryInMs: waitS * 1000,
            message: entry.lastError
          });
        }
      }

      // Pausa entre contactos para no saturar la API (rate-limit amistoso).
      await new Promise(r => setTimeout(r, envInt('VTIGER_RETRY_PACING_MS', 1200)));
    }
  } finally {
    await persist();
    isProcessingQueue = false;
  }

  console.log(`[vTiger Retry Queue] [CYCLE] Exitosos: ${succeeded} | Fallidos reprogramados: ${failed} | Enviados a DLQ: ${deadLettered} | En cola: ${queue.size}`);
  return { processed: due.length, succeeded, failed, deadLettered, queueSize: queue.size };
}

export function getVtigerQueueCount() {
  return queue.size;
}

/** Detalle de la cola (diagnóstico / /api/health). */
export function getVtigerQueueStatus() {
  const now = Date.now();
  const entries = [...queue.values()];
  return {
    size: entries.length,
    due: entries.filter(e => e.nextRetryAt <= now).length,
    maxAttempts: MAX_ATTEMPTS,
    oldest: entries.sort((a, b) => new Date(a.firstQueuedAt) - new Date(b.firstQueuedAt))[0]?.firstQueuedAt || null,
    entries: entries.slice(0, 20).map(e => ({
      contactId: e.contactId,
      attempts: e.attempts,
      nextRetryInMs: Math.max(0, e.nextRetryAt - now),
      lastError: e.lastError
    }))
  };
}
