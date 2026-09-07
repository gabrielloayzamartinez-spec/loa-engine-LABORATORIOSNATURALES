import fs from 'fs';
import path from 'path';
import { GHL_CONFIG } from '../config/index.js';
import { findVTigerContact, getSalesHistory } from '../services/vtiger_api_service.js';

const STATE_FILE = path.join(process.cwd(), 'healer_state.json');
const BATCH_SIZE = 20; // 20 contactos por ciclo
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

const HEADERS = {
  'Authorization': `Bearer ${GHL_CONFIG.apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

const UTM_IDS = {
  source: 'L3eEulpe8II7q0UAJnKZ',
  medium: 'HVjiEMKYR2feXviAZ2Jd',
  campaign: 'KS3iYmIjVcmFJV7MIDnT',
  id_anuncio: '6w3yMjLgIw6npUKWIosr',
  ad_id: 'ujLG5Ogp94WfynVubapT',
  content: 'Vmzz5BxbMcrlInmuiblM',
  term: 'Wh4IIv4TEbxJaZBi95cp',
  adset: 'XTGicfQtDwBrlr2qPKxF'
};

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch(e) {}
  }
  return { nextPageUrl: null, totalHealed: 0 };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function healBatch() {
  const state = loadState();
  let url = state.nextPageUrl || `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_CONFIG.locationId}&limit=${BATCH_SIZE}`;
  
  try {
    console.log(`\n[HISTORIAL HEALER] 🔎 Buscando lote de contactos históricos...`);
    const res = await fetch(url, { headers: HEADERS });
    if (res.status !== 200) {
       console.error(`[HISTORIAL HEALER] Error de API: ${res.status}`);
       return;
    }
    const data = await res.json();
    const contacts = data.contacts || [];
    
    if (contacts.length === 0) {
      console.log(`[HISTORIAL HEALER] ✅ ¡Base de datos completamente escaneada y curada!`);
      return; // Fin
    }

    let updatedCount = 0;

    for (let c of contacts) {
      let isPaidAd = false;
      const existingTags = c.tags || [];
      
      if (String(c.source || '').toLowerCase().includes('ad_id')) {
        isPaidAd = true;
      }
      for (const t of existingTags) {
         if (t.toLowerCase().startsWith('ad_id.')) isPaidAd = true;
      }
      if (String(c.source || '') === 'Social media') {
         isPaidAd = false;
      }

      let newTags = new Set(existingTags);
      const updatedCustomFields = [];

      if (isPaidAd) {
         newTags.add('meta-ads');
         newTags.add('facebook-messenger');
         newTags.delete('social-media-organic');
         
         const adSource = c.source || 'meta-ads';
         updatedCustomFields.push({ id: UTM_IDS.source, key: "contact.utm_source", value: "facebook" });
         updatedCustomFields.push({ id: UTM_IDS.medium, key: "contact.utm_medium", value: "cpc" });
         updatedCustomFields.push({ id: UTM_IDS.campaign, key: "contact.utm_campaign", value: "meta-ads-campaign" });
         updatedCustomFields.push({ id: UTM_IDS.id_anuncio, key: "contact.id_de_anuncio", value: adSource });
         updatedCustomFields.push({ id: UTM_IDS.ad_id, key: "contact.ad_id", value: adSource });
         updatedCustomFields.push({ id: UTM_IDS.content, key: "contact.utm_content", value: "pauta" });
         updatedCustomFields.push({ id: UTM_IDS.term, key: "contact.utm_term", value: "facebook-ads" });
         updatedCustomFields.push({ id: UTM_IDS.adset, key: "contact.adset_id", value: "N/A" });
      } else {
         newTags.delete('meta-ads');
         newTags.delete('alerta-reingreso-pauta');
         newTags.add('facebook-messenger');
         
         updatedCustomFields.push({ id: UTM_IDS.source, key: "contact.utm_source", value: "Social media" });
         updatedCustomFields.push({ id: UTM_IDS.medium, key: "contact.utm_medium", value: "facebook" });
         updatedCustomFields.push({ id: UTM_IDS.campaign, key: "contact.utm_campaign", value: "organico" });
         updatedCustomFields.push({ id: UTM_IDS.id_anuncio, key: "contact.id_de_anuncio", value: "N/A" });
         updatedCustomFields.push({ id: UTM_IDS.ad_id, key: "contact.ad_id", value: "N/A" });
         updatedCustomFields.push({ id: UTM_IDS.content, key: "contact.utm_content", value: "messenger" });
         updatedCustomFields.push({ id: UTM_IDS.term, key: "contact.utm_term", value: "organico" });
         updatedCustomFields.push({ id: UTM_IDS.adset, key: "contact.adset_id", value: "N/A" });
      }

      // -------------------------------------------------------------
      // NUEVA LÓGICA: Sincronización de Compras desde vTiger
      // -------------------------------------------------------------
      let vtigerSyncPerformed = false;
      if (!existingTags.includes('historial-vtiger-sincronizado')) {
         try {
            const vContact = await findVTigerContact(c);
            if (vContact) {
               const sales = await getSalesHistory(vContact.id);
               if (sales && sales.length > 0) {
                  let totalValue = 0;
                  const salesList = sales.map(s => {
                     totalValue += parseFloat(s.total || 0);
                     return `• ${s.subject || 'Pedido'} - ${s.total} (Creado: ${s.createdtime})`;
                  }).join('\\n');
                  
                  const noteBody = `🛍️ HISTORIAL DE COMPRAS VTIGER RECUPERADO:\\nTotal de Compras: ${sales.length}\\nValor Acumulado: $${totalValue.toFixed(2)}\\n\\nDetalle:\\n${salesList}`;
                  
                  // Inyectar la nota en GHL
                  await fetch(`https://services.leadconnectorhq.com/contacts/${c.id}/notes`, {
                     method: 'POST',
                     headers: HEADERS,
                     body: JSON.stringify({ body: noteBody })
                  });
                  console.log(`[HISTORIAL HEALER] 💰 Compras recuperadas de vTiger para ${c.firstName || c.name} (${sales.length} compras)`);
               }
            }
            // Etiquetar para no volver a buscar (ahorro de API)
            newTags.add('historial-vtiger-sincronizado');
            vtigerSyncPerformed = true;
         } catch(e) {
            console.error(`[HISTORIAL HEALER] ⚠️ Error sincronizando vTiger para ${c.id}: ${e.message}`);
         }
      }
      // -------------------------------------------------------------

      // Check if anything actually changed
      const finalTagsList = Array.from(newTags);
      const tagsChanged = finalTagsList.length !== existingTags.length || finalTagsList.some(t => !existingTags.includes(t));
      
      const currentCF = c.customFields || [];
      let customFieldsChanged = false;
      for (const reqCF of updatedCustomFields) {
         const existingMatch = currentCF.find(f => f.id === reqCF.id);
         if (!existingMatch || existingMatch.value !== reqCF.value) {
            customFieldsChanged = true;
            break;
         }
      }

      if (tagsChanged || customFieldsChanged || vtigerSyncPerformed || (!isPaidAd && String(c.source || '') !== 'Social media')) {
         const updatePayload = {
            tags: finalTagsList,
            customFields: updatedCustomFields
         };
         if (!isPaidAd && String(c.source || '') !== 'Social media') {
            updatePayload.source = 'Social media';
         }

         await fetch(`https://services.leadconnectorhq.com/contacts/${c.id}`, {
            method: 'PUT',
            headers: HEADERS,
            body: JSON.stringify(updatePayload)
         });
         
         const name = c.contactName || c.firstName + ' ' + c.lastName;
         console.log(`[HISTORIAL HEALER] 🪄 Curado [${isPaidAd ? 'PAUTA' : 'ORGÁNICO'}]: ${name}`);
         updatedCount++;
         await sleep(200); // Throttling
      }
    }

    state.totalHealed += updatedCount;
    if (data.meta && data.meta.nextPageUrl) {
      state.nextPageUrl = data.meta.nextPageUrl;
    } else {
      state.nextPageUrl = null; // Terminó
    }
    
    saveState(state);
    console.log(`[HISTORIAL HEALER] Lote procesado. Actualizados: ${updatedCount}. Total Histórico Curados: ${state.totalHealed}`);
    console.log(`[HISTORIAL HEALER] Durmiendo por 5 minutos... 💤`);

  } catch(err) {
     console.error(`[HISTORIAL HEALER] Error inesperado:`, err.message);
  }
}

// Iniciar Daemon
console.log(`\n==========================================================`);
console.log(`🐢 HISTORIAL HEALER INICIALIZADO`);
console.log(`⏳ Ritmo: ${BATCH_SIZE} contactos cada 5 minutos.`);
console.log(`==========================================================\n`);

// Ejecutar primera vez de inmediato
healBatch();

// Programar ciclo
setInterval(healBatch, INTERVAL_MS);
