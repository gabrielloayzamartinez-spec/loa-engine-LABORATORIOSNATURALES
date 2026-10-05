import { GHL_CONFIG, SEDES_GATEWAY, resolveSedeContext, getGhlHeaders } from '../config/index.js';
import { normalizeTreatment } from '../domain/clinical_vocabulary.js';
import { fetchConTimeout } from '../utils/http_timeout.js';

const { apiKey, locationId } = GHL_CONFIG;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    if (global.apiCounters) global.apiCounters.ghl++;
    const res = await fetchConTimeout(url, options);
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
 * Buscar al contacto en GHL por coincidencia de conversación reciente (Bypass de FB API)
 */
async function findGhlContactByConversation(messageText, targetLocId, targetHeaders) {
  try {
    const locId = targetLocId || locationId;
    const headers = targetHeaders || getGhlHeaders({ locationId: locId });
    const url = `https://services.leadconnectorhq.com/conversations/search?locationId=${locId}&limit=10`;
    const res = await fetchWithRetry(url, { headers });
    if (res.status !== 200) return null;
    
    const data = await res.json();
    const conversations = data.conversations || [];
    
    if (messageText && messageText.trim().length > 0) {
      const targetText = messageText.toLowerCase().trim();
      let match = conversations.find(c => 
        c.lastMessageType === 'TYPE_FACEBOOK' && 
        c.lastMessageBody && 
        (c.lastMessageBody.toLowerCase().trim() === targetText || 
         c.lastMessageBody.toLowerCase().includes(targetText) ||
         targetText.includes(c.lastMessageBody.toLowerCase()))
      );
      if (match && match.contactId) {
        return { id: match.contactId, name: match.contactName };
      }
    }

    const fbConvs = conversations.filter(c => c.lastMessageType === 'TYPE_FACEBOOK');
    if (fbConvs.length > 0) {
       const mostRecent = fbConvs[0];
       const timeDiff = Date.now() - mostRecent.dateUpdated;
       if (timeDiff < 60000) { 
          return { id: mostRecent.contactId, name: mostRecent.contactName };
       }
    }
    return null;
  } catch (err) {
    console.error("[GHL API] Error buscando conversación:", err.message);
    return null;
  }
}

/**
 * Agente 4: Corrector de Etiquetas e IDs (Analista de Sanidad de Datos)
 * Escanea el payload en busca del referral (Ad ID) y corrige el contacto en GHL.
 */
export async function processAdIdCorrection(event, pageId = '') {
  try {
    let referral = event.referral;
    if (!referral && event.message?.referral) referral = event.message.referral;
    if (!referral && event.postback?.referral) referral = event.postback.referral;

    if (!referral) return; // Si no hay referral, el Agente 4 no tiene nada que corregir.

    const adId = referral.ad_id;
    const refParam = referral.ref;

    // [RESOLUCIÓN MULTI-SEDE PUNTO A PUNTO]
    const sedeConf = resolveSedeContext({ pageId });
    if (!sedeConf || sedeConf.isUnresolved || sedeConf.isConfigured === false) {
      console.warn(`[Agente 4] [SEDE-NO-CONFIGURADA] Sede no resoluble o sin credenciales (pageId: ${pageId}). Corrección omitida.`);
      return;
    }

    const targetLocId = sedeConf?.ghl?.locationId || locationId;
    const targetHeaders = getGhlHeaders({ locationId: targetLocId });

    if (global.pushLiveLog) global.pushLiveLog(`[AGENTE_4] [INFO] (${sedeConf?.sedeId || 'PALACIOS'}): Escaneando origen publicitario (Ad: ${adId || 'N/A'})`);

    let messageText = "";
    if (event.message && event.message.text) {
       messageText = event.message.text;
    } else if (event.postback && event.postback.title) {
       messageText = event.postback.title;
    }

    // Esperamos 2.5 segundos para darle ventaja a GHL de procesar el chat
    await sleep(2500);

    const ghlContact = await findGhlContactByConversation(messageText, targetLocId, targetHeaders);
    
    if (!ghlContact) {
      console.error(`[Agente 4] No se encontró el contacto GHL para corregir Ad ID en ${sedeConf?.sedeId || 'PALACIOS'}`);
      return;
    }
      
    const customFieldsToUpdate = [];
    const isBenavidesLoc = targetLocId === SEDES_GATEWAY.BENAVIDES.ghl.locationId;
    const ID_ANUNCIO_FIELD = isBenavidesLoc ? 'bjIdaPk0dzyuNw0RCMwn' : 'NR0eI8a2EvugkHhpRJ1w';
    const AD_ID_ALT_FIELD = isBenavidesLoc ? 'xYgC0RFCZZ1GagK2aaXu' : 'PUUykPTCijq7rZoLYwAD';
    const TRATAMIENTO_FIELD = isBenavidesLoc ? 'xqDD056VzkFTOxHniDkw' : '5Sci2WhOpJq9kZWsLTrp';
    
    if (adId) {
      customFieldsToUpdate.push({ id: ID_ANUNCIO_FIELD, field_value: String(adId) });
      customFieldsToUpdate.push({ id: AD_ID_ALT_FIELD, field_value: String(adId) });
    }
    
    if (refParam) {
      // [VOCABULARIO CANÓNICO] Se elimina el mapeo manual, que además tenía un
      // error: 'rodilla'/'articulaciones' (síntomas de Artritis) se etiquetaban
      // como 'Colageno'.
      const tratamiento = normalizeTreatment(refParam);

      if (tratamiento) {
        customFieldsToUpdate.push({ id: TRATAMIENTO_FIELD, field_value: tratamiento });
      }
    }

    if (customFieldsToUpdate.length > 0) {
      const updateRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${ghlContact.id}`, {
        method: 'PUT',
        headers: targetHeaders,
        body: JSON.stringify({ customFields: customFieldsToUpdate })
      });
      
      if (updateRes.status === 200) {
        if (global.pushLiveLog) global.pushLiveLog(`[AGENTE_4] [INFO] Corrección de AdID y Etiquetas aplicada para ${ghlContact.name} (${sedeConf?.sedeId || 'PALACIOS'})`);
      } else {
        console.error(`[Agente 4] Error corrigiendo GHL (${updateRes.status})`);
      }
    }
  } catch (err) {
    console.error("[Agente 4 Corrector Error]:", err.message);
  }
}
