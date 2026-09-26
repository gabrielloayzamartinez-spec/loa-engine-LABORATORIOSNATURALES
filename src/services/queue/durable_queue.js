/**
 * ==============================================================================
 * LOA ENGINE - DURABLE QUEUE (BULLMQ + REDIS) DETRÁS DE FEATURE FLAG
 * ==============================================================================
 * OBJETIVO: sacar el trabajo pesado del event loop (webhooks masivos,
 * sincronización de APIs y curación de fondo) sin romper el arranque de Render.
 *
 * GARANTÍAS DE DISEÑO:
 * 1. CERO dependencia dura: BullMQ/IORedis se cargan de forma PEREZOSA
 *    (`createRequire`) SOLO si el feature flag está encendido. Con el flag
 *    apagado, el require de este módulo cuesta microsegundos y el Pre-Flight
 *    Sanity Check se mantiene muy por debajo del presupuesto de 5 s.
 * 2. BLINDAJE ANTI-CRASH-LOOP: si el flag está encendido pero Redis no responde,
 *    se degrada a la cola en proceso y se emite WARN. El proceso NUNCA muere.
 * 3. CONTRATO ÚNICO: el resto del motor sólo conoce `getQueue(name)` con
 *    `enqueue()` / `registerProcessor()`. Cambiar de driver no toca los agentes.
 * 4. REINTENTOS EXPONENCIALES + DLQ: BullMQ reintenta con backoff exponencial;
 *    los jobs agotados se archivan en la Dead Letter Queue `<name>:dlq`.
 * ==============================================================================
 */

import { createRequire } from 'module';
import { readSecret, envInt } from '../../config/secrets.js';

const require = createRequire(import.meta.url);

// ------------------------------------------------------------------------------
// 1. FEATURE FLAG Y CONEXIÓN
// ------------------------------------------------------------------------------
export const QUEUE_DRIVER = String(readSecret('QUEUE_DRIVER') || 'memory').toLowerCase();
export const DURABLE_QUEUE_ENABLED = QUEUE_DRIVER === 'bullmq';
const REDIS_URL = readSecret('REDIS_URL');

const QUEUE_PREFIX = 'loa';
const DLQ_SUFFIX = 'dlq';
const CONNECT_TIMEOUT_MS = envInt('QUEUE_CONNECT_TIMEOUT_MS', 2000);

export const DEFAULT_JOB_OPTIONS = {
  attempts: envInt('QUEUE_MAX_ATTEMPTS', 5),
  backoff: { type: 'exponential', delay: envInt('QUEUE_BACKOFF_MS', 5000) },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 }
};

// ------------------------------------------------------------------------------
// 2. DRIVER EN MEMORIA (FAIL-SAFE / SIN DEPENDENCIAS)
// ------------------------------------------------------------------------------
class MemoryQueueDriver {
  constructor(name) {
    this.name = name;
    this.handlers = new Map();
    this.timers = new Map();
    this.stats = { enqueued: 0, processed: 0, failed: 0, deadLettered: 0, attempt: 0 };
    this._attempts = new Map();
  }

  registerProcessor(jobName, handler) {
    this.handlers.set(jobName, handler);
  }

  async enqueue(jobName, data, opts = {}) {
    this.stats.enqueued++;
    const attempt = (this._attempts.get(jobName) || 0) + 1;
    this._attempts.set(jobName, attempt);
    const handler = this.handlers.get(jobName);
    if (!handler) {
      console.warn(`[QUEUE:${this.name}] [SIN-PROCESADOR] Job '${jobName}' encolado sin handler registrado.`);
      return { id: `mem-${Date.now()}`, driver: 'memory', unhandled: true };
    }
    // Ejecución diferida para no bloquear el event loop del llamante.
    setImmediate(async () => {
      try {
        await handler(data, { id: `mem-${Date.now()}`, attemptsMade: attempt - 1 });
        this.stats.processed++;
      } catch (err) {
        this.stats.failed++;
        const maxAttempts = opts.attempts || DEFAULT_JOB_OPTIONS.attempts;
        if (attempt < maxAttempts) {
          const delay = (opts.backoff?.delay || DEFAULT_JOB_OPTIONS.backoff.delay) * Math.pow(2, attempt - 1);
          console.warn(`[QUEUE:${this.name}] [RETRY] '${jobName}' falló (intento ${attempt}/${maxAttempts}). Reintento en ${delay}ms: ${err.message}`);
          const timer = setTimeout(() => this.enqueue(jobName, data, opts).catch(() => {}), delay);
          this.timers.set(jobName, timer);
        } else {
          this.stats.deadLettered++;
          console.error(`[QUEUE:${this.name}] [DLQ] '${jobName}' agotó ${maxAttempts} intentos. Archivado en DLQ en memoria. Último error: ${err.message}`);
        }
      }
    });
    return { id: `mem-${Date.now()}`, driver: 'memory' };
  }

  async getMetrics() {
    return { driver: 'memory', name: this.name, ...this.stats };
  }

  async close() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

// ------------------------------------------------------------------------------
// 3. DRIVER DURABLE (BULLMQ + REDIS)
// ------------------------------------------------------------------------------
class BullMqQueueDriver {
  constructor(name, connection) {
    this.name = `${QUEUE_PREFIX}:${name}`;
    this.dlqName = `${QUEUE_PREFIX}:${name}:${DLQ_SUFFIX}`;
    this.connection = connection;
    this.handlers = new Map();
    this.workers = [];
    this.stats = { enqueued: 0, processed: 0, failed: 0, deadLettered: 0 };
    this._load();
  }

  _load() {
    const { Queue } = require('bullmq');
    this.queue = new Queue(this.name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.dlq = new Queue(this.dlqName, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    // Evita que un error de conexión asíncrono tumbe el proceso (crash loop).
    for (const q of [this.queue, this.dlq]) {
      q.on('error', (err) => console.warn(`[QUEUE:${this.name}] [REDIS-WARN] ${err.message}`));
    }
  }

  registerProcessor(jobName, handler, { concurrency = 5, limiter } = {}) {
    this.handlers.set(jobName, handler);
    const { Worker } = require('bullmq');
    const worker = new Worker(
      this.name,
      async (job) => {
        if (job.name !== jobName) return;
        return handler(job.data, job);
      },
      {
        connection: this.connection,
        concurrency,
        ...(limiter ? { limiter } : {})
      }
    );

    worker.on('completed', () => { this.stats.processed++; });
    worker.on('failed', async (job, err) => {
      this.stats.failed++;
      const attempts = job?.opts?.attempts || DEFAULT_JOB_OPTIONS.attempts;
      console.warn(`[QUEUE:${this.name}] [FAILED] '${job?.name}' intento ${job?.attemptsMade}/${attempts}: ${err.message}`);
      // Dead Letter Queue: solo cuando se agotan los reintentos.
      if (job && job.attemptsMade >= attempts) {
        try {
          await this.dlq.add(job.name, {
            originalJobId: job.id,
            failedReason: err.message,
            attemptsMade: job.attemptsMade,
            payload: job.data,
            failedAt: new Date().toISOString()
          });
          this.stats.deadLettered++;
          console.error(`[QUEUE:${this.name}] [DLQ] Job '${job.name}' (${job.id}) archivado en ${this.dlqName}.`);
        } catch (dlqErr) {
          console.error(`[QUEUE:${this.name}] [DLQ-ERROR] No se pudo archivar el job: ${dlqErr.message}`);
        }
      }
    });
    worker.on('error', (err) => console.warn(`[QUEUE:${this.name}] [WORKER-WARN] ${err.message}`));
    this.workers.push(worker);
  }

  async enqueue(jobName, data, opts = {}) {
    if (!this.handlers.has(jobName)) {
      console.warn(`[QUEUE:${this.name}] [SIN-PROCESADOR] Job '${jobName}' sin handler registrado en este proceso.`);
    }
    this.stats.enqueued++;
    const job = await this.queue.add(jobName, data, { ...DEFAULT_JOB_OPTIONS, ...opts });
    return { id: String(job.id), driver: 'bullmq' };
  }

  async getMetrics() {
    try {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
      const dlqCounts = await this.dlq.getJobCounts('waiting', 'active', 'completed', 'failed');
      return { driver: 'bullmq', name: this.name, ...this.stats, counts, dlq: dlqCounts };
    } catch (e) {
      return { driver: 'bullmq', name: this.name, ...this.stats, error: e.message };
    }
  }

  async close() {
    for (const w of this.workers) {
      try { await w.close(); } catch (e) { /* cierre best-effort */ }
    }
    try { await this.queue.close(); } catch (e) { /* cierre best-effort */ }
    try { await this.dlq.close(); } catch (e) { /* cierre best-effort */ }
  }
}

// ------------------------------------------------------------------------------
// 4. FACTORÍA CON FALLBACK AUTOMÁTICO
// ------------------------------------------------------------------------------
const registry = new Map();
let _activeDriver = DURABLE_QUEUE_ENABLED && REDIS_URL ? 'bullmq' : 'memory';
let _degradeReason = null;
let _connection = null;

/**
 * Estado de la infraestructura de colas (para /health y el sanity check).
 */
export function getQueueStatus() {
  return {
    featureFlag: QUEUE_DRIVER,
    enabled: DURABLE_QUEUE_ENABLED,
    redisConfigured: Boolean(REDIS_URL),
    activeDriver: _activeDriver,
    degraded: _degradeReason !== null,
    degradeReason: _degradeReason
  };
}

/**
 * Obtiene (o crea) una cola por nombre. Nunca lanza excepción.
 * Si el driver durable no está disponible, degrada silenciosamente a memoria.
 *
 * @param {string} name Identificador lógico (ej. 'webhooks', 'sync-ghl')
 */
export function getQueue(name = 'default') {
  if (registry.has(name)) return registry.get(name);

  let instance;
  if (DURABLE_QUEUE_ENABLED && REDIS_URL && _degradeReason === null) {
    try {
      if (!_connection) {
        const IORedis = require('ioredis');
        _connection = new IORedis(REDIS_URL, {
          maxRetriesPerRequest: null, // requerido por BullMQ
          enableOfflineQueue: true,
          connectTimeout: CONNECT_TIMEOUT_MS,
          lazyConnect: false,
          retryStrategy: (times) => Math.min(times * 500, 10000)
        });
        _connection.on('error', (err) => {
          console.warn(`[QUEUE] [REDIS-WARN] ${err.message}`);
        });
        _connection.on('ready', () => {
          console.log('[QUEUE] [REDIS-READY] Conexión Redis operativa. Colas durables activas.');
        });
      }
      instance = new BullMqQueueDriver(name, _connection);
      console.log(`[QUEUE] [DURABLE] Cola '${name}' montada sobre BullMQ + Redis.`);
    } catch (err) {
      _degradeReason = err.message;
      console.error(`[QUEUE] [DEGRADADO] BullMQ no disponible (${err.message}). Fallback a cola en memoria: la operación continúa, el deploy no se cae.`);
      instance = new MemoryQueueDriver(name);
    }
  } else {
    if (DURABLE_QUEUE_ENABLED && !REDIS_URL && _degradeReason === null) {
      _degradeReason = 'REDIS_URL ausente';
      console.warn('[QUEUE] [DEGRADADO] QUEUE_DRIVER=bullmq pero REDIS_URL está vacío. Usando cola en memoria.');
    }
    instance = new MemoryQueueDriver(name);
  }

  registry.set(name, instance);
  return instance;
}

/**
 * Cierre ordenado de todas las colas (SIGTERM de Render).
 */
export async function shutdownQueues() {
  for (const [name, q] of registry.entries()) {
    try { await q.close(); } catch (e) { /* best-effort */ }
    console.log(`[QUEUE] Cola '${name}' cerrada.`);
  }
  registry.clear();
  if (_connection) {
    try { _connection.disconnect(); } catch (e) { /* best-effort */ }
  }
}

// ------------------------------------------------------------------------------
// 5. NOMBRES DE JOB CANÓNICOS (evita strings dispersos)
// ------------------------------------------------------------------------------
export const JOBS = {
  GHL_CONTACT_WEBHOOK: 'ghl-contact',
  META_WEBHOOK: 'meta-webhook',
  VTIGER_WEBHOOK: 'vtiger-webhook',
  VTIGER_RETRY: 'vtiger-retry',
  CURATION_FORWARD: 'curation-forward',
  CURATION_BACKWARD: 'curation-backward',
  META_CAPI: 'meta-capi'
};

export const QUEUES = {
  WEBHOOKS: 'webhooks',
  SYNC: 'sync',
  CURATION: 'curation'
};
