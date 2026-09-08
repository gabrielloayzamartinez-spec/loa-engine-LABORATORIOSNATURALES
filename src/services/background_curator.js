import { GHL_CONFIG } from '../config/index.js';
import { analyzeSymptoms, extractShippingData, inferTreatmentFromCampaignOrUtm, buildVtigerSource } from '../agents/nlp_symptom_engine.js';
import { tokenBucketQueue } from './token_bucket_queue.js';
import { findVTigerContact } from './vtiger_api_service.js';
import { learningBrain } from './learning_brain.js';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

const TRATAMIENTO_FIELD = 'WcrrCIL4A2203kIbeFsJ';
const ALL_PRODUCT_TAGS = [
  'producto-artritis',
  'producto-diabetes',
  'producto-prostata',
  'producto-potencia',
  'producto-colageno',
  'producto-vision',
  'producto-gastro'
];

let isCuratorRunning = false;
let curatorStats = {
  scannedCount: 0,
  healedCount: 0,
  skippedActiveCount: 0,
  lastRunAt: null
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      await sleep(2500 * attempt);
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < 5) {
      await sleep(2500);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw e;
  }
}

/**
 * Procesa y cura un solo contacto respetando el Escudo de 15 minutos y sin saturar
 */
export async function auditAndCureContact(contact) {
  if (!contact || !contact.id) return { status: 'skipped' };

  curatorStats.scannedCount++;
  const contactId = contact.id;
  const currentTags = (contact.tags || []).map(t => String(t).trim().toLowerCase());
  const hasArtritisTag = currentTags.includes('producto-artritis');
  const sourceIsArtritis = (contact.source || '').includes('Artritis');

  // Si no tiene indicios de Artritis y ya tiene producto asignado, no requiere intervención urgente
  if (!hasArtritisTag && !sourceIsArtritis && (contact.tags || []).some(t => ALL_PRODUCT_TAGS.includes(t))) {
    return { status: 'healthy' };
  }

  // 1. Buscar conversaciones del contacto para evaluar actividad reciente
  const convRes = await fetchWithRetry(`https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&contactId=${contactId}`, { headers: HEADERS });
  if (convRes.status !== 200) return { status: 'error' };

  const convData = await convRes.json();
  const conv = convData.conversations?.[0];
  if (!conv) return { status: 'no_conversation' };

  // 2. Extraer mensajes
  const msgRes = await fetchWithRetry(`https://services.leadconnectorhq.com/conversations/${conv.id}/messages?limit=25`, { headers: HEADERS });
  if (msgRes.status !== 200) return { status: 'error' };

  const msgData = await msgRes.json();
  const messages = msgData.messages?.messages || [];
  if (messages.length === 0) return { status: 'no_messages' };

  // 🛡️ ESCUDO DE PROTECCIÓN UX (15 MINUTOS INVIOLABLE)
  let newestTimestamp = 0;
  for (const m of messages) {
    const t = new Date(m.dateAdded).getTime();
    if (t > newestTimestamp) newestTimestamp = t;
  }
  const minutesSinceLastMsg = newestTimestamp > 0 ? (Date.now() - newestTimestamp) / (1000 * 60) : 999;

  if (minutesSinceLastMsg < 15) {
    curatorStats.skippedActiveCount++;
    console.log(`[Curador Asíncrono] 🛡️ Escudo Activo para ${contact.firstName || contactId}: Asesor atendiendo (${minutesSinceLastMsg.toFixed(1)}m). Omitido.`);
    return { status: 'skipped_active_shield' };
  }

  // 3. Re-análisis inteligente con el Cerebro de Aprendizaje
  const combinedText = messages.map(m => m.body || '').join(' \n ');
  const latestCampaign = contact.attributionSource?.utmCampaign || contact.attributionSource?.campaign || '';
  const latestMedium = contact.attributionSource?.utmMedium || '';

  const nlp = analyzeSymptoms(combinedText, latestCampaign, latestMedium);

  // 🏢 Ground Truth vTiger CRM
  let vtigerTreatment = null;
  try {
    const vContact = await findVTigerContact(contact);
    if (vContact && vContact.cf_2610) {
      vtigerTreatment = inferTreatmentFromCampaignOrUtm(vContact.cf_2610) || (vContact.cf_2610.length > 2 ? vContact.cf_2610 : null);
    }
  } catch (e) {
    // Continuar
  }

  const utmTreatment = inferTreatmentFromCampaignOrUtm(latestMedium) ||
                       inferTreatmentFromCampaignOrUtm(latestCampaign);

  const realTreatment = vtigerTreatment || nlp.primaryTreatment || utmTreatment;

  // Si se detectó una patología clara que NO es Artritis, pero tenía Artritis residual:
  if (realTreatment && realTreatment !== 'Artritis' && (hasArtritisTag || sourceIsArtritis)) {
    console.log(`[Curador Asíncrono] 🚨 Falso positivo curado para ${contact.firstName || ''} ${contact.lastName || ''} (${contactId}) -> ${realTreatment}`);

    // Limpieza de tags
    const newTags = currentTags.filter(t => t !== 'producto-artritis');
    const correctTag = `producto-${realTreatment.toLowerCase()}`;
    if (!newTags.includes(correctTag)) newTags.push(correctTag);

    // Limpieza de fuente
    let newSource = contact.source || '';
    if (sourceIsArtritis) {
      newSource = newSource.replace(/Artritis/g, realTreatment);
    } else if (!newSource || newSource.length < 5) {
      newSource = buildVtigerSource({
        sedeName: 'usa',
        provider: 'CLICK2RING',
        channel: 'FB-MSGR',
        treatment: realTreatment
      });
    }

    // Actualizar campo Tratamiento Comprado
    const existingCFs = contact.customFields || [];
    const updatedCFs = existingCFs.map(f => {
      if (f.id === TRATAMIENTO_FIELD) return { id: f.id, field_value: realTreatment };
      return { id: f.id, field_value: f.value };
    });

    if (!existingCFs.some(f => f.id === TRATAMIENTO_FIELD)) {
      updatedCFs.push({ id: TRATAMIENTO_FIELD, field_value: realTreatment });
    }

    const updatePayload = {
      tags: newTags,
      source: newSource,
      customFields: updatedCFs
    };

    // Penalización en el Cerebro para prevenir recurrencia
    learningBrain.penalizeAssociation({
      phrase: combinedText.slice(0, 100),
      incorrectTreatment: 'Artritis',
      correctTreatment: realTreatment
    });

    // Enviar actualización a través del Token Bucket Queue (Prioridad Baja)
    await tokenBucketQueue.enqueue(async () => {
      return fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
        method: 'PUT',
        headers: HEADERS,
        body: JSON.stringify(updatePayload)
      });
    }, 'LOW');

    curatorStats.healedCount++;
    return { status: 'healed', realTreatment };
  }

  return { status: 'no_change_needed' };
}

/**
 * Inicia el Demonio Curativo en Segundo Plano (Corre en intervalos seguros sin saturar API)
 */
export async function runBackgroundCuratorCycle(batchLimit = 30) {
  if (isCuratorRunning) return;
  isCuratorRunning = true;
  curatorStats.lastRunAt = new Date().toISOString();

  try {
    console.log(`[Curador Asíncrono] 🧹 Iniciando ciclo de curación histórica (Token-Bucket Shield Activo)...`);
    const res = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=${batchLimit}&sortBy=date_updated&order=desc`, { headers: HEADERS });
    if (res.status === 200) {
      const data = await res.json();
      const contacts = data.contacts || [];

      for (const contact of contacts) {
        await auditAndCureContact(contact);
        await sleep(1200); // 1.2s entre cada contacto para no consumir cuota
      }
    }
  } catch (err) {
    console.error(`[Curador Asíncrono] Error en ciclo de curación:`, err.message);
  } finally {
    isCuratorRunning = false;
  }
}

export function getCuratorMetrics() {
  return {
    isRunning: isCuratorRunning,
    stats: curatorStats
  };
}
