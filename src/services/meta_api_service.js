import crypto from 'crypto';
import { META_CONFIG, PAGE_TAG_MAP, SEDES_GATEWAY, getMetaConfigBySede } from '../config/index.js';
import { fetchConTimeout } from '../utils/http_timeout.js';

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
      const res = await fetchConTimeout(url);
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
    const res = await fetchConTimeout(url, {
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
    const res = await fetchConTimeout(url, {
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
    const res = await fetchConTimeout(url);
    const data = await res.json();
    return data.data || [];
  } catch (e) {
    return [];
  }
}

export async function getConnectedPages() {
  try {
    const url = `${GRAPH_BASE}/me/accounts?fields=id,name,tasks&access_token=${accessToken}`;
    const res = await fetchConTimeout(url);
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
      const meRes = await fetchConTimeout(meUrl);
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
 * [VALIDACION REAL DE CREDENCIAL META, POR SEDE]
 *
 * POR QUE EXISTE: el health reportaba `meta: {isConfigured: true}` calculado como
 * `Boolean(process.env.META_ACCESS_TOKEN_*)`. Eso comprueba que la VARIABLE exista,
 * NO que el token sirva: con los dos tokens vencidos (error 190) el panel seguia
 * diciendo "configurado", y la atribucion publicitaria se perdia en silencio.
 *
 * QUE VALIDA, ademas de la autenticacion:
 *  - `type`: si el token es de USUARIO o de PAGINA. En este negocio los anuncios son
 *    de terceros (Click2Ring y otros proveedores), asi que la atribucion NO depende
 *    de la cuenta publicitaria: depende del TOKEN DE PAGINA, que es el que puede leer
 *    las conversaciones y con ellas el `referral.ad_id` del mensaje.
 *  - `paginas`: cuantas paginas alcanza el token. Si es 0, NO podra leer mensajes,
 *    y sin mensajes no hay `referral` -> la atribucion queda en 'DESCONOCIDO'.
 *  - `permisos`: los scopes realmente otorgados, con foco en `pages_messaging`.
 *
 * @param {string} sedeId 'PALACIOS' | 'BENAVIDES' | ...
 * @returns {Promise<object>} veredicto con motivo
 */
export async function verificarCredencialMeta(sedeId) {
  const sede = String(sedeId || '').toUpperCase().trim();
  const token = SEDES_GATEWAY?.[sede]?.meta?.accessToken;
  if (!token) {
    return { sede, configurada: false, valida: null, detalle: 'sin token configurado' };
  }

  try {
    // 1. Autenticacion basica
    const rMe = await fetchConTimeout(`${GRAPH_BASE}/me?fields=id,name&access_token=${token}`);
    const dMe = await rMe.json();
    if (dMe.error) {
      const code = dMe.error.code;
      const subcode = dMe.error.error_subcode || dMe.error.subcode || null;
      // [DIAGNOSTICO PRECISO] Cuando /me falla NO se puede saber POR QUE con ese
      // error solo. debug_token (que si funciona con un token invalido) revela la
      // causa exacta: tipo de token, fecha de vencimiento y motivo. Sin esto el
      // operador solo veia "token invalido" y no sabia si renovar, pedir permisos
      // o cambiar de tipo de token.
      let diagnostico = null;
      try {
        const appId = SEDES_GATEWAY?.[sede]?.meta?.appId;
        const appSecret = SEDES_GATEWAY?.[sede]?.meta?.appSecret;
        if (appId && appSecret) {
          const rDbg = await fetchConTimeout(`${GRAPH_BASE}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`);
          const dDbg = await rDbg.json();
          const i = dDbg.data;
          if (i) {
            diagnostico = {
              isValido: i.is_valid,
              tipoToken: i.type || null,
              aplicacion: i.application || null,
              emitido: i.issued_at ? new Date(i.issued_at * 1000).toISOString().slice(0, 10) : null,
              expiraEn: i.expires_at ? new Date(i.expires_at * 1000).toISOString().slice(0, 10) : 'permanente',
              diasVencido: i.expires_at && i.expires_at * 1000 < Date.now()
                ? Math.abs(Math.round((Date.now() - i.expires_at * 1000) / 86400000)) : null,
              accesoADatosHasta: i.data_access_expires_at ? new Date(i.data_access_expires_at * 1000).toISOString().slice(0, 10) : null,
              motivoMeta: i.error?.message || null,
              subcodigo: i.error?.subcode || null,
              permisosOtorgados: Array.isArray(i.scopes) ? i.scopes : null
            };
          }
        }
      } catch (e) { /* el diagnostico es un extra, no debe romper el veredicto */ }

      const causa = diagnostico?.subcodigo === 467
        ? 'la SESION DE LA PERSONA se cerro (la persona que genero el token salio de Facebook). Un token de usuario personal muere asi.'
        : diagnostico?.diasVencido
          ? `el token VENCIO hace ${diagnostico.diasVencido} dias.`
          : 'el token fue revocado o es invalido.';

      const detalle = code === 190
        ? `token INVALIDO (code 190): ${causa} RENOVAR${diagnostico?.tipoToken === 'USER' ? ' y migrar a un token de USUARIO DEL SISTEMA (caducidad NUNCA)' : ''}.`
        : code === 102
          ? 'token de sesion invalido (code 102): renovar'
          : `error de Meta (code ${code}): ${String(dMe.error.message || '').slice(0, 120)}`;
      return { sede, configurada: true, valida: false, status: code, subcodigo: subcode, diagnostico, detalle };
    }

    // 2. Paginas alcanzables: es lo que decide si hay atribucion o no
    let paginas = null;
    let nombresPaginas = [];
    let detallePaginas = [];
    try {
      const rPag = await fetchConTimeout(`${GRAPH_BASE}/me/accounts?fields=id,name&limit=25&access_token=${token}`);
      const dPag = await rPag.json();
      if (!dPag.error && Array.isArray(dPag.data)) {
        paginas = dPag.data.length;
        // [LISTA COMPLETA] Antes se truncaba a 8 nombres y era imposible verificar si
        // una pagina concreta (ej. "BioNatural - Ultra") estaba vinculada al System User.
        // Ahora se listan TODAS con su ID para poder auditarlas.
        nombresPaginas = dPag.data.map(p => p.name);
        detallePaginas = dPag.data.map(p => ({ id: String(p.id), nombre: p.name }));
      }
    } catch (e) { /* no critico */ }

    // 3. Permisos realmente otorgados (util para detectar falta de pages_messaging)
    let permisos = null;
    try {
      const rPer = await fetchConTimeout(`${GRAPH_BASE}/me/permissions?access_token=${token}`);
      const dPer = await rPer.json();
      if (!dPer.error && Array.isArray(dPer.data)) {
        permisos = dPer.data.filter(p => p.status === 'granted').map(p => p.permission);
      }
    } catch (e) { /* no critico */ }

    // 4. [FASE 6] Tipo de token y fecha de expiracion (debug_token).
    // Un token de USUARIO expira en ~60 dias; uno de USUARIO DEL SISTEMA puede ser
    // permanente (expires_at = 0). Sin esta comprobacion, la atribucion se muere en
    // silencio cuando vence el token y nadie se entera hasta que los leads salen
    // sin campaña, conjunto ni anuncio.
    let tipoToken = null;
    let expiraEn = null;
    let diasRestantes = null;
    let alerta = null;
    let recomendacion = null;
    try {
      const appId = SEDES_GATEWAY?.[sede]?.meta?.appId;
      const appSecret = SEDES_GATEWAY?.[sede]?.meta?.appSecret;
      if (appId && appSecret) {
        const appToken = `${appId}|${appSecret}`;
        const rDbg = await fetchConTimeout(`${GRAPH_BASE}/debug_token?input_token=${token}&access_token=${appToken}`);
        const dDbg = await rDbg.json();
        const info = dDbg.data;
        if (info && !dDbg.error) {
          tipoToken = info.type || null;
          // [TOKEN PERMANENTE] Un token de USUARIO PERSONAL siempre vence (~60 dias) y
          // ademas muere si esa persona cierra sesion o cambia su contraseña: es la
          // causa de que la atribucion se caiga cada ~2 meses. La solucion definitiva
          // es un token de USUARIO DEL SISTEMA (Business Manager), que se puede
          // generar SIN caducidad (expires_at = 0) porque no depende de una persona.
          if (tipoToken === 'USER') {
            recomendacion = 'token de USUARIO PERSONAL: vence en ~60 dias y muere si esa persona cierra sesion o cambia su contraseña. Migrar a un token de USUARIO DEL SISTEMA (Business Manager) con caducidad NUNCA para no renovar nunca mas.';
          }
          const expMs = info.expires_at ? info.expires_at * 1000 : 0;
          if (expMs > 0) {
            const d = new Date(expMs);
            expiraEn = d.toISOString().slice(0, 10);
            diasRestantes = Math.round((expMs - Date.now()) / 86400000);
            if (diasRestantes <= 15) {
              alerta = diasRestantes <= 0 ? 'token VENCIDO' : `renovar en ${diasRestantes} dias`;
            }
          } else {
            expiraEn = 'permanente';
            diasRestantes = null;
          }
        }
      }
    } catch (e) { /* no critico */ }

    const tieneMessaging = Array.isArray(permisos) ? permisos.includes('pages_messaging') : null;
    const sinPaginas = paginas === 0;

    let detalle = 'credencial valida';
    if (sinPaginas) {
      detalle = 'token valido pero NO alcanza ninguna pagina: sin acceso a conversaciones no habra referral (atribucion en DESCONOCIDO). Asignar paginas al usuario del sistema.';
    } else if (tieneMessaging === false) {
      detalle = 'token valido pero SIN el permiso pages_messaging: no podra leer los mensajes ni su referral.';
    } else if (alerta) {
      detalle = `credencial valida pero ${alerta}: renovar ANTES de que la atribucion se pierda en silencio.`;
    } else if (recomendacion) {
      detalle = `credencial valida, alcanza ${paginas} pagina(s). ATENCION: ${recomendacion}`;
    } else if (paginas !== null && paginas > 0) {
      detalle = `credencial valida, alcanza ${paginas} pagina(s)`;
    }

    return {
      sede,
      configurada: true,
      valida: !sinPaginas && tieneMessaging !== false,
      status: 200,
      usuarioMeta: dMe.name || dMe.id,
      paginasAlcanzadas: paginas,
      nombresPaginas,
      detallePaginas,
      tieneMessaging,
      permisos: permisos ? permisos.slice(0, 12) : null,
      tipoToken,
      expiraEn,
      diasRestantes,
      alerta,
      recomendacion,
      permanente: expiraEn === 'permanente',
      detalle
    };
  } catch (err) {
    return { sede, configurada: true, valida: null, detalle: `no se pudo verificar: ${err.message}` };
  }
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
    const pagesRes = await fetchConTimeout(pagesUrl);
    
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
      const convRes = await fetchConTimeout(convUrl);
      
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
