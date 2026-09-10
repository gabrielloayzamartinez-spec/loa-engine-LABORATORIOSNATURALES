import fs from 'fs';
import path from 'path';
import { GHL_CONFIG } from '../config/index.js';
import { tokenBucketQueue } from './token_bucket_queue.js';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

const PIPELINES_CACHE_FILE = path.join(process.cwd(), 'src', 'config', 'pipelines_cache.json');

let pipelineCache = null;

function loadPipelineCache() {
  if (pipelineCache) return pipelineCache;
  if (fs.existsSync(PIPELINES_CACHE_FILE)) {
    try {
      pipelineCache = JSON.parse(fs.readFileSync(PIPELINES_CACHE_FILE, 'utf8'));
      return pipelineCache;
    } catch (e) {
      console.error("Error loading pipeline cache:", e.message);
    }
  }
  return null;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      await sleep(2000 * attempt);
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < 5) {
      await sleep(2000);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw e;
  }
}

/**
 * Busca oportunidades existentes de un contacto
 */
export async function findContactOpportunities(contactId) {
  try {
    const res = await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&contact_id=${contactId}`, { headers: HEADERS });
    if (res.status === 200) {
      const data = await res.json();
      return data.opportunities || [];
    }
  } catch (e) {
    console.error(`Error buscando oportunidades para contactId ${contactId}:`, e.message);
  }
  return [];
}

/**
 * Crea o actualiza la oportunidad del contacto en el pipeline unificado.
 * Si isWon = true, lo mueve a Ganado.
 * Si isWon = false y es nuevo, lo mete a Prospecto Inicial.
 */
export async function syncUnifiedPipelineOpportunity(contactId, contactName, isWon) {
  const cache = loadPipelineCache();
  if (!cache || !cache.unified) {
    console.error("⚠️ Pipeline unificado no encontrado en caché. Ejecuta pipeline_manager.js primero.");
    return;
  }

  const unifiedPipelineId = cache.unified.pipelineId;
  const stageGanadoId = cache.unified.stageGanadoId;
  const stageProspectoId = cache.unified.stageProspectoInicialId;

  const targetStageId = isWon ? stageGanadoId : stageProspectoId;
  const targetStatus = isWon ? 'won' : 'open';

  // 1. Buscar si ya existe una oportunidad
  const opps = await findContactOpportunities(contactId);
  const existingOpp = opps.find(o => o.pipelineId === unifiedPipelineId);

  // Payload base
  const payload = {
    pipelineId: unifiedPipelineId,
    locationId: locationId,
    name: contactName || "Oportunidad Comercial",
    pipelineStageId: targetStageId,
    status: targetStatus,
    contactId: contactId
  };

  await tokenBucketQueue.enqueue(async () => {
    if (existingOpp) {
      // 2. Actualizar si ya existe, y SI la etapa o estatus es diferente
      if (existingOpp.pipelineStageId !== targetStageId || existingOpp.status !== targetStatus) {
        console.log(`[Pipeline] ♻️ Actualizando Oportunidad para ${contactId} a Etapa ${isWon ? 'GANADO' : 'INICIAL'}`);
        await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${existingOpp.id}`, {
          method: 'PUT',
          headers: HEADERS,
          body: JSON.stringify(payload)
        });
      }
    } else {
      // 3. Crear nueva oportunidad si no existe
      console.log(`[Pipeline] ✨ Creando nueva Oportunidad para ${contactId} en Etapa ${isWon ? 'GANADO' : 'INICIAL'}`);
      await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(payload)
      });
    }
  }, 'NORMAL');
}
