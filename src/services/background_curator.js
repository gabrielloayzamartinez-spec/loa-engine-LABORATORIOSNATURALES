import fs from 'fs';
import path from 'path';
import { GHL_CONFIG } from '../config/index.js';
import { analyzeSymptoms, extractShippingData, inferTreatmentFromCampaignOrUtm, buildVtigerSource } from '../agents/nlp_symptom_engine.js';
import { tokenBucketQueue } from './token_bucket_queue.js';
import { findVTigerContact } from './vtiger_api_service.js';
import { learningBrain } from './learning_brain.js';
import { evaluateCommercialTruth, buildSanitizedCommercialFields, COMMERCIAL_FIELD_IDS } from '../domain/commercial_engine.js';
import { syncUnifiedPipelineOpportunity } from './ghl_opportunity_service.js';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

const STATE_FILE = path.join(process.cwd(), 'curator_state.json');
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

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {}
  }
  return { nextPageUrl: null, totalHealed: 0, totalScanned: 0 };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {}
}

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
 * Procesa y cura un solo contacto (Sanitización Integral 24/7):
 * 1. Purgado de fechas falsas de compra en prospectos sin venta (Caso Luisa Israel / Marisol Degollado / Alondra Vg).
 * 2. Sincronización exacta de vTiger Estado Comercial (CONVERTIDO vs SIN VENTA).
 * 3. Inyección de Fecha Última Asignación para segmentación y marketing.
 * 4. Corrección de tratamiento clínico y fuente (Meta Ads / CLICK2RING).
 */
export async function auditAndCureContact(contact) {
  if (!contact || !contact.id) return { status: 'skipped' };

  curatorStats.scannedCount++;
  const contactId = contact.id;
  const currentTags = (contact.tags || []).map(t => String(t).trim().toLowerCase());
  const existingCFs = contact.customFields || [];

  // 1. Escudo de Conversación Activa (15 min)
  let newestTimestamp = 0;
  let combinedText = '';
  try {
    const convRes = await fetchWithRetry(`https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&contactId=${contactId}`, { headers: HEADERS });
    if (convRes.status === 200) {
      const convData = await convRes.json();
      const conv = convData.conversations?.[0];
      if (conv) {
        const msgRes = await fetchWithRetry(`https://services.leadconnectorhq.com/conversations/${conv.id}/messages?limit=15`, { headers: HEADERS });
        if (msgRes.status === 200) {
          const msgData = await msgRes.json();
          const messages = msgData.messages?.messages || [];
          for (const m of messages) {
            const t = new Date(m.dateAdded).getTime();
            if (t > newestTimestamp) newestTimestamp = t;
          }
          combinedText = messages.map(m => m.body || '').join(' \n ');
        }
      }
    }
  } catch (e) {}

  const minutesSinceLastMsg = newestTimestamp > 0 ? (Date.now() - newestTimestamp) / (1000 * 60) : 999;
  if (minutesSinceLastMsg < 15) {
    curatorStats.skippedActiveCount++;
    return { status: 'skipped_active_shield' };
  }

  // 2. Consultar Ground Truth de vTiger CRM
  let vContact = null;
  try {
    vContact = await findVTigerContact(contact);
  } catch (e) {}

  const commercialTruth = evaluateCommercialTruth(contact, vContact);
  const isCustomerWon = commercialTruth.isWon;

  // 3. Evaluar Necesidad de Sanitización de Fechas de Compra
  const fechaCompraCF = existingCFs.find(f => f.id === COMMERCIAL_FIELD_IDS.FECHA_COMPRA);
  const precioVentaCF = existingCFs.find(f => f.id === COMMERCIAL_FIELD_IDS.PRECIO_VENTA);
  const estadoComercialCF = existingCFs.find(f => f.id === COMMERCIAL_FIELD_IDS.ESTADO_COMERCIAL);
  const fechaAsignacionCF = existingCFs.find(f => f.id === COMMERCIAL_FIELD_IDS.FECHA_ASIGNACION);
  const currentTratamiento = existingCFs.find(f => f.id === TRATAMIENTO_FIELD)?.value;

  const hasFakePurchaseDate = !isCustomerWon && Boolean(fechaCompraCF?.value);
  const hasFakePrice = !isCustomerWon && Boolean(precioVentaCF?.value && precioVentaCF.value !== '0' && precioVentaCF.value !== '0.00');
  const needsCommercialStatus = !estadoComercialCF || estadoComercialCF.value !== commercialTruth.commercialStatus;
  const needsAssignmentDate = !isCustomerWon && !fechaAsignacionCF?.value;

  // 4. Inferencia de Tratamiento Real
  const latestCampaign = contact.attributionSource?.utmCampaign || contact.attributionSource?.campaign || '';
  const latestMedium = contact.attributionSource?.utmMedium || '';
  const nlp = analyzeSymptoms(combinedText, latestCampaign, latestMedium);

  let vtigerTreatment = null;
  if (vContact?.cf_2610) {
    vtigerTreatment = inferTreatmentFromCampaignOrUtm(vContact.cf_2610) || (vContact.cf_2610.length > 2 ? vContact.cf_2610 : null);
  }
  const utmTreatment = inferTreatmentFromCampaignOrUtm(latestMedium) || inferTreatmentFromCampaignOrUtm(latestCampaign);
  const realTreatment = vtigerTreatment || nlp.primaryTreatment || utmTreatment || currentTratamiento || 'General';

  const treatmentMismatched = realTreatment && realTreatment !== 'General' && currentTratamiento !== realTreatment && (currentTags.includes('producto-artritis') && realTreatment !== 'Artritis');

  // Si no necesita cambios, saltar
  if (!hasFakePurchaseDate && !needsCommercialStatus && !needsAssignmentDate && !treatmentMismatched) {
    return { status: 'healthy' };
  }

  // 5. Preparar Actualización Quirúrgica
  const customFieldsToUpdate = [
    ...buildSanitizedCommercialFields(contact, vContact)
  ];

  // Tratamiento corregido
  if (realTreatment && realTreatment !== 'General') {
    customFieldsToUpdate.push({ id: TRATAMIENTO_FIELD, key: 'contact.tratamiento_comprado', field_value: realTreatment });
  }

  // Tags corregidos
  let newTags = [...currentTags];
  if (treatmentMismatched) {
    newTags = newTags.filter(t => t !== 'producto-artritis');
    const correctTag = `producto-${realTreatment.toLowerCase()}`;
    if (!newTags.includes(correctTag)) newTags.push(correctTag);
  }

  const updatePayload = {
    customFields: customFieldsToUpdate
  };
  if (treatmentMismatched) {
    updatePayload.tags = newTags;
    if ((contact.source || '').includes('Artritis')) {
      updatePayload.source = contact.source.replace(/Artritis/g, realTreatment);
    }
  }

  // 6. Sincronización de Pipeline de GHL
  const contactName = `${contact.firstName || ''} ${contact.lastName || ''}`.trim();
  await syncUnifiedPipelineOpportunity(contactId, contactName, isCustomerWon);

  // Encolar en Token Bucket Queue (Prioridad Baja)
  await tokenBucketQueue.enqueue(async () => {
    return fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify(updatePayload)
    });
  }, 'LOW');

  curatorStats.healedCount++;
  console.log(`[Curador 24/7] 🪄 Curado ${contact.firstName || ''} ${contact.lastName || contactId}: Estado=${isCustomerWon ? 'CONVERTIDO' : 'SIN VENTA'}, Fechas purgadas=${!isCustomerWon}`);
  return { status: 'healed', contactId };
}

/**
 * Ciclo de Curación Continua con Paginador Puntero (Recorre toda la base de 394k sin saturar)
 */
export async function runBackgroundCuratorCycle(batchLimit = 30) {
  if (isCuratorRunning) return;
  isCuratorRunning = true;
  curatorStats.lastRunAt = new Date().toISOString();

  const state = loadState();
  let url = state.nextPageUrl || `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=${batchLimit}&sortBy=date_updated&order=desc`;

  try {
    console.log(`[Curador 24/7] 🧹 Iniciando ciclo de curación continua (Total curados históricos: ${state.totalHealed || 0})...`);
    const res = await fetchWithRetry(url, { headers: HEADERS });
    if (res.status === 200) {
      const data = await res.json();
      const contacts = data.contacts || [];

      for (const contact of contacts) {
        const result = await auditAndCureContact(contact);
        if (result?.status === 'healed') {
          state.totalHealed = (state.totalHealed || 0) + 1;
        }
        state.totalScanned = (state.totalScanned || 0) + 1;
        await sleep(1000); // 1s entre contactos para respetar cuotas
      }

      // Avanzar cursor a la siguiente página
      if (data.meta && data.meta.nextPageUrl) {
        state.nextPageUrl = data.meta.nextPageUrl;
      } else {
        // Terminó una vuelta completa, reiniciar cursor para ciclo continuo
        state.nextPageUrl = null;
      }
      saveState(state);
    }
  } catch (err) {
    console.error(`[Curador 24/7 Error]:`, err.message);
  } finally {
    isCuratorRunning = false;
  }
}

export function getCuratorMetrics() {
  return {
    isRunning: isCuratorRunning,
    stats: curatorStats,
    persistentState: loadState()
  };
}
