/**
 * QueueWorker - Sistema de Colas en memoria
 * Previene el bloqueo por Rate Limit (Exceso de Peticiones) al encolar trabajos 
 * y ejecutarlos secuencialmente con un intervalo seguro.
 */
class QueueWorker {
  constructor(concurrency = 10, waitTimeMs = 0) {
    this.queue = [];
    this.activeCount = 0;
    this.concurrency = concurrency;
    this.waitTimeMs = waitTimeMs;
  }

  enqueue(name, task) {
    this.queue.push({ name, task });
    console.log(`[Queue] 📥 Tarea encolada: ${name}. En espera: ${this.queue.length}`);
    this.processNext();
  }

  async processNext() {
    if (this.activeCount >= this.concurrency || this.queue.length === 0) {
      return; // Capacidad máxima alcanzada o cola vacía
    }

    this.activeCount++;
    const { name, task } = this.queue.shift();
    console.log(`[Queue] 🚀 Procesando en paralelo: ${name}... (Activos: ${this.activeCount})`);
    
    try {
      await task();
      console.log(`[Queue] ✅ Finalizado: ${name}`);
    } catch (err) {
      console.error(`[Queue] ❌ Error en tarea ${name}:`, err.message);
    } finally {
      this.activeCount--;
      
      if (this.waitTimeMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.waitTimeMs));
      }
      
      // Intentar procesar la siguiente tarea en la cola
      this.processNext();
    }
  }
}

// Cola Ultra Rápida: Permite procesar hasta 15 contactos simultáneamente sin bloqueos
export const webhookQueue = new QueueWorker(15, 0);
