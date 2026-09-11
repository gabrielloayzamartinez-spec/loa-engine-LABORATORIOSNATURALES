import fs from 'fs';
import path from 'path';
import { GHL_CONFIG } from '../config/index.js';
import { findVTigerContact } from '../services/vtiger_api_service.js';

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
      console.warn(`[GHL API] Rate limit hit. Waiting ${2000 * attempt}ms...`);
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

async function runSync() {
  console.log("Iniciando sincronización demográfica para clientes Ganados...");
  
  if (!fs.existsSync(PIPELINES_CACHE_FILE)) {
    console.error("No se encontró pipelines_cache.json");
    return;
  }
  
  const cache = JSON.parse(fs.readFileSync(PIPELINES_CACHE_FILE, 'utf8'));
  const pipelineId = cache.unified.pipelineId;
  const stageGanadoId = cache.unified.stageGanadoId;
  
  let hasMore = true;
  let totalUpdated = 0;
  
  while (hasMore) {
    const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&pipeline_stage_id=${stageGanadoId}&limit=100`;
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
    
    console.log(`Encontradas ${opps.length} oportunidades Ganadas. Procesando...`);
    
    for (const opp of opps) {
      const contactId = opp.contactId;
      if (!contactId) continue;

      const cRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: HEADERS });
      if (cRes.status === 200) {
        const cData = await cRes.json();
        const contact = cData.contact || cData;
        
        const vContact = await findVTigerContact(contact);
        if (vContact) {
            let updatePayload = {};
            let needsUpdate = false;
            
            const vPhone = vContact.mobile || vContact.phone || vContact.homephone || vContact.otherphone;
            if (!contact.phone && vPhone) {
                updatePayload.phone = String(vPhone).replace(/\D/g, '');
                needsUpdate = true;
            }
            if (!contact.email && vContact.email) {
                updatePayload.email = String(vContact.email).trim();
                needsUpdate = true;
            }
            if (!contact.address1 && vContact.mailingstreet) {
                updatePayload.address1 = String(vContact.mailingstreet).trim();
                needsUpdate = true;
            }
            if (!contact.city && vContact.mailingcity) {
                updatePayload.city = String(vContact.mailingcity).trim();
                needsUpdate = true;
            }
            if ((!contact.state || contact.state === '--') && (vContact.mailingstate || vContact.splareacodes_state)) {
                updatePayload.state = String(vContact.mailingstate || vContact.splareacodes_state).trim();
                needsUpdate = true;
            }
            if (!contact.postalCode && (vContact.mailingzip || vContact.mailingpobox)) {
                updatePayload.postalCode = String(vContact.mailingzip || vContact.mailingpobox).trim();
                needsUpdate = true;
            }

            if (needsUpdate) {
                console.log(`Actualizando datos demográficos para ${contactId} (Teléfono vTiger: ${vPhone || 'No'})`);
                await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
                    method: 'PUT',
                    headers: HEADERS,
                    body: JSON.stringify(updatePayload)
                });
                totalUpdated++;
            }
        }
      }
      
      await sleep(300);
    }
    hasMore = false; 
  }
  
  console.log(`\nSincronización Completada. Se actualizaron ${totalUpdated} contactos con datos demográficos de vTiger.`);
}

runSync();
