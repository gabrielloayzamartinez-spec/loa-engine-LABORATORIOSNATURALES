/**
 * Token Bucket Queue & Adaptive Rate Limiter — AISLADO POR SUBCUENTA
 * (Laboratorios Naturales)
 * ==============================================================================
 * LIMITE OFICIAL DE GHL (marketplace.gohighlevel.com/docs/other/rate-limits):
 *   - Burst : 100 requests por 10 segundos  -> ~10 req/s por location
 *   - Diario: 200.000 requests por dia
 *   - La cuota es "per app PER RESOURCE": instalar en mas subcuentas NO divide
 *     el presupuesto, cada location tiene el suyo de forma independiente.
 *
 * CONSECUENCIA DE DISENO: Palacios, Benavides y la Cuenta Empresa pueden trabajar
 * EN PARALELO sin estorbarse. Antes habia UNA sola cola global que serializaba las
 * tres, asi que cada sede esperaba a las otras y el ritmo efectivo era de
 * ~0.83 req/s (1 cada 1200 ms) contra los ~10 req/s permitidos: se usaba menos del
 * 10% del limite.
 *
 * AHORA: un cubo INDEPENDIENTE por subcuenta. Cada uno con su propio ritmo, su
 * propia cola de prioridad y su propio estado de "en procesamiento". Un pico de
 * trabajo en Palacios ya no retrasa a Benavides.
 *
 * SEGURIDAD: el ritmo por defecto (700 ms -> ~1.43 req/s) se mantiene
 * deliberadamente conservador: sube el rendimiento sin acercarse al limite de GHL,
 * porque un 429 degradaria la atencion en vivo de los asesores.
 * ==============================================================================
 */

/** Ritmo por subcuenta. 700 ms => ~85 requests por ventana de 10 s (limite 100). */
const DEFAULT_INTERVAL_MS = 700;

class SubaccountBucket {
  constructor(subaccount, { intervalMs = DEFAULT_INTERVAL_MS, highPriorityDelayMs = 150 } = {}) {
    this.subaccount = subaccount;
    this.intervalMs = intervalMs;
    this.highPriorityDelayMs = highPriorityDelayMs;

    this.highPriorityQueue = [];
    this.lowPriorityQueue = [];
    this.isProcessing = false;

    this.stats = {
      highPriorityProcessed: 0,
      lowPriorityProcessed: 0,
      totalWaitMs: 0,
      lastProcessedAt: null
    };
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  enqueue(taskFn, priority = 'LOW') {
    return new Promise((resolve, reject) => {
      const item = { taskFn, resolve, reject, enqueuedAt: Date.now() };
      if (priority === 'HIGH') this.highPriorityQueue.push(item);
      else this.lowPriorityQueue.push(item);
      // Sin await deliberado: el procesamiento arranca en microtask y el
      // llamante espera su propia promesa. Cada subcuenta procesa la suya.
      this.processQueue();
    });
  }

  async processQueue() {
    // Guarda de reentrada POR SUBCUENTA: solo una tarea a la vez dentro del mismo
    // cubo, pero cubos distintos procesan a la vez.
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.highPriorityQueue.length > 0 || this.lowPriorityQueue.length > 0) {
        // Prioridad 1: vía rápida (webhooks en vivo, busquedas de asesores)
        if (this.highPriorityQueue.length > 0) {
          const item = this.highPriorityQueue.shift();
          this.stats.highPriorityProcessed++;
          this.stats.totalWaitMs += Date.now() - item.enqueuedAt;
          try {
            item.resolve(await item.taskFn());
          } catch (err) {
            item.reject(err);
          }
          this.stats.lastProcessedAt = new Date().toISOString();
          await this.sleep(this.highPriorityDelayMs);
          continue;
        }

        // Prioridad 2: vía de fondo (backfill, curador, puente de ventas)
        if (this.lowPriorityQueue.length > 0) {
          const item = this.lowPriorityQueue.shift();
          this.stats.lowPriorityProcessed++;
          this.stats.totalWaitMs += Date.now() - item.enqueuedAt;
          try {
            item.resolve(await item.taskFn());
          } catch (err) {
            item.reject(err);
          }
          this.stats.lastProcessedAt = new Date().toISOString();
          await this.sleep(this.intervalMs);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  getMetrics() {
    const total = this.stats.highPriorityProcessed + this.stats.lowPriorityProcessed;
    return {
      subaccount: this.subaccount,
      intervalMs: this.intervalMs,
      requestsPerSecond: Number((1000 / this.intervalMs).toFixed(2)),
      processed: total,
      highQueueLength: this.highPriorityQueue.length,
      lowQueueLength: this.lowPriorityQueue.length,
      isProcessing: this.isProcessing,
      lastProcessedAt: this.stats.lastProcessedAt
    };
  }
}

class TokenBucketQueuePool {
  constructor({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    this.intervalMs = intervalMs;
    this.buckets = new Map(); // subaccount -> SubaccountBucket
  }

  /** Obtiene (o crea) el cubo de una subcuenta. */
  bucketFor(subaccount = 'GENERAL') {
    const key = String(subaccount || 'GENERAL');
    if (!this.buckets.has(key)) {
      this.buckets.set(key, new SubaccountBucket(key, { intervalMs: this.intervalMs }));
    }
    return this.buckets.get(key);
  }

  /**
   * Encola una tarea.
   *
   * @param {Function} taskFn
   * @param {string} [priority] 'HIGH' | 'LOW'
   * @param {string} [subaccount] clave de aislamiento (PALACIOS, BENAVIDES, EMPRESA).
   *        Si se omite, la tarea cae en el cubo compartido 'GENERAL' (compatible
   *        con los llamantes que aun no la pasan).
   */
  enqueue(taskFn, priority = 'LOW', subaccount = 'GENERAL') {
    return this.bucketFor(subaccount).enqueue(taskFn, priority);
  }

  /** Metricas agregadas + desglose por subcuenta. */
  getMetrics() {
    const porSubcuenta = {};
    let high = 0, low = 0, highProc = 0, lowProc = 0;

    for (const [key, b] of this.buckets.entries()) {
      const m = b.getMetrics();
      porSubcuenta[key] = m;
      high += m.highQueueLength;
      low += m.lowQueueLength;
      highProc += b.stats.highPriorityProcessed;
      lowProc += b.stats.lowPriorityProcessed;
    }

    return {
      // Forma compatible con el consumidor anterior (/api/health, /api/stats):
      // mismas claves, ahora agregadas sobre TODAS las subcuentas.
      availableTokens: this.buckets.size,
      maxCapacity: this.buckets.size,
      highQueueLength: high,
      lowQueueLength: low,
      stats: { highPriorityProcessed: highProc, lowPriorityProcessed: lowProc },
      // Nuevo: aislamiento efectivo por subcuenta.
      isolatesPorSubcuenta: true,
      intervalMsPorSubcuenta: this.intervalMs,
      subcuentas: Object.keys(porSubcuenta),
      porSubcuenta
    };
  }
}

export const tokenBucketQueue = new TokenBucketQueuePool();

// Compatibilidad: permite inyectar el intervalo desde el entorno sin tocar codigo.
const envInterval = parseInt(process.env.GHL_QUEUE_INTERVAL_MS || '', 10);
if (Number.isFinite(envInterval) && envInterval >= 150) {
  tokenBucketQueue.intervalMs = envInterval;
}
