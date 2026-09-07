import { GHL_CONFIG } from '../config/index.js';

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
 * Buscar al contacto en GHL por coincidencia de conversación reciente (Bypass de FB API)
 */
async function findGhlContactByConversation(messageText) {
  try {
    const url = `https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&limit=10`;
    const res = await fetchWithRetry(url, { headers: HEADERS_CONTACTS });
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
export async function processAdIdCorrection(event) {
  try {
    let referral = event.referral;
    if (!referral && event.message?.referral) referral = event.message.referral;
    if (!referral && event.postback?.referral) referral = event.postback.referral;

    if (!referral) return; // Si no hay referral, el Agente 4 no tiene nada que corregir.

    const adId = referral.ad_id;
    const refParam = referral.ref;

    if (global.pushLiveLog) global.pushLiveLog(`🕵️ Agente 4: Escaneando origen publicitario (Ad: ${adId || 'N/A'})`);

    let messageText = "";
    if (event.message && event.message.text) {
       messageText = event.message.text;
    } else if (event.postback && event.postback.title) {
       messageText = event.postback.title;
    }

    // Esperamos 2.5 segundos para darle ventaja a GHL de procesar el chat
    await sleep(2500);

    const ghlContact = await findGhlContactByConversation(messageText);
    
    if (!ghlContact) {
      console.error(`[Agente 4] No se encontró el contacto GHL para corregir Ad ID`);
      return;
    }
      
    const customFieldsToUpdate = [];
    const ID_ANUNCIO_FIELD = '6w3yMjLgIw6npUKWIosr';
    const TRATAMIENTO_FIELD = 'WcrrCIL4A2203kIbeFsJ';
    
    if (adId) {
      customFieldsToUpdate.push({ id: ID_ANUNCIO_FIELD, field_value: String(adId) });
    }
    
    if (refParam) {
      const campLower = refParam.toLowerCase();
      let tratamiento = '';
      if (campLower.includes('artritis')) tratamiento = 'Artritis';
      else if (campLower.includes('diabetes') || campLower.includes('azucar') || campLower.includes('glucosa')) tratamiento = 'Diabetes';
      else if (campLower.includes('prostata')) tratamiento = 'Prostata';
      else if (campLower.includes('colageno') || campLower.includes('rodilla') || campLower.includes('articulaciones')) tratamiento = 'Colageno';
      else if (campLower.includes('potencia') || campLower.includes('sexual')) tratamiento = 'Potencia';
      else if (campLower.includes('vision') || campLower.includes('vista')) tratamiento = 'Vision';
      
      if (tratamiento) {
        customFieldsToUpdate.push({ id: TRATAMIENTO_FIELD, field_value: tratamiento });
      }
    }

    if (customFieldsToUpdate.length > 0) {
      const updateRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${ghlContact.id}`, {
        method: 'PUT',
        headers: HEADERS_CONTACTS,
        body: JSON.stringify({ customFields: customFieldsToUpdate })
      });
      
      if (updateRes.status === 200) {
        if (global.pushLiveLog) global.pushLiveLog(`✅ Agente 4: Corrección de AdID y Etiquetas aplicada para ${ghlContact.name}`);
      } else {
        console.error(`[Agente 4] Error corrigiendo GHL (${updateRes.status})`);
      }
    }
  } catch (err) {
    console.error("[Agente 4 Corrector Error]:", err.message);
  }
}
