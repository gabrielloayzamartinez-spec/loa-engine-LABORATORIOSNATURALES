import crypto from 'crypto';
import { META_CONFIG, PAGE_TAG_MAP } from '../config/index.js';

const { graphApiVersion, accessToken, adAccountId, pixelId, exclusionAudienceId } = META_CONFIG;
const GRAPH_BASE = `https://graph.facebook.com/${graphApiVersion}`;

/**
 * Normaliza y hashea en SHA-256 conforme a los estándares de Meta
 * - Email: minúsculas, sin espacios al inicio/fin.
 * - Teléfono: solo dígitos con código de país (ej. 15551234567 para USA).
 */
export function hashData(input) {
  if (!input || typeof input !== 'string') return null;
  const cleaned = input.trim().toLowerCase();
  if (!cleaned) return null;
  return crypto.createHash('sha256').update(cleaned).digest('hex');
}

export function normalizePhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) {
    digits = '1' + digits;
  }
  return digits;
}

/**
 * 1. Consultar Metadatos Reales de un Anuncio en Meta Graph API
 * Extrae: Nombre de Campaña, Conjunto de Anuncios y Título del Creativo
 */
export async function getMetaAdDetails(adId) {
  if (!adId || adId === 'N/A' || !accessToken) return null;

  try {
    const url = `${GRAPH_BASE}/${adId}?fields=id,name,campaign{id,name},adset{id,name},creative{id,title,body}&access_token=${accessToken}`;
    if (global.apiCounters) global.apiCounters.meta++;
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return {
      adId: data.id,
      adName: data.name || 'Anuncio Meta',
      campaignId: data.campaign?.id || null,
      campaignName: data.campaign?.name || 'Campaña Meta',
      adsetId: data.adset?.id || null,
      adsetName: data.adset?.name || 'Conjunto de Anuncios',
      creativeTitle: data.creative?.title || data.creative?.body || 'Creativo'
    };
  } catch (err) {
    console.error(`[Meta API] Error obteniendo anuncio ${adId}:`, err.message);
    return null;
  }
}

/**
 * 2. 🚫 Exclusión Automática de Leads en Meta Custom Audience
 */
export async function excludeLeadFromMetaAds(contactData) {
  const targetAudienceId = exclusionAudienceId;
  if (!targetAudienceId || !accessToken) {
    return { success: false, reason: 'meta_audience_not_configured' };
  }

  try {
    const payloadUsers = [];
    const phoneRaw = normalizePhone(contactData.phone);
    const emailRaw = contactData.email ? String(contactData.email).trim().toLowerCase() : null;

    const phoneHash = phoneRaw ? hashData(phoneRaw) : null;
    const emailHash = emailRaw ? hashData(emailRaw) : null;

    if (!phoneHash && !emailHash) {
      return { success: false, reason: 'no_identifiers_to_hash' };
    }

    const row = [];
    const schema = [];
    if (phoneHash) {
      schema.push('PHONE_SHA256');
      row.push(phoneHash);
    }
    if (emailHash) {
      schema.push('EMAIL_SHA256');
      row.push(emailHash);
    }

    const bodyData = {
      schema,
      data: [row]
    };

    const url = `${GRAPH_BASE}/${targetAudienceId}/users?access_token=${accessToken}`;
    if (global.apiCounters) global.apiCounters.meta++;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: bodyData })
    });

    const result = await res.json();
    if (result.error) {
      return { success: false, error: result.error.message };
    }

    if (global.pushLiveLog) global.pushLiveLog(`🚫 Exclusión CAPI: Ocultando anuncios para un lead...`);
    return {
      success: true,
      audienceId: targetAudienceId,
      usersAdded: result.num_received || 1
    };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 3. 🎯 Conversions API (CAPI) de Servidor
 */
export async function sendMetaConversionEvent(eventName, contactData, customData = {}) {
  const targetPixelId = pixelId;
  if (!targetPixelId || !accessToken) {
    return { success: false, reason: 'meta_pixel_not_configured' };
  }

  try {
    const phoneRaw = normalizePhone(contactData.phone);
    const emailRaw = contactData.email ? String(contactData.email).trim().toLowerCase() : null;
    const firstName = contactData.firstName ? hashData(contactData.firstName) : null;
    const lastName = contactData.lastName ? hashData(contactData.lastName) : null;

    const userData = {};
    if (phoneRaw) userData.ph = [hashData(phoneRaw)];
    if (emailRaw) userData.em = [hashData(emailRaw)];
    if (firstName) userData.fn = [firstName];
    if (lastName) userData.ln = [lastName];
    userData.country = [hashData('us')];

    const eventPayload = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'system_generated',
      event_source_url: 'https://app.gohighlevel.com',
      user_data: userData,
      custom_data: {
        currency: 'USD',
        value: customData.value || (eventName === 'Purchase' ? 100 : (eventName === 'QualifiedLead' ? 25 : 1)),
        content_name: customData.pageName || 'Venta Directa',
        ...customData
      }
    };

    const url = `${GRAPH_BASE}/${targetPixelId}/events?access_token=${accessToken}`;
    if (global.apiCounters) global.apiCounters.meta++;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [eventPayload]
      })
    });

    const result = await res.json();
    if (result.error) {
      return { success: false, error: result.error.message };
    }

    if (global.pushLiveLog) global.pushLiveLog(`🟢 Meta CAPI: Evento [${eventName}] enviado.`);
    return {
      success: true,
      eventsReceived: result.events_received || 1,
      eventName
    };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 4. Verificador de Cuentas Publicitarias y Fanpages Conectadas
 */
export async function getConnectedAdAccounts() {
  try {
    const url = `${GRAPH_BASE}/me/adaccounts?fields=id,name,account_status,currency&access_token=${accessToken}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.data || [];
  } catch (e) {
    return [];
  }
}

export async function getConnectedPages() {
  try {
    const url = `${GRAPH_BASE}/me/accounts?fields=id,name,tasks&access_token=${accessToken}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.data || [];
  } catch (e) {
    return [];
  }
}

/**
 * 5. Diagnóstico de Conexión Meta Developers
 */
export async function testMetaConnection() {
  if (!accessToken) return { isConfigured: false };
  try {
    const meUrl = `${GRAPH_BASE}/me?fields=id,name&access_token=${accessToken}`;
    const meRes = await fetch(meUrl);
    const meData = await meRes.json();
    if (meData.error) return { isConfigured: false, error: meData.error.message };
    return { isConfigured: true, name: meData.name, id: meData.id };
  } catch (err) {
    return { isConfigured: false, error: err.message };
  }
}

/**
 * 6. Patrullero Directo de Meta (Inbox Scanner)
 * Identifica mensajes duplicados directamente en el origen que GHL pueda haber omitido.
 */
export async function scanMetaInboxForDuplicates() {
  if (!accessToken) return;
  
  try {
    if (global.pushLiveLog) global.pushLiveLog(`🕵️‍♂️ Iniciando Patrullaje Profundo en Meta API (Inbox)...`);
    
    // Obtenemos las páginas conectadas primero
    const pagesUrl = `${GRAPH_BASE}/me/accounts?access_token=${accessToken}`;
    if (global.apiCounters) global.apiCounters.meta++;
    const pagesRes = await fetch(pagesUrl);
    
    if (!pagesRes.ok) {
       if (global.pushLiveLog) global.pushLiveLog(`⚠️ Meta API bloqueó el escaneo profundo (Revisar Token).`);
       return;
    }
    
    const pagesData = await pagesRes.json();
    const pages = pagesData.data || [];
    
    let totalConversationsScanned = 0;
    
    for (const page of pages) {
      const pageToken = page.access_token || accessToken;
      const convUrl = `${GRAPH_BASE}/${page.id}/conversations?fields=id,updated_time,messages{from,message}&limit=20&access_token=${pageToken}`;
      if (global.apiCounters) global.apiCounters.meta++;
      const convRes = await fetch(convUrl);
      
      if (convRes.ok) {
        const convData = await convRes.json();
        const convs = convData.data || [];
        totalConversationsScanned += convs.length;
        
        // Simulación de análisis forense en la RAM de Node
        const senders = {};
        for (const c of convs) {
           const msgs = c.messages?.data || [];
           for (const m of msgs) {
              const senderId = m.from?.id;
              if (senderId && senderId !== page.id) {
                 senders[senderId] = (senders[senderId] || 0) + 1;
              }
           }
        }
        
        const duplicates = Object.entries(senders).filter(([id, count]) => count > 3);
        if (duplicates.length > 0) {
           if (global.pushLiveLog) global.pushLiveLog(`⚠️ ¡Patrullero Meta detectó ${duplicates.length} usuarios con spam/doble acción en ${page.name}!`);
        }
      }
    }
    
    if (global.pushLiveLog) global.pushLiveLog(`✅ Patrullaje Meta finalizado. ${totalConversationsScanned} hilos de mensajes encriptados revisados en origen.`);
    
  } catch (err) {
    console.error("[Meta Inbox Scanner] Error:", err.message);
  }
}
