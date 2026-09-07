import { GHL_CONFIG } from './src/config/index.js';

const headers = {
  'Authorization': `Bearer ${GHL_CONFIG.apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

async function deleteGarbage() {
  console.log('Buscando Oportunidades Basura ("Oportunidad Migrada")...');
  let hasNext = true;
  let url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_CONFIG.locationId}`;
  
  let deletedCount = 0;
  
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
       if (opp.name === "Oportunidad Migrada") {
           console.log(`Borrando basura: ${opp.id}`);
           await fetch(`https://services.leadconnectorhq.com/opportunities/${opp.id}`, {
              method: 'DELETE',
              headers
           });
           deletedCount++;
       }
    }
    
    if (data.meta && data.meta.nextPageUrl) {
       url = data.meta.nextPageUrl;
    } else {
       hasNext = false;
    }
  }
  
  console.log(`¡Limpieza terminada! Se borraron ${deletedCount} tarjetas basura.`);
}

deleteGarbage();
