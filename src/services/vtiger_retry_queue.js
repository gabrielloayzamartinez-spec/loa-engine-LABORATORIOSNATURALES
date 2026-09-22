import fs from 'fs';
import path from 'path';
import { checkVTigerHealth } from './vtiger_api_service.js';
import { processMasterContact } from '../agents/master_processor.js';

const QUEUE_FILE = path.join(process.cwd(), 'vtiger_retry_queue.json');

function getQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    console.error('[vTiger Retry Queue] Error leyendo cola:', e.message);
  }
  return [];
}

function saveQueue(queue) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (e) {
    console.error('[vTiger Retry Queue] Error guardando cola:', e.message);
  }
}

export function enqueueVtigerRetry(contactId) {
  if (!contactId) return;
  const queue = getQueue();
  if (!queue.includes(contactId)) {
    queue.push(contactId);
    saveQueue(queue);
    console.log(`[vTiger Retry Queue] [QUEUED] Contacto ${contactId} encolado para reintento.`);
  }
}

let isProcessingQueue = false;

export async function processVtigerRetryQueue() {
  if (isProcessingQueue) return;
  
  const queue = getQueue();
  if (queue.length === 0) return;

  // Solo procesamos si vTiger está vivo
  const health = await checkVTigerHealth();
  if (health.status !== 'OK') {
    console.log(`[vTiger Retry Queue] [UNREACHABLE] vTiger inaccesible. Ignorando ${queue.length} contactos en cola por ahora.`);
    return;
  }

  isProcessingQueue = true;
  console.log(`[vTiger Retry Queue] [PROCESSING] Procesando ${queue.length} contactos encolados...`);
  
  const successful = [];
  
  for (const contactId of queue) {
    try {
      // Re-procesamos el contacto maestro para que intente vTiger de nuevo
      const result = await processMasterContact(contactId, { silent: true, isRetry: true });
      if (result.success) {
        successful.push(contactId);
        console.log(`[vTiger Retry Queue] [SUCCESS] Contacto ${contactId} procesado con exito en el reintento.`);
      }
    } catch (err) {
      console.error(`[vTiger Retry Queue] [ERROR] Error reintentando ${contactId}:`, err.message);
    }
    // Breve pausa para no saturar APIs
    await new Promise(r => setTimeout(r, 2000));
  }

  const remaining = queue.filter(id => !successful.includes(id));
  saveQueue(remaining);
  
  if (successful.length > 0) {
    console.log(`[vTiger Retry Queue] [RESOLVED] Se resolvieron ${successful.length} contactos. Quedan ${remaining.length} en cola.`);
  }

  isProcessingQueue = false;
}

export function getVtigerQueueCount() {
  return getQueue().length;
}
