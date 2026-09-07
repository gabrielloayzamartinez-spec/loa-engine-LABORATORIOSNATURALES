import { GHL_CONFIG } from './src/config/index.js';

const headers = {
  'Authorization': `Bearer ${GHL_CONFIG.apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

const MASTER_PIPELINE_ID = 'y7H2Jv2R493wM1qg2sZp';
const REMARKETING_STAGE_ID = '41af4766-3534-49c4-8b62-6161de562a33';

async function fixRemarketing() {
  console.log('Buscando oportunidades en estado ganado con valor $0 en Remarketing...');
  let hasNext = true;
  let url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_CONFIG.locationId}`;
  
  let fixedCount = 0;
  
  while(hasNext) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
        console.log(`Error API: ${res.status}`);
        break;
    }
    const data = await res.json();
    const opps = data.opportunities || [];
    console.log(`Analizando página: ${opps.length} oportunidades.`);
    
    for (const opp of opps) {
       // Si están en Remarketing, marcados como "won" (ganado), y valor es $0
       if (opp.pipelineStageId === REMARKETING_STAGE_ID && opp.status === 'won' && (!opp.monetaryValue || opp.monetaryValue === 0)) {
           console.log(`Corrigiendo a ${opp.name} ($0) -> Cambiando status a 'open'`);
           await fetch(`https://services.leadconnectorhq.com/opportunities/${opp.id}`, {
              method: 'PUT',
              headers,
              body: JSON.stringify({
                 status: 'open'
              })
           });
           fixedCount++;
       }
    }
    
    if (data.meta && data.meta.nextPageUrl) {
       url = data.meta.nextPageUrl;
    } else {
       hasNext = false;
    }
  }
  
  console.log(`¡Proceso terminado! Se corrigieron ${fixedCount} oportunidades regresándolas a 'open'.`);
}

fixRemarketing();
