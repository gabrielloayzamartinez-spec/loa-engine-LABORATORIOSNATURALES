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
export async function syncUnifiedPipelineOpportunity(contactId, contactName, isWon, createIfMissing = true, monetaryValue = 0) {
  const cache = loadPipelineCache();
  if (!cache || !cache.unified) {
    console.error("⚠️ Pipeline unificado no encontrado en caché. Ejecuta pipeline_manager.js primero.");
    return;
  }

  const unifiedPipelineId = cache.unified.pipelineId;
  const stageGanadoId = cache.unified.stageGanadoId;
  const stageProspectoId = cache.unified.stageProspectoInicialId;
  const stageCapturadoId = cache.unified.stageContactoCapturadoId;
  const stageSeguimientoId = cache.unified.stageSeguimientoId;
  const stagePerdidoId = cache.unified.stagePerdidoId;

  // Orden jerárquico de etapas (de menor a mayor avance)
  // Solo se puede AVANZAR, nunca retroceder.
  const STAGE_ORDER = [
    stageProspectoId,     // 0 - Prospecto Inicial
    stageCapturadoId,     // 1 - Contacto Capturado
    stageSeguimientoId,   // 2 - Seguimiento
    stageGanadoId,        // 3 - Ganado
    stagePerdidoId        // 4 - Perdido (estado terminal)
  ];

  function getStageRank(stageId) {
    const idx = STAGE_ORDER.indexOf(stageId);
    return idx >= 0 ? idx : -1;
  }

  // 1. Buscar si ya existe una oportunidad
  const opps = await findContactOpportunities(contactId);
  const existingOpp = opps.find(o => o.pipelineId === unifiedPipelineId);

  await tokenBucketQueue.enqueue(async () => {
    if (existingOpp) {
      const currentRank = getStageRank(existingOpp.pipelineStageId);

      // ── CASO A: El contacto es GANADO según vTiger ──
      if (isWon) {
        // Siempre mover a Ganado (rank 3), sin importar dónde esté
        if (existingOpp.pipelineStageId !== stageGanadoId || existingOpp.status !== 'won' || existingOpp.monetaryValue !== Number(monetaryValue)) {
          console.log(`[Pipeline] 🏆 Moviendo Oportunidad de ${contactId} a GANADO (Valor: $${monetaryValue})`);
          await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${existingOpp.id}`, {
            method: 'PUT',
            headers: HEADERS,
            body: JSON.stringify({
              pipelineId: unifiedPipelineId,
              locationId: locationId,
              name: contactName || "Oportunidad Comercial",
              pipelineStageId: stageGanadoId,
              status: 'won',
              contactId: contactId,
              monetaryValue: Number(monetaryValue) || 0
            })
          });
        }
        return;
      }

      // ── CASO B: El contacto NO es ganado ──
      // REGLA CARDINAL: NUNCA retroceder la tarjeta.
      // Si el asesor la movió manualmente a "Contacto Capturado" o "Seguimiento", 
      // el motor NO la devuelve a "Prospecto Inicial".
      if (currentRank >= 1) {
        // Ya está en Capturado, Seguimiento, Ganado o Perdido → NO TOCAR
        console.log(`[Pipeline] ⏸️ Oportunidad de ${contactId} ya está en etapa ${currentRank} (rank >= 1). No se retrocede.`);
        // Solo actualizar valor monetario si cambió
        if (existingOpp.monetaryValue !== Number(monetaryValue) && Number(monetaryValue) > 0) {
          await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${existingOpp.id}`, {
            method: 'PUT',
            headers: HEADERS,
            body: JSON.stringify({
              pipelineId: unifiedPipelineId,
              locationId: locationId,
              name: contactName || existingOpp.name,
              pipelineStageId: existingOpp.pipelineStageId,
              status: existingOpp.status,
              contactId: contactId,
              monetaryValue: Number(monetaryValue) || 0
            })
          });
        }
        return;
      }

      // Si está en Prospecto Inicial (rank 0), dejarlo ahí (ya está donde debe)
      // No hacer nada adicional.

    } else if (createIfMissing) {
      // 3. Crear nueva oportunidad si no existe
      const targetStageId = isWon ? stageGanadoId : stageProspectoId;
      const targetStatus = isWon ? 'won' : 'open';
      console.log(`[Pipeline] ✨ Creando nueva Oportunidad para ${contactId} en Etapa ${isWon ? 'GANADO' : 'INICIAL'}`);
      await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          pipelineId: unifiedPipelineId,
          locationId: locationId,
          name: contactName || "Oportunidad Comercial",
          pipelineStageId: targetStageId,
          status: targetStatus,
          contactId: contactId,
          monetaryValue: Number(monetaryValue) || 0
        })
      });
    }
  }, 'NORMAL');
}
