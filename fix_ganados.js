import { GHL_CONFIG } from './src/config/index.js';

const headers = {
  'Authorization': `Bearer ${GHL_CONFIG.apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

const MASTER_PIPELINE_ID = 'y7H2Jv2R493wM1qg2sZp';
const REMARKETING_STAGE_ID = '41af4766-3534-49c4-8b62-6161de562a33';
const GANADO_STAGE_ID = 'b7b26459-ae47-4249-a45f-0a0c5506e30e';

async function fixGanados() {
  console.log('Buscando oportunidades en Remarketing...');
  let hasNext = true;
  let url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_CONFIG.locationId}`;
  
  let fixedCount = 0;
  
  while(hasNext) {
    const res = await fetch(url, { headers });
    const data = await res.json();
    const opps = data.opportunities || [];
    console.log(`Página leída: ${opps.length} oportunidades.`);
    
    for (const opp of opps) {
       if (opp.pipelineStageId === REMARKETING_STAGE_ID && opp.monetaryValue > 0) {
           console.log(`Moviendo a ${opp.name} ($${opp.monetaryValue}) a Ganado...`);
           await fetch(`https://services.leadconnectorhq.com/opportunities/${opp.id}`, {
              method: 'PUT',
              headers,
              body: JSON.stringify({
                 pipelineStageId: GANADO_STAGE_ID,
                 status: 'won'
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
  
  console.log(`¡Proceso terminado! Se corrigieron ${fixedCount} oportunidades.`);
}

fixGanados();
