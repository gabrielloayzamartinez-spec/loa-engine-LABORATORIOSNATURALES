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
export async function syncUnifiedPipelineOpportunity(contactId, contactName, isWon, createIfMissing = true, monetaryValue = 0, assignedTo = null) {
  const cache = loadPipelineCache();
  if (!cache || !cache.unified) {
    console.error("[WARN] Pipeline unificado no encontrado en caché. Ejecuta pipeline_manager.js primero.");
    return;
  }

  const unifiedPipelineId = cache.unified.pipelineId || 'TetMBFc4R1p4cpNhRr2L';
  const stages = cache.unified.stages || [];
  const stageProspectoId = stages[0]?.id || cache.unified.stageProspectoInicialId || '6c38e349-79d6-4ee4-be81-e16112f3c279';
  const stageCapturadoId = stages[1]?.id || cache.unified.stageContactoCapturadoId || '0da5ba47-8747-4edd-a271-2f927ccc3937';
  const stageSeguimientoId = stages[2]?.id || cache.unified.stageSeguimientoId || '5ce95579-c5b3-4b36-a963-9936ee5ae996';
  const stageGanadoId = stages[3]?.id || cache.unified.stageGanadoId || '3174c6f7-397e-42de-9ee7-780053c3920a';
  const stagePerdidoId = stages[4]?.id || cache.unified.stagePerdidoId || 'c35c57b1-a17c-432d-aa17-e1da89beb012';

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
          console.log(`[Pipeline] [WON] Moviendo Oportunidad de ${contactId} a GANADO (Valor: $${monetaryValue})`);
          const putWonPayload = {
            pipelineId: unifiedPipelineId,
            locationId: locationId,
            name: contactName || "Oportunidad Comercial",
            pipelineStageId: stageGanadoId,
            status: 'won',
            contactId: contactId,
            monetaryValue: Number(monetaryValue) || 0
          };
          if (assignedTo) putWonPayload.assignedTo = assignedTo;

          await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${existingOpp.id}`, {
            method: 'PUT',
            headers: HEADERS,
            body: JSON.stringify(putWonPayload)
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
        console.log(`[Pipeline] [LOCKED] Oportunidad de ${contactId} ya está en etapa ${currentRank} (rank >= 1). No se retrocede.`);
        // Solo actualizar valor monetario o asignación si faltaba
        const needsMonetaryUpdate = existingOpp.monetaryValue !== Number(monetaryValue) && Number(monetaryValue) > 0;
        const needsAdvisorAssign = !existingOpp.assignedTo && assignedTo;
        if (needsMonetaryUpdate || needsAdvisorAssign) {
          const putRankPayload = {
            pipelineId: unifiedPipelineId,
            locationId: locationId,
            name: contactName || existingOpp.name,
            pipelineStageId: existingOpp.pipelineStageId,
            status: existingOpp.status,
            contactId: contactId,
            monetaryValue: Number(monetaryValue) || 0
          };
          if (assignedTo) putRankPayload.assignedTo = assignedTo;

          await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${existingOpp.id}`, {
            method: 'PUT',
            headers: HEADERS,
            body: JSON.stringify(putRankPayload)
          });
        }
        return;
      }

      // Si está en Prospecto Inicial (rank 0), actualizar nombre enriquecido y asignación
      if (currentRank === 0 && (existingOpp.name !== contactName || (!existingOpp.assignedTo && assignedTo))) {
        const updateRank0Payload = {
          pipelineId: unifiedPipelineId,
          locationId: locationId,
          name: contactName || existingOpp.name,
          pipelineStageId: existingOpp.pipelineStageId,
          status: existingOpp.status,
          contactId: contactId,
          monetaryValue: Number(monetaryValue) || 0
        };
        if (assignedTo) updateRank0Payload.assignedTo = assignedTo;

        await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${existingOpp.id}`, {
          method: 'PUT',
          headers: HEADERS,
          body: JSON.stringify(updateRank0Payload)
        });
      }

    } else if (createIfMissing) {
      // 3. Crear nueva oportunidad si no existe
      const targetStageId = isWon ? stageGanadoId : stageProspectoId;
      const targetStatus = isWon ? 'won' : 'open';
      console.log(`[Pipeline] [OPPORTUNITY] Creando nueva Oportunidad para ${contactId} en Etapa ${isWon ? 'GANADO' : 'INICIAL'}`);
      const createPayload = {
        pipelineId: unifiedPipelineId,
        locationId: locationId,
        name: contactName || "Oportunidad Comercial",
        pipelineStageId: targetStageId,
        status: targetStatus,
        contactId: contactId,
        monetaryValue: Number(monetaryValue) || 0
      };
      if (assignedTo) createPayload.assignedTo = assignedTo;

      await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(createPayload)
      });
    }
  }, 'HIGH');
}
