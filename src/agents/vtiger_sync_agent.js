import { queryVTiger } from '../services/vtiger_api_service.js';
import { GHL_CONFIG } from '../config/index.js';
import { buildSanitizedCommercialFields } from '../domain/commercial_engine.js';
import { learningBrain } from '../services/learning_brain.js';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let syncRateLimitBlockedUntil = 0;

async function fetchWithRetry(url, options, attempt = 1) {
  const now = Date.now();
  if (now < syncRateLimitBlockedUntil) {
    const waitMs = syncRateLimitBlockedUntil - now;
    await sleep(waitMs);
  }

  try {
    if (global.apiCounters) global.apiCounters.ghl++;
    const res = await fetch(url, options);
    if (res.status === 429) {
      console.warn(`[VTiger Sync Shield] ⚠️ GHL retornó 429. Pausando demonio durante 60s...`);
      syncRateLimitBlockedUntil = Date.now() + 60000;
      await sleep(60000);
      if (attempt < 4) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < 4) {
      await sleep(2000 * attempt);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw e;
  }
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
    
    console.log(`[Reverse Sync] 🔄 ${modifiedContacts.length} contactos modificados en vTiger detectados en los últimos ${minutesLookback} mins. Sincronizando a GHL...`);

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

      // Limpieza de strings vacíos
      for (const key of Object.keys(updatePayload)) {
        if (updatePayload[key] === '') delete updatePayload[key];
      }

      // 5. Inyectar a GHL (solo Custom Fields, no tocamos tags ni owner aquí para no entorpecer)
      const updateRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${ghlContact.id}`, {
        method: 'PUT',
        headers: HEADERS,
        body: JSON.stringify(updatePayload)
      });

      if (updateRes.status === 200) {
         syncCount++;
         console.log(`[Reverse Sync] ✅ Cliente ${vContact.firstname} ${vContact.lastname} sincronizado de vTiger a GHL exitosamente.`);
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
