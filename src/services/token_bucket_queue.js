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

/** Ritmo por subcuenta. 700 ms => ~14.3 requests por ventana de 10 s (limite 100). */
const DEFAULT_INTERVAL_MS = 700;

/**
 * [GUARDIAN DE CUOTA DIARIA]
 *
 * GHL permite 200.000 requests por DIA y por location. La cola ya protegia la
 * RAFAGA (100 req / 10 s), pero NO habia ninguna guarda para el techo DIARIO: un
 * backfill agresivo podia agotar la cuota del dia y con ella la atencion en vivo
 * de los asesores (los webhooks tambien consumen esa misma cuota).
 *
 * Este guardia cuenta las peticiones de cada subcuenta en una ventana de 24 h y:
 *   - deja pasar SIEMPRE la via rapida (HIGH: webhooks, radar, router en vivo);
 *   - FRENA la via de fondo (LOW: backfill, curador) al acercarse al techo.
 *
 * Umbral por defecto: 150.000 (75% del limite), elegido para dejar ~50.000
 * peticiones de margen a la operacion en vivo. Configurable con
 * GHL_DAILY_QUOTA_GUARD.
 */
const DAILY_QUOTA_GUARD = (() => {
  const n = parseInt(process.env.GHL_DAILY_QUOTA_GUARD || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 150000;
})();
const VENTANA_DIARIA_MS = 24 * 60 * 60 * 1000;

class SubaccountBucket {
  constructor(subaccount, { intervalMs = DEFAULT_INTERVAL_MS, highPriorityDelayMs = 150 } = {}) {
    this.subaccount = subaccount;
    this.intervalMs = intervalMs;
    this.highPriorityDelayMs = highPriorityDelayMs;

    this.highPriorityQueue = [];
    this.lowPriorityQueue = [];
    this.isProcessing = false;

    // [GUARDIAN DE CUOTA] Contador de la ventana de 24 h.
    this.dailyCount = 0;
    this.dailyWindowStart = Date.now();
    this.dailyBlocked = 0; // cuantas tareas de fondo se frenaron por cuota

    this.stats = {
      highPriorityProcessed: 0,
      lowPriorityProcessed: 0,
      totalWaitMs: 0,
      lastProcessedAt: null
    };
  }

  /** Reinicia la ventana diaria si ya pasaron 24 h. */
  rotarVentanaSiCorresponde() {
    if (Date.now() - this.dailyWindowStart >= VENTANA_DIARIA_MS) {
      this.dailyCount = 0;
      this.dailyWindowStart = Date.now();
      this.dailyBlocked = 0;
    }
  }

  /**
   * ¿Queda cupo diario para trabajo DE FONDO?
   * La via rapida (HIGH) nunca se frena: la atencion en vivo tiene prioridad.
   */
  hayCupoDeFondo() {
    this.rotarVentanaSiCorresponde();
    return this.dailyCount < DAILY_QUOTA_GUARD;
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
          this.dailyCount++; // [GUARDIAN] la via rapida tambien consume cuota
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
          this.dailyCount++;
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
    this.rotarVentanaSiCorresponde();
    const pct = DAILY_QUOTA_GUARD > 0 ? Number(((this.dailyCount / DAILY_QUOTA_GUARD) * 100).toFixed(1)) : 0;
    return {
      subaccount: this.subaccount,
      intervalMs: this.intervalMs,
      requestsPerSecond: Number((1000 / this.intervalMs).toFixed(2)),
      processed: total,
      highQueueLength: this.highPriorityQueue.length,
      lowQueueLength: this.lowPriorityQueue.length,
      isProcessing: this.isProcessing,
      lastProcessedAt: this.stats.lastProcessedAt,
      // [GUARDIAN DE CUOTA DIARIA]
      cuotaDiaria: {
        consumidas: this.dailyCount,
        techo: DAILY_QUOTA_GUARD,
        limiteGhl: 200000,
        porcentaje: pct,
        quedaCupoDeFondo: this.hayCupoDeFondo(),
        ventanaIniciadaEn: new Date(this.dailyWindowStart).toISOString()
      }
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

  /**
   * [GUARDIAN DE CUOTA DIARIA] ¿Queda cupo de fondo en esta subcuenta?
   * El trabajo de fondo (backfill) lo consulta ANTES de arrancar un ciclo: si la
   * subcuenta ya consumio su techo del dia, el ciclo se OMITE en lugar de competir
   * por la cuota que necesita la atencion en vivo.
   *
   * Se comprueba EN LA FUENTE (no descartando tareas ya encoladas) para no perder
   * contactos: el cursor del backfill avanza al ultimo id del lote, asi que una
   * tarea descartada a mitad de lote se saltaria ese contacto para siempre.
   */
  hayCupoDeFondo(subaccount = 'GENERAL') {
    return this.bucketFor(subaccount).hayCupoDeFondo();
  }

  /** Consumo diario por subcuenta (para /api/health y diagnostico). */
  getCuotaDiaria() {
    const out = {};
    for (const [key, b] of this.buckets.entries()) {
      out[key] = b.getMetrics().cuotaDiaria;
    }
    return out;
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
