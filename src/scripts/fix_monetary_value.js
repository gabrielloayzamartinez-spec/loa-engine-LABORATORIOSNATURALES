import fs from 'fs';
import path from 'path';
import { GHL_CONFIG } from '../config/index.js';

const { apiKey, locationId } = GHL_CONFIG;
const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

const PIPELINES_CACHE_FILE = path.join(process.cwd(), 'src', 'config', 'pipelines_cache.json');
const PRECIO_VENTA_FIELD = '5js0Lfbh5XDLq87SDgdT';

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

async function fixMonetaryValues() {
  console.log("💰 Iniciando actualización de Monetary Value para clientes Ganados...");
  
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
      // Forzamos actualización de $0.00
      if (opp.monetaryValue > 0) continue;

      const contactId = opp.contactId;
      if (!contactId) continue;

      const cRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: HEADERS });
      if (cRes.status === 200) {
        const cData = await cRes.json();
        const contact = cData.contact || cData;
        const customFields = contact.customFields || [];
        const precioField = customFields.find(f => f.id === PRECIO_VENTA_FIELD);
        
        let realValue = 0;
        if (precioField && precioField.value) {
          realValue = parseFloat(precioField.value);
        }

        if (realValue > 0) {
          console.log(`Actualizando Oportunidad ${opp.id} (Contacto: ${contactId}) -> Valor: $${realValue}`);
          const payload = {
            pipelineId: pipelineId,
            locationId: locationId,
            name: opp.name,
            pipelineStageId: stageGanadoId,
            status: 'won',
            contactId: contactId,
            monetaryValue: realValue
          };

          await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${opp.id}`, {
            method: 'PUT',
            headers: HEADERS,
            body: JSON.stringify(payload)
          });
          totalUpdated++;
        }
      }
      
      await sleep(300); // 3 requests per second is safe
    }
    hasMore = false; 
  }
  
  console.log(`\n🎉 Actualización Completada. Se actualizaron ${totalUpdated} oportunidades con su valor real.`);
}

fixMonetaryValues();
