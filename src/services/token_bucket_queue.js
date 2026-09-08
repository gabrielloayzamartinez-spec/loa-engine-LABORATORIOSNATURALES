/**
 * 🛡️ Token Bucket Queue & Adaptive Rate Limiter (Laboratorios Naturales)
 * 
 * Regula las llamadas hacia la API de GoHighLevel para evitar errores HTTP 429:
 * - Capacidad máxima: 50 tokens por minuto.
 * - Tasa de reposición: 1 token cada 1200ms (~50 req/minuto).
 * - Prioridad ALTA: Webhooks entrantes en vivo y búsquedas directas de asesores (delay mínimo 500ms).
 * - Prioridad BAJA: Demonio de curación histórica de fondo (1 llamada cada 1200ms).
 */

class TokenBucketQueue {
  constructor({ maxTokens = 50, refillIntervalMs = 1200 } = {}) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillIntervalMs = refillIntervalMs;
    
    this.highPriorityQueue = [];
    this.lowPriorityQueue = [];
    this.isProcessing = false;

    this.stats = {
      highPriorityProcessed: 0,
      lowPriorityProcessed: 0,
      totalWaitMs: 0
    };

    // Reposición continua de tokens
    setInterval(() => {
      if (this.tokens < this.maxTokens) {
        this.tokens++;
      }
      this.processQueue();
    }, this.refillIntervalMs);
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Encola una tarea asíncrona con prioridad
   */
  enqueue(taskFn, priority = 'LOW') {
    return new Promise((resolve, reject) => {
      const item = { taskFn, resolve, reject, enqueuedAt: Date.now() };
      if (priority === 'HIGH') {
        this.highPriorityQueue.push(item);
      } else {
        this.lowPriorityQueue.push(item);
      }
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.highPriorityQueue.length > 0 || (this.lowPriorityQueue.length > 0 && this.tokens > 0)) {
        // Prioridad 1: Vía Rápida (High Priority)
        if (this.highPriorityQueue.length > 0) {
          const item = this.highPriorityQueue.shift();
          this.stats.highPriorityProcessed++;
          try {
            const res = await item.taskFn();
            item.resolve(res);
          } catch (err) {
            item.reject(err);
          }
          await this.sleep(500); // 500ms de cortesía para tráfico en vivo
          continue;
        }

        // Prioridad 2: Vía de Fondo (Low Priority)
        if (this.lowPriorityQueue.length > 0 && this.tokens > 0) {
          this.tokens--;
          const item = this.lowPriorityQueue.shift();
          this.stats.lowPriorityProcessed++;
          try {
            const res = await item.taskFn();
            item.resolve(res);
          } catch (err) {
            item.reject(err);
          }
          await this.sleep(this.refillIntervalMs); // Espacio estricto de 1.2s
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  getMetrics() {
    return {
      availableTokens: this.tokens,
      maxCapacity: this.maxTokens,
      highQueueLength: this.highPriorityQueue.length,
      lowQueueLength: this.lowPriorityQueue.length,
      stats: this.stats
    };
  }
}

export const tokenBucketQueue = new TokenBucketQueue();
