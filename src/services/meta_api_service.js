import crypto from 'crypto';
import { META_CONFIG, PAGE_TAG_MAP, SEDES_GATEWAY, getMetaConfigBySede } from '../config/index.js';

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
 * Cache en memoria para detalles de anuncios
 * Evita llamar a Graph API múltiples veces para el mismo Ad ID
 */
const adCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hora

/**
 * Extrae y ordena todos los tokens disponibles de Meta (primarios, por sede y contingencia)
 * Garantiza rotación y failover automático ante vencimiento o saturación (HTTP 429).
 */
export function getMetaCandidateTokens(options = {}) {
  let primaryToken = null;
  if (typeof options === 'string') {
    primaryToken = options;
  } else if (options && typeof options === 'object') {
    if (options.token) {
      primaryToken = options.token;
    } else if (options.sede || options.pageId || options.locationId) {
      const metaConf = getMetaConfigBySede(options);
      if (metaConf?.accessToken) {
        primaryToken = metaConf.accessToken;
      }
    }
  }
  if (!primaryToken) primaryToken = accessToken;

  const candidateTokens = [];
  if (primaryToken) candidateTokens.push(primaryToken);

  // 1. Tokens de las sedes (SEDES_GATEWAY)
  if (SEDES_GATEWAY) {
    for (const [, sConf] of Object.entries(SEDES_GATEWAY)) {
      const t = sConf?.meta?.accessToken;
      if (t && !candidateTokens.includes(t)) {
        candidateTokens.push(t);
      }
    }
  }

  // 2. Tokens de contingencia y variables META_ACCESS_TOKEN_* en process.env
  Object.keys(process.env).forEach(key => {
    if (key.startsWith('META_ACCESS_TOKEN') || key === 'META_BACKUP_TOKENS') {
      const val = process.env[key];
      if (val) {
        val.split(',').map(s => s.trim()).filter(Boolean).forEach(tok => {
          if (!candidateTokens.includes(tok)) candidateTokens.push(tok);
        });
      }
    }
  });

  return candidateTokens;
}

/**
 * 1. Consultar Metadatos Reales de un Anuncio en Meta Graph API
 * Extrae: Nombre de Campaña, Conjunto de Anuncios y Título del Creativo
 * Enruta dinámicamente a la Meta App de la sede respectiva para no saturar cuotas,
 * con failover automático a tokens secundarios en caso de rate-limiting (HTTP 429) o caducidad.
 */
export async function getMetaAdDetails(adId, options = {}) {
  if (!adId || adId === 'N/A') return null;

  const now = Date.now();
  if (adCache.has(adId)) {
    const cached = adCache.get(adId);
    if (now - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }
  }

  // Resolver pool de tokens candidatos para balanceo y contingencia
  const candidateTokens = getMetaCandidateTokens(options);

  // Probar candidateTokens en orden
  for (const token of candidateTokens) {
    if (!token) continue;
    try {
      const url = `${GRAPH_BASE}/${adId}?fields=id,name,campaign{id,name},adset{id,name},creative{id,title,body}&access_token=${token}`;
      if (global.apiCounters) global.apiCounters.meta++;
      const res = await fetch(url);
      if (!res.ok) {
        // En caso de rate-limit (429), token expirado (190) o error de app, reintentar con siguiente token
        continue;
      }
      const data = await res.json();
      if (!data || data.error) continue;

      const details = {
        adId: data.id,
        adName: data.name || 'Anuncio Meta',
        campaignId: data.campaign?.id || null,
        campaignName: data.campaign?.name || 'Campaña Meta',
        adsetId: data.adset?.id || null,
        adsetName: data.adset?.name || 'Conjunto de Anuncios',
        creativeTitle: data.creative?.title || data.creative?.body || 'Creativo'
      };

      adCache.set(adId, { timestamp: now, data: details });
      return details;
    } catch (err) {
      // Error de red puntual, continuar con el siguiente token
      continue;
    }
  }

  return null;
}

/**
 * 2. Exclusión Automática de Leads en Meta Custom Audience
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

    if (global.pushLiveLog) global.pushLiveLog(`Exclusión CAPI: Ocultando anuncios para un lead...`);
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
 * 3. Conversions API (CAPI) de Servidor
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

    if (global.pushLiveLog) global.pushLiveLog(`Meta CAPI: Evento [${eventName}] enviado.`);
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
 * 5. Diagnóstico de Conexión Meta Developers Multi-Token
 */
export async function testMetaConnection() {
  const candidateTokens = getMetaCandidateTokens();
  if (candidateTokens.length === 0) return { isConfigured: false, message: 'No hay tokens de Meta configurados.' };

  const results = [];
  for (const tok of candidateTokens) {
    try {
      const meUrl = `${GRAPH_BASE}/me?fields=id,name&access_token=${tok}`;
      const meRes = await fetch(meUrl);
      const meData = await meRes.json();
      if (!meData.error && meData.id) {
        results.push({
          tokenSnippet: tok.substring(0, 15) + '...',
          isValid: true,
          name: meData.name,
          id: meData.id
        });
      } else {
        results.push({
          tokenSnippet: tok.substring(0, 15) + '...',
          isValid: false,
          error: meData.error?.message || 'Error de autenticación'
        });
      }
    } catch (err) {
      results.push({
        tokenSnippet: tok.substring(0, 15) + '...',
        isValid: false,
        error: err.message
      });
    }
  }

  const validCount = results.filter(r => r.isValid).length;
  return {
    isConfigured: true,
    totalTokens: candidateTokens.length,
    validTokens: validCount,
    primaryValid: results[0]?.isValid || false,
    details: results
  };
}

/**
 * 6. Patrullero Directo de Meta (Inbox Scanner)
 * Identifica mensajes duplicados directamente en el origen que GHL pueda haber omitido.
 */
export async function scanMetaInboxForDuplicates() {
  if (!accessToken) return;
  
  try {
    if (global.pushLiveLog) global.pushLiveLog(`[META_API] [INFO] Iniciando patrullaje profundo en Meta API (Inbox)...`);
    
    // Obtenemos las páginas conectadas primero
    const pagesUrl = `${GRAPH_BASE}/me/accounts?access_token=${accessToken}`;
    if (global.apiCounters) global.apiCounters.meta++;
    const pagesRes = await fetch(pagesUrl);
    
    if (!pagesRes.ok) {
       if (global.pushLiveLog) global.pushLiveLog(`[META_API] [WARN] Meta API bloqueó el escaneo profundo (Revisar Token).`);
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
           if (global.pushLiveLog) global.pushLiveLog(`[META_API] [WARN] Patrullero Meta detectó ${duplicates.length} usuarios con spam/doble acción en ${page.name}`);
        }
      }
    }
    
    if (global.pushLiveLog) global.pushLiveLog(`[META_API] [INFO] Patrullaje Meta finalizado. ${totalConversationsScanned} hilos revisados en origen.`);
    
  } catch (err) {
    console.error("[Meta Inbox Scanner] Error:", err.message);
  }
}
