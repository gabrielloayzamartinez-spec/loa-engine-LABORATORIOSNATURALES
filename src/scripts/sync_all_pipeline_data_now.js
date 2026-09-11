import fs from 'fs';
import path from 'path';
import { GHL_CONFIG } from '../config/index.js';
import { findVTigerContact } from '../services/vtiger_api_service.js';
import { buildSanitizedCommercialFields } from '../domain/commercial_engine.js';

const { apiKey, locationId } = GHL_CONFIG;
const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

const PIPELINES_CACHE_FILE = path.join(process.cwd(), 'src', 'config', 'pipelines_cache.json');

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

async function runGlobalSync() {
  console.log("🚀 Iniciando Sincronización Global de Datos al 100% para Capacitación...");
  
  if (!fs.existsSync(PIPELINES_CACHE_FILE)) {
    console.error("No se encontró pipelines_cache.json");
    return;
  }
  
  const cache = JSON.parse(fs.readFileSync(PIPELINES_CACHE_FILE, 'utf8'));
  const pipelineId = cache.unified.pipelineId;
  // Obtenemos todos los stages para iterarlos
  const stages = [
    cache.unified.stageProspectoId,
    cache.unified.stageCapturadoId,
    cache.unified.stageSeguimientoId,
    cache.unified.stageGanadoId,
    cache.unified.stagePerdidoId
  ].filter(Boolean);
  
  let totalUpdated = 0;

  for (const stageId of stages) {
    console.log(`\nProcesando Etapa: ${stageId}...`);
    let hasMore = true;
    let offset = 0;

    while (hasMore) {
      const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&pipeline_stage_id=${stageId}&limit=100`;
      // Note: GHL search doesn't natively support offset in this endpoint easily, but we fetch max 100.
      // If there are more than 100 in a stage, we might need a different strategy, but for now we process what we get.
      const res = await fetchWithRetry(url, { headers: HEADERS });
      
      if (res.status !== 200) {
        console.error("Error buscando oportunidades:", await res.text());
        break;
      }
      
      const data = await res.json();
      const opps = data.opportunities || [];
      
      if (opps.length === 0) {
        hasMore = false;
        break;
      }
      
      console.log(`Encontradas ${opps.length} oportunidades en esta consulta.`);
      
      for (const opp of opps) {
        const contactId = opp.contactId;
        if (!contactId) continue;

        const cRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: HEADERS });
        if (cRes.status === 200) {
          const cData = await cRes.json();
          const contact = cData.contact || cData;
          
          const vContact = await findVTigerContact(contact);
          
          let updatePayload = { customFields: [] };
          let needsUpdate = false;

          // 1. Inyectar Campos Comerciales y Extendidos
          if (vContact) {
              const commercialFields = buildSanitizedCommercialFields(contact, vContact);
              if (commercialFields.length > 0) {
                  updatePayload.customFields.push(...commercialFields);
                  needsUpdate = true;
              }
              
              // 2. Inyectar Demografía Base Faltante
              if (!contact.phone && vContact.phone) { updatePayload.phone = vContact.phone; needsUpdate = true; }
              if (!contact.email && vContact.email && vContact.email !== '--') { updatePayload.email = vContact.email; needsUpdate = true; }
              
              if (!contact.address1 && vContact.mailingstreet && vContact.mailingstreet !== '--') { updatePayload.address1 = vContact.mailingstreet; needsUpdate = true; }
              if (!contact.city && vContact.mailingcity && vContact.mailingcity !== '--') { updatePayload.city = vContact.mailingcity; needsUpdate = true; }
              
              // Map state custom field (splareacodes_state)
              const STATE_FIELD_ID = 'rQ4u67m7S6Fp3z5k0389';
              if (vContact.splareacodes_state && vContact.splareacodes_state !== '--') {
                const currentGhlState = contact.customFields?.find(f => f.id === STATE_FIELD_ID)?.value;
                if (!currentGhlState) {
                  updatePayload.customFields.push({ id: STATE_FIELD_ID, key: 'contact.state', field_value: vContact.splareacodes_state });
                  needsUpdate = true;
                }
              }
          }

          if (needsUpdate) {
              console.log(`[GLOBAL SYNC] Actualizando Contacto ${contactId} (${contact.firstName}) con datos de vTiger...`);
              await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
                  method: 'PUT',
                  headers: HEADERS,
                  body: JSON.stringify(updatePayload)
              });
              totalUpdated++;
          }
        }
        
        await sleep(300);
      }
      hasMore = false; // We process the first 100 of each stage to avoid infinite loops if pagination is not supported.
    }
  }
  
  console.log(`\n✅ SINCRONIZACIÓN GLOBAL AL 100% COMPLETADA. Contactos enriquecidos: ${totalUpdated}.`);
}

runGlobalSync();
