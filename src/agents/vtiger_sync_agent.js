import { queryVTiger } from '../services/vtiger_api_service.js';
import { GHL_CONFIG } from '../config/index.js';
import { ghlFetch, GHL_HEADERS } from '../utils/ghl_http_client.js';
import { acquireContactLock, releaseContactLock } from './chat_router_agent.js';
import { buildSanitizedCommercialFields } from '../domain/commercial_engine.js';
import { learningBrain } from '../services/learning_brain.js';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS = GHL_HEADERS;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let syncRateLimitBlockedUntil = 0;

// fetchWithRetry ahora es un wrapper delgado sobre ghlFetch (centralizado en ghl_http_client.js)
async function fetchWithRetry(url, options, attempt = 1) {
  return ghlFetch(url, options, attempt, 'Reverse Sync');
}

/**
 * Encuentra un contacto en GHL usando teléfono o email.
 */
async function findGhlContact(vContact) {
  const cleanPhone = String(vContact.mobile || vContact.phone || '').replace(/\D/g, '');
  const email = vContact.email || '';

  if (cleanPhone.length >= 7) {
    const searchUrl = `https://services.leadconnectorhq.com/contacts/search?locationId=${locationId}&query=${cleanPhone}`;
    const res = await fetchWithRetry(searchUrl, { headers: HEADERS });
    if (res.status === 200) {
      const data = await res.json();
      const contacts = data.contacts || [];
      if (contacts.length > 0) return contacts[0];
    }
  }

  if (email.includes('@')) {
    const searchUrl = `https://services.leadconnectorhq.com/contacts/search?locationId=${locationId}&query=${encodeURIComponent(email)}`;
    const res = await fetchWithRetry(searchUrl, { headers: HEADERS });
    if (res.status === 200) {
      const data = await res.json();
      const contacts = data.contacts || [];
      if (contacts.length > 0) return contacts[0];
    }
  }

  return null;
}

/**
 * Demonio de Sincronización Inversa (Reverse Poller) 24/7.
 * Busca cambios en vTiger en los últimos X minutos y los refleja en GHL.
 */
export async function runVTigerToGHLPoller(minutesLookback = 4) {
  try {
    // Calcular fecha en zona horaria UTC (vTiger suele trabajar en UTC o zona del servidor)
    // Para asegurar margen de error, restamos 4 minutos.
    const date = new Date(Date.now() - (minutesLookback * 60 * 1000));
    // Formato MySQL: YYYY-MM-DD HH:MM:SS
    const pad = n => n.toString().padStart(2, '0');
    const modifiedTimeStr = `${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

    // Consultamos los contactos modificados recientemente
    const q = `SELECT * FROM Contacts WHERE modifiedtime >= '${modifiedTimeStr}' LIMIT 50;`;
    let modifiedContacts = [];
    try {
       modifiedContacts = await queryVTiger(q);
    } catch(err) {
       // Si vtiger falla o no soporta modifiedtime en esta version WS, salir silenciosamente
       return;
    }

    if (!modifiedContacts || modifiedContacts.length === 0) return;
    
    console.log(`[Reverse Sync] [SYNC] ${modifiedContacts.length} contactos modificados en vTiger detectados en los últimos ${minutesLookback} mins. Sincronizando a GHL...`);

    let syncCount = 0;
    for (const vContact of modifiedContacts) {
      // 1. Encontrar su par en GHL
      const ghlContact = await findGhlContact(vContact);
      if (!ghlContact) continue; // Si no existe en GHL, lo ignoramos

      // 2. Extraer "Ground Truth" para alimentar el Cerebro (Opcional, si cambió condición)
      const vCond = vContact.cf_2610 || '';
      let treatment = null;
      const lower = vCond.toLowerCase();
      if (lower.includes('potencia')) treatment = 'Potencia';
      else if (lower.includes('diabet')) treatment = 'Diabetes';
      else if (lower.includes('prostat')) treatment = 'Prostata';
      else if (lower.includes('colagen')) treatment = 'Colageno';
      else if (lower.includes('vision')) treatment = 'Vision';
      else if (lower.includes('gastro')) treatment = 'Gastro';
      else if (lower.includes('artrit')) treatment = 'Artritis';

      if (treatment && ghlContact.tags && !ghlContact.tags.includes(`producto-${treatment.toLowerCase()}`)) {
         learningBrain.learnFromVtigerSale({ treatment, chatText: `Manual vTiger Sync: ${vCond}`, campaignName: 'vTiger Direct' });
      }

      // 3. Evaluar y Sanear Campos Comerciales (Regla de Oro: vTiger manda)
      const customFieldsToUpdate = buildSanitizedCommercialFields(ghlContact, vContact);

      // 4. Armar Payload
      const updatePayload = {
        customFields: customFieldsToUpdate
      };

      // 4.5 Refuerzo de Etiquetas de Producto (vTiger manda sobre GHL)
      if (treatment) {
        const ALL_PRODUCT_TAGS = ['producto-artritis', 'producto-diabetes', 'producto-prostata', 'producto-potencia', 'producto-colageno', 'producto-vision', 'producto-gastro'];
        const activeProductTag = `producto-${treatment.toLowerCase()}`;
        
        const newTagsSet = new Set((ghlContact.tags || []).map(t => String(t).trim()));
        newTagsSet.add(activeProductTag);
        
        // Purgar etiquetas falsas/obsoletas de otros productos
        for (const pTag of ALL_PRODUCT_TAGS) {
          if (pTag !== activeProductTag) {
            newTagsSet.delete(pTag);
          }
        }
        
        updatePayload.tags = Array.from(newTagsSet);
      }

      // Limpieza de strings vacíos
      for (const key of Object.keys(updatePayload.customFields)) {
        if (updatePayload.customFields[key] === '') delete updatePayload.customFields[key];
      }

      // 5. Inyectar a GHL (Custom Fields y Tags sanados)
      await acquireContactLock(ghlContact.id);
      try {
        const updateRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${ghlContact.id}`, {
          method: 'PUT',
          headers: HEADERS,
          body: JSON.stringify(updatePayload)
        });

        if (updateRes.status === 200) {
           syncCount++;
           console.log(`[Reverse Sync] [SUCCESS] Cliente ${vContact.firstname} ${vContact.lastname} sincronizado de vTiger a GHL exitosamente.`);
        }
      } finally {
        releaseContactLock(ghlContact.id);
      }
      
      await sleep(250); // Rate Limit Protection
    }
    
    if (syncCount > 0) {
      console.log(`[Reverse Sync] 🏁 Ciclo completado. ${syncCount} contactos actualizados en GHL.`);
    }

  } catch (error) {
    console.error(`[Reverse Sync Error]:`, error.message);
  }
}
