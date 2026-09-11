import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { GHL_CONFIG } from '../config/index.js';

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

async function cleanPipelineMess() {
  console.log("🧹 Iniciando limpieza masiva de oportunidades basura en GHL...");
  
  if (!fs.existsSync(PIPELINES_CACHE_FILE)) {
    console.error("No se encontró pipelines_cache.json");
    return;
  }
  
  const cache = JSON.parse(fs.readFileSync(PIPELINES_CACHE_FILE, 'utf8'));
  const pipelineId = cache.unified.pipelineId;
  const stageProspectoId = cache.unified.stageProspectoInicialId;
  
  let hasMore = true;
  let totalDeleted = 0;
  
  // Usamos el endpoint de búsqueda de GHL (puede requerir paginación o borrar lotes de 100)
  while (hasMore) {
    console.log(`Buscando lote de oportunidades en el pipeline unificado...`);
    // GHL Opportunities API Search: https://highlevel.stoplight.io/docs/integrations/e37d5cbdfcc9b-search-opportunities
    const res = await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&limit=100`, { headers: HEADERS });
    
    if (res.status !== 200) {
      console.error("Error buscando oportunidades:", await res.text());
      break;
    }
    
    const data = await res.json();
    const opps = data.opportunities || [];
    
    if (opps.length === 0) {
      console.log("✅ No quedan más oportunidades por borrar. ¡Limpieza terminada!");
      hasMore = false;
      break;
    }
    
    console.log(`Encontradas ${opps.length} oportunidades en este lote. Procediendo a borrar...`);
    
    for (const opp of opps) {
      // Borrar la oportunidad
      const delRes = await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${opp.id}`, { method: 'DELETE', headers: HEADERS });
      if (delRes.status === 200 || delRes.status === 204) {
        totalDeleted++;
        if (totalDeleted % 50 === 0) console.log(`🗑️ Se han borrado ${totalDeleted} oportunidades...`);
      } else {
        console.error(`Error borrando oportunidad ${opp.id}: status ${delRes.status}`);
      }
      // Pequeño delay para no saturar la API
      await sleep(200);
    }
  }
  
  console.log(`\n🎉 Limpieza Completada. Se eliminaron un total de ${totalDeleted} oportunidades del pipeline.`);
}

cleanPipelineMess();
