import { META_CONFIG, GHL_CONFIG } from '../config/index.js';

const { accessToken } = META_CONFIG;
const { apiKey, locationId } = GHL_CONFIG;

const HEADERS_CONTACTS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    if (global.apiCounters) global.apiCounters.ghl++;
    const res = await fetch(url, options);
    if (res.status === 429) {
      await sleep(1500 * attempt);
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < 5) {
      await sleep(1500);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw e;
  }
}

/**
 * 1. Obtener nombre del usuario desde Meta usando el PSID
 */
async function getMetaUserProfile(psid, pageId) {
  try {
    const systemToken = META_CONFIG.accessToken;
    console.log(`[Meta API] Intentando obtener perfil para PSID: ${psid}, PageID: ${pageId}`);
    
    // 1. Obtener el Token de Acceso de la Página
    const pageTokenUrl = `https://graph.facebook.com/${META_CONFIG.graphApiVersion}/${pageId}?fields=access_token&access_token=${systemToken}`;
    const tokenRes = await fetch(pageTokenUrl);
    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error(`[Meta API] Error obteniendo Page Token para la página ${pageId}:`, err);
      return null;
    }
    const tokenData = await tokenRes.json();
    const pageToken = tokenData.access_token;

    // 2. Usar el Token de la Página para obtener el Perfil
    const url = `https://graph.facebook.com/${META_CONFIG.graphApiVersion}/${psid}?fields=first_name,last_name,name&access_token=${pageToken}`;
    if (global.apiCounters) global.apiCounters.meta++;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.text();
      console.error(`[Meta API] Error HTTP ${res.status} obteniendo perfil para PSID ${psid} (Page: ${pageId}):`, err);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("[Meta API] Error obteniendo perfil:", err.message);
    return null;
  }
}

import { processAdIdCorrection } from './agent4_tag_corrector.js';

/**
 * Procesar el Webhook Entrante de Meta
 */
export async function processMetaWebhook(payload) {
  try {
    if (payload.object !== 'page') return;

    for (const entry of payload.entry) {
      const pageId = entry.id;
      const messagingEvents = entry.messaging || [];

      for (const event of messagingEvents) {
        const senderPsid = event.sender?.id;
        
        // 1. Loguear Recepción Rápida (Agente 1)
        if (event.message && !event.message.is_echo) {
           if (global.pushLiveLog) global.pushLiveLog(`💬 Meta Webhook (Agente 1): Mensaje recibido de PSID ${senderPsid}`);
        }

        // 2. Disparar el Agente 4 (Analista/Corrector) de forma asíncrona para que analice si hay un referral (Ad ID)
        // Esto libera al Agente 1 instantáneamente
        processAdIdCorrection(event).catch(err => {
           console.error("[Agente 4 Disparo Error]:", err);
        });
      }
    }
  } catch (err) {
    console.error("[Agente 4 Meta Webhook Error]:", err.message);
  }
}
