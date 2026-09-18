import { GHL_CONFIG, FB_PAGE_ID_MAP, PAGE_TAG_MAP, PALACIOS_USERS, SEDES_GATEWAY, resolveSedeContext, getGhlHeaders, resolveSedeCustomFields } from '../config/index.js';
import { ghlFetch, GHL_HEADERS } from '../utils/ghl_http_client.js';
import { analyzeSymptoms, extractShippingData, buildVtigerSource, resolveLeadProvider, resolveLeadSede, resolveLeadChannel, inferTreatmentFromCampaignOrUtm, isValidMetaAdId, isAdsetCandidate } from './nlp_symptom_engine.js';
import { isContextualDuplicate } from './fuzzy_matcher.js';
import { findVTigerContact } from '../services/vtiger_api_service.js';
import { learningBrain } from '../services/learning_brain.js';
import { buildSanitizedCommercialFields, evaluateCommercialTruth } from '../domain/commercial_engine.js';
import { syncUnifiedPipelineOpportunity } from '../services/ghl_opportunity_service.js';
import { getMetaAdDetails } from '../services/meta_api_service.js';

const { apiKey, locationId } = GHL_CONFIG;

/**
 * 📌 Save Process: Inyecta una Nota Histórica en el perfil de GHL ante un nuevo toque o cambio de pauta
 */
export function buildAdHistoryNoteBody({
  dateStr,
  newAdId,
  oldAdId,
  oldAdDate,
  previousSede,
  previousCampaign,
  previousTreatment,
  campaign,
  pageName,
  clickCount,
  source,
  treatment,
  isDoubleAdEntry = false,
  isGraceExpired = true,
  isMudanzaDeSede = false
}) {
  const formattedDate = dateStr || new Date().toLocaleString('es-PE', { timeZone: 'America/New_York' });
  const isDiffAd = Boolean(oldAdId && oldAdId !== 'Ninguna previa' && oldAdId !== 'Ninguna previa (Orgánico)' && oldAdId !== newAdId);
  const noteTitle = isDiffAd
    ? `🚨 [SAVE PROCESS: REINGRESO POR NUEVO ANUNCIO / CAMPAÑA DIFERENTE]`
    : `[SAVE PROCESS: Ruteo y Diagnostico de Pauta]`;

  let interaccionText = `Clic #${clickCount || 1}`;
  if (isDiffAd || isDoubleAdEntry) {
    const datePart = oldAdDate ? `  ${oldAdDate}` : '';
    let contextPart = '';
    if (isMudanzaDeSede || previousSede === 'OTRA SEDE') {
      contextPart = '  (OTRA SEDE)';
    } else {
      const cleanPrevSede = previousSede || 'PALACIOS';
      const campSnippet = previousCampaign ? ` - ${previousCampaign.substring(0, 32)}` : '';
      const cleanTreatment = (previousTreatment && previousTreatment !== 'General') ? ` - ${previousTreatment}` : (previousTreatment ? ` - ${previousTreatment}` : '');
      contextPart = `  (${cleanPrevSede}${campSnippet}${cleanTreatment})`;
    }
    const vigenciaPart = ` ("${isGraceExpired ? 'tiempo de gracia expirado' : 'vigencia activa'}")`;
    
    const adLabel = isDiffAd
      ? `Anuncio / Campaña Previa: ${oldAdId}`
      : `Anuncio: ${newAdId}`;

    interaccionText = `DOBLE INGRESO PUBLICITARIO - ${adLabel}${datePart}${contextPart}${vigenciaPart}`;
  } else if (!oldAdId || oldAdId.includes('Orgánico')) {
    interaccionText = `1er Ingreso Publicitario tras Tráfico Orgánico`;
  }

  const estadoPautaText = isDiffAd
    ? `ACTUALIZADO (Ad ID y Origen renovados por nuevo anuncio)`
    : (newAdId ? `VINCULADO (Ad ID y Origen asignados)` : `ORGÁNICO (Sin costo publicitario)`);

  return `${noteTitle}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Fecha: ${formattedDate} (EST)
- Origen/Fuente Asignada: ${source || 'N/A'}
- Tratamiento Detectado: ${treatment || 'General'}
- Nuevo Ad ID: ${newAdId || 'Orgánico / Sin Ad'}
- Fanpage de Entrada: ${pageName || 'N/A'}
- Campaña Detectada: ${campaign || 'N/A'}
- Interacción: ${interaccionText}
- Estado de Pauta: ${estadoPautaText}
----------------------------------------
Powered by LOA Engine - Gabriel Loayza`;
}

export async function saveAdHistoryNote(contactId, params, options = {}) {
  const noteBody = buildAdHistoryNoteBody(params);
  const targetHeaders = options.headers || getGhlHeaders({ locationId: options.locationId || locationId });

  try {
    const noteUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;
    await fetchWithRetry(noteUrl, {
      method: 'POST',
      headers: targetHeaders,
      body: JSON.stringify({ body: noteBody })
    });
    console.log(`[Agente 4 Save Process] [NOTE] Nota histórica inyectada para contacto ${contactId}`);
    return noteBody;
  } catch (err) {
    console.error(`[Agente 4 Save Process Error]:`, err.message);
    return null;
  }
}

/**
 * 📌 Save Process: Inyecta una Nota Histórica de MUDANZA DE SEDE AUTORIZADA en GHL
 */
export async function saveMudanzaHistoryNote(contactId, params = {}, options = {}) {
  // En la arquitectura multi-tenant de subcuentas aisladas, cada subcuenta es soberana
  // y la mudanza de sede no existe. Preservado como no-op seguro para retrocompatibilidad.
  return null;
}

const HEADERS = GHL_HEADERS;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let liveRateLimitBlockedUntil = 0;
let backgroundRateLimitBlockedUntil = 0;

// fetchWithRetry ahora es un wrapper delgado sobre ghlFetch (centralizado en ghl_http_client.js)
async function fetchWithRetry(url, options, attempt = 1, _isLive = false) {
  return ghlFetch(url, options, attempt, 'Agente 3');
}

// Mapa para controlar reintentos por delay de indexación
const indexingRetries = new Map();

// 🔒 LOCK POR CONTACTO: Evita que el Radar y el Reverse Sync hagan PUT simultáneo al mismo contacto
const contactLocks = new Set();
const MAX_LOCK_WAIT_MS = 15000; // Máximo 15 segundos esperando un lock

async function acquireContactLock(contactId) {
  const start = Date.now();
  while (contactLocks.has(contactId)) {
    if (Date.now() - start > MAX_LOCK_WAIT_MS) {
      console.warn(`[Lock Guard] [WARN] Lock timeout para ${contactId}. Forzando liberación.`);
      contactLocks.delete(contactId);
      break;
    }
    await sleep(200);
  }
  contactLocks.add(contactId);
}

function releaseContactLock(contactId) {
  contactLocks.delete(contactId);
}

// Exportar para que vtiger_sync_agent.js también use el mismo lock
export { acquireContactLock, releaseContactLock };

/**
 * Agente 3: Chat Router
 * Evalúa los últimos mensajes de un contacto para enrutar el chat a la sede correcta,
 * aplicando una regla "Anti-Vivazos" (cooldown de 24 horas) para evitar rebotes entre oficinas.
 */
export async function routeChatByContact(contactId, isLive = false, isDryRun = false, options = {}) {
  await acquireContactLock(contactId);
  try {
    console.log(`[Agente 3] Analizando ruteo para el contacto ${contactId}... (Live: ${isLive}, DryRun: ${isDryRun})`);

    let activeLocationId = options.locationId || SEDES_GATEWAY.PALACIOS.ghl.locationId;
    let activeHeaders = options.headers || getGhlHeaders({ locationId: activeLocationId, sede: options.sede });

    // 🛡️ CENTRAL GUARD: La cuenta Central Universal se mantiene conectada para referencia/bóveda pero SIN ruteos activos
    const activeContext = resolveSedeContext({ locationId: activeLocationId });
    if (activeContext && activeContext.allowActiveRouting === false) {
      console.log(`[Agente 3] [CENTRAL GUARD] Ubicación ${activeLocationId} (${activeContext.name}) es Central Universal pasiva. Omitiendo ruteos activos.`);
      return 'UNCHANGED';
    }

    // 1. Cargar contacto de GHL UNA SOLA VEZ con detección y fallback de subcuenta (Palacios <-> Benavides)
    let contactRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: activeHeaders }, 1, isLive);

    if (contactRes.status === 403 || contactRes.status === 404) {
      const altLocId = activeLocationId === SEDES_GATEWAY.PALACIOS.ghl.locationId ? SEDES_GATEWAY.BENAVIDES.ghl.locationId : SEDES_GATEWAY.PALACIOS.ghl.locationId;
      const altHeaders = getGhlHeaders({ locationId: altLocId });
      const altRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: altHeaders }, 1, isLive);
      if (altRes.status === 200) {
        contactRes = altRes;
        activeLocationId = altLocId;
        activeHeaders = altHeaders;
        console.log(`[Agente 3] [MULTI-SEDE] Contacto ${contactId} resuelto en subcuenta ${activeLocationId}`);
      }
    }

    if (contactRes.status !== 200) {
      console.log(`[Agente 3] No se pudo obtener el contacto ${contactId}. Status: ${contactRes.status}`);
      if (contactRes.status >= 500) return 'RETRY';
      return;
    }

    const contactData = await contactRes.json();
    const contact = contactData.contact || contactData;
    if (contact.locationId && contact.locationId !== activeLocationId) {
      activeLocationId = contact.locationId;
      activeHeaders = getGhlHeaders({ locationId: activeLocationId });
    }

    // 2. Obtener la conversación del contacto
    const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${activeLocationId}&contactId=${contactId}`;
    const convRes = await fetchWithRetry(convUrl, { headers: activeHeaders }, 1, isLive);
    
    let allMessages = [];
    let fbMessages = [];

    if (convRes.status === 200) {
      const convData = await convRes.json();
      const conversations = convData.conversations || [];
      
      if (conversations.length > 0) {
        const convId = conversations[0].id;
        const msgUrl = `https://services.leadconnectorhq.com/conversations/${convId}/messages?locationId=${activeLocationId}&limit=20`;
        const msgRes = await fetchWithRetry(msgUrl, { headers: activeHeaders }, 1, isLive);
        
        if (msgRes.status === 200) {
          const msgData = await msgRes.json();
          allMessages = msgData.messages?.messages || [];
          allMessages.sort((a, b) => new Date(b.dateAdded).getTime() - new Date(a.dateAdded).getTime());

          for (const m of allMessages) {
            const fbMeta = m.meta?.fb || {};
            const pageId = fbMeta.fromPageId || fbMeta.pageId;
            if (pageId) {
              const rawAd = fbMeta.adId || fbMeta.ad_id || m.meta?.referral?.ad_id || m.meta?.referral?.adId;
              const validAd = rawAd && rawAd !== 'N/A' && isValidMetaAdId(rawAd) ? String(rawAd).trim() : null;
              fbMessages.push({
                id: m.id,
                pageId: String(pageId),
                timestamp: new Date(m.dateAdded).getTime(),
                dateStr: m.dateAdded,
                adId: validAd
              });
            }
          }
          fbMessages.sort((a, b) => b.timestamp - a.timestamp);
        }
      } else {
        console.log(`[Agente 3] [FAST-PATH] Sin conversaciones indexadas aún para ${contactId}. Procesando y asignando directamente por subcuenta (${activeLocationId}).`);
      }
    } else {
      console.log(`[Agente 3] [FAST-PATH] Conversaciones no disponibles (Status ${convRes.status}). Ruteando directamente por subcuenta.`);
    }

    let targetPageId = null;
    let targetPageName = null;
    const newestMsg = fbMessages.length > 0 ? fbMessages[0] : null;

    if (newestMsg) {
      // El mensaje más reciente dicta a qué página acaba de escribir el usuario
      targetPageId = newestMsg.pageId;
      targetPageName = FB_PAGE_ID_MAP[targetPageId];
    }

    // Fallback: Si no se determinó por mensaje de Facebook, verificar si el contacto ya tiene etiquetas de sede
    if (!targetPageName) {
      const tags = (contact.tags || []).map(t => String(t).toLowerCase());
      for (const [pName, tag] of Object.entries(PAGE_TAG_MAP)) {
        if (tags.includes(tag.toLowerCase())) {
          targetPageName = pName;
          break;
        }
      }
    }

    if (!targetPageName) {
      if (activeLocationId === SEDES_GATEWAY.BENAVIDES.ghl.locationId) {
        targetPageName = "Naturales Bio Corp";
      } else {
        targetPageName = "Naturales BioNatural";
      }
    }

    // 🏢 Resolver Sede Actual de la Fanpage / Mensaje
    let currentSedeName = resolveLeadSede({
      pageId: targetPageId,
      pageName: targetPageName
    });
    if (!currentSedeName) {
      currentSedeName = (activeLocationId === SEDES_GATEWAY.BENAVIDES.ghl.locationId) ? 'BENAVIDES' : 'PALACIOS';
    }

    // Determinar a qué asesor le corresponde esta página (por Sede, Page ID o por Nombre de Fanpage)
    let targetAdvisorId = null;
    let targetAdvisorName = null;

    const resolvedSede = resolveSedeContext({ pageId: targetPageId, sede: currentSedeName, locationId: activeLocationId });
    if (resolvedSede && resolvedSede.users) {
      if (resolvedSede.sedeId === 'BENAVIDES') {
        if (targetPageId === '510617778807469' || targetPageName?.toLowerCase().includes('corp')) {
          targetAdvisorId = resolvedSede.users.redes1.id;
          targetAdvisorName = resolvedSede.users.redes1.name;
        } else {
          targetAdvisorId = resolvedSede.users.redes2.id;
          targetAdvisorName = resolvedSede.users.redes2.name;
        }
      } else if (resolvedSede.sedeId === 'PALACIOS') {
        if (targetPageId === '111906554968800' || targetPageName?.toLowerCase().includes('ultra')) {
          targetAdvisorId = resolvedSede.users.ultra.id;
          targetAdvisorName = resolvedSede.users.ultra.name;
        } else {
          targetAdvisorId = resolvedSede.users.ernesto.id;
          targetAdvisorName = resolvedSede.users.ernesto.name;
        }
      }
    }

    // Fallback general contextual por subcuenta activa (NUNCA mezclar asesores de otra subcuenta)
    if (!targetAdvisorId) {
      if (activeLocationId === SEDES_GATEWAY.BENAVIDES.ghl.locationId) {
        targetAdvisorId = SEDES_GATEWAY.BENAVIDES.users.redes1.id;
        targetAdvisorName = SEDES_GATEWAY.BENAVIDES.users.redes1.name;
      } else {
        targetAdvisorId = SEDES_GATEWAY.PALACIOS.users.ernesto.id;
        targetAdvisorName = SEDES_GATEWAY.PALACIOS.users.ernesto.name;
      }
    }

    // 🛡️ BLINDAJE MULTI-SEDE ESTRICTO: Un contacto en Benavides solo puede asignarse a un usuario de Benavides
    if (activeLocationId === SEDES_GATEWAY.BENAVIDES.ghl.locationId) {
      const benavidesUserIds = [
        SEDES_GATEWAY.BENAVIDES.users.redes1.id,
        SEDES_GATEWAY.BENAVIDES.users.redes2.id
      ];
      if (!benavidesUserIds.includes(targetAdvisorId)) {
        console.warn(`[Agente 3] [GUARD] Prevenida asignación errónea de asesor (${targetAdvisorId}) en Benavides. Corrigiendo a REDES 1 BENAVIDES.`);
        targetAdvisorId = SEDES_GATEWAY.BENAVIDES.users.redes1.id;
        targetAdvisorName = SEDES_GATEWAY.BENAVIDES.users.redes1.name;
      }
    } else if (activeLocationId === SEDES_GATEWAY.PALACIOS.ghl.locationId) {
      const palaciosUserIds = [
        SEDES_GATEWAY.PALACIOS.users.ultra.id,
        SEDES_GATEWAY.PALACIOS.users.ernesto.id
      ];
      if (!palaciosUserIds.includes(targetAdvisorId)) {
        console.warn(`[Agente 3] [GUARD] Prevenida asignación errónea de asesor (${targetAdvisorId}) en Palacios. Corrigiendo a REDES PALACIOS ERNESTO.`);
        targetAdvisorId = SEDES_GATEWAY.PALACIOS.users.ernesto.id;
        targetAdvisorName = SEDES_GATEWAY.PALACIOS.users.ernesto.name;
      }
    }

    if (!targetAdvisorId) {
      console.log(`[Agente 3] No se encontró un asesor asignado para la página ${targetPageName}.`);
      return;
    }

    indexingRetries.delete(contactId); // Limpiar reintentos en caso de éxito

    const existingTags = (contact.tags || []).map(t => String(t).toLowerCase());
    const isCustomerWon = existingTags.includes('cliente-comprador') || existingTags.includes('venta-cerrada');

    // 4. MULTI-SEDE INDEPENDIENTE: OMISIÓN DE TIEMPO DE GRACIA ARTIFICIAL
    // Cada sede opera como entidad independiente en su propia subcuenta.
    // Se detecta si existió toque en otra fanpage previa con fines de auditoría forense,
    // pero sin abortar el procesamiento ni bloquear la asignación legítima.
    let expiredGraceMsg = null;
    let expiredTimeDiffHours = 0;

    if (newestMsg && fbMessages.length > 1) {
      for (const msg of fbMessages) {
        if (msg.pageId !== targetPageId) {
          const timeDiffHours = (newestMsg.timestamp - msg.timestamp) / (1000 * 60 * 60);
          expiredGraceMsg = msg;
          expiredTimeDiffHours = timeDiffHours;
          break;
        }
      }
    }

    // 🛡️ ESCUDO TOTAL DE INTERACCIÓN ACTIVA (UX GUARD):
    // Si el contacto YA está asignado a un asesor y EL ASESOR ha respondido en los últimos 15 min,
    // CONGELAMOS la asignación para no interrumpir una venta en vivo.
    // NOTA: Solo miramos los mensajes salientes (outbound) para saber si el humano está chateando.
    let isLiveChatting = false;
    if (contact.assignedTo) {
      let newestOutboundTimestamp = 0;
      for (const m of allMessages) {
        if (m.direction === 'outbound' || m.type === 2) { // 2 suele ser outbound en GHL
          const t = new Date(m.dateAdded).getTime();
          if (t > newestOutboundTimestamp) newestOutboundTimestamp = t;
        }
      }

      if (newestOutboundTimestamp > 0) {
        const minutesSinceLastAdvisorMsg = (Date.now() - newestOutboundTimestamp) / (1000 * 60);
        if (minutesSinceLastAdvisorMsg < 3) {
          isLiveChatting = true;
          console.log(`[Agente 3] [UX-GUARD] Chat reciente detectado (< 3 min). Se omitirá la reasignación visual para no interrumpir al asesor, pero se actualizarán etiquetas en segundo plano.`);
        }
      }
    }

    // Custom Field IDs Oficiales Dinámicos por Subcuenta
    const sedeFields = resolveSedeCustomFields({ locationId: activeLocationId });
    const ID_ANUNCIO_FIELD = sedeFields.idAnuncio;
    const AD_ID_ALT_FIELD = sedeFields.adIdAlt;
    const TRATAMIENTO_FIELD = sedeFields.tratamientoComprado;
    const VTIGER_NOTAS_FIELD = sedeFields.historialCompleto;
    const UTM_SOURCE_FIELD = sedeFields.utmSource;
    const UTM_MEDIUM_FIELD = sedeFields.utmMedium;
    const UTM_CAMPAIGN_FIELD = sedeFields.utmCampaign;
    const UTM_CONTENT_FIELD = sedeFields.utmContent;
    const UTM_TERM_FIELD = sedeFields.utmTerm;
    const ADSET_ID_FIELD = sedeFields.adsetId;
    const SEDE_ASIGNADA_FIELD = sedeFields.sedeAsignada;
    const ORIGEN_LEAD_FIELD = sedeFields.origenLead;
    const TIENE_TELEFONO_FIELD = sedeFields.tieneTelefono;
    const ULTIMA_INTERACCION_FIELD = sedeFields.ultimaInteraccion;

    const existingCustomFields = contact.customFields || [];
    const rawCurrentAdId = existingCustomFields.find(f => (f.id === ID_ANUNCIO_FIELD || f.id === AD_ID_ALT_FIELD) && f.value)?.value;
    const currentAdId = isValidMetaAdId(rawCurrentAdId) ? String(rawCurrentAdId).trim() : null;
    const currentTratamiento = existingCustomFields.find(f => f.id === TRATAMIENTO_FIELD && f.value)?.value;
    const currentVtigerNota = existingCustomFields.find(f => f.id === VTIGER_NOTAS_FIELD && f.value)?.value;

    // 🎯 A. FRESHNESS FIRST: DETECCIÓN DEL AD ID, ADSET (CONJUNTO DE ANUNCIOS), CAMPAÑA Y UTMS
    let latestAdId = null;
    let latestCampaign = null;
    let latestMedium = null;
    let latestAdSetName = null;

    // 1. Mensajes de Facebook más recientes (prioridad máxima para Ad ID)
    for (const m of allMessages) {
      const fbMeta = m.meta?.fb || {};
      const rawAd = fbMeta.adId || fbMeta.ad_id || m.meta?.referral?.ad_id || m.meta?.referral?.adId;
      if (rawAd && rawAd !== 'N/A' && isValidMetaAdId(rawAd)) {
        latestAdId = String(rawAd).trim();
        break;
      }
    }

    // 2. Recopilar todas las fuentes de atribución disponibles en GHL ordenadas por recencia
    const attributionSources = [];
    if (contact.attributionSource) attributionSources.push(contact.attributionSource);
    if (contact.attributions && Array.isArray(contact.attributions)) {
      attributionSources.push(...[...contact.attributions].reverse());
    }
    if (contact.lastAttributionSource) attributionSources.push(contact.lastAttributionSource);

    for (const attr of attributionSources) {
      if (!attr) continue;

      // Ad ID
      const rawAttrId = attr.utmAdId || attr.adId;
      if (!latestAdId && isValidMetaAdId(rawAttrId)) latestAdId = String(rawAttrId).trim();

      // Campaña
      if (!latestCampaign && (attr.utmCampaign || attr.campaign)) {
        latestCampaign = attr.utmCampaign || attr.campaign;
      }

      // Medium
      if (!latestMedium && attr.utmMedium) {
        latestMedium = attr.utmMedium;
      }

      // 🎯 Detección de Nombre de Conjunto de Anuncios (AdSet Name)
      // Meta Ads / GHL puede almacenar el AdSet en utmMedium, utmTerm, utmContent o adsetName
      if (!latestAdSetName) {
        if (isAdsetCandidate(attr.utmMedium)) {
          latestAdSetName = String(attr.utmMedium).trim();
        } else if (isAdsetCandidate(attr.utmTerm)) {
          latestAdSetName = String(attr.utmTerm).trim();
        } else if (isAdsetCandidate(attr.utmContent)) {
          latestAdSetName = String(attr.utmContent).trim();
        } else if (isAdsetCandidate(attr.adsetName || attr.adSetName)) {
          latestAdSetName = String(attr.adsetName || attr.adSetName).trim();
        }
      }
    }

    // Fallback de AdSet desde campos personalizados existentes si ya se guardó previamente
    if (!latestAdSetName) {
      const existingAdset = existingCustomFields.find(f => (f.id === ADSET_ID_FIELD || f.id === UTM_TERM_FIELD) && f.value)?.value;
      if (isAdsetCandidate(existingAdset)) {
        latestAdSetName = String(existingAdset).trim();
      }
    }

    // 🧠 B. ANÁLISIS INTELIGENTE DE SÍNTOMAS (NLP + LEARNING BRAIN) Y DATOS DE ENVÍO
    const combinedText = allMessages.map(m => m.body || '').join(' \n ');
    const shippingData = extractShippingData(combinedText, contact.phone);
    const effectivePhone = contact.phone || (shippingData?.hasPhone ? shippingData.phone : null);

    let vtigerTreatment = null;
    let vContact = null;
    try {
      vContact = await findVTigerContact({ ...contact, phone: effectivePhone }, currentSedeName);
      if (vContact) {
        // 🛡️ SEDE-SHIELD: Bloqueo total de contacto de otra sede
        const vSede = (vContact.cf_3451 || '').toUpperCase().trim();
        const curSede = (currentSedeName || '').toUpperCase().trim();
        if (vSede && curSede && vSede !== curSede) {
          console.warn(`[Agente 3] [SEDE-SHIELD] Bloqueado match vTiger ${vContact.id} (Sede: ${vSede}) para subcuenta de ${curSede}. Contacto invalidado.`);
          vContact = null;
        }
      }
      if (vContact) {
        const vCond = vContact.cf_2610 || '';
        vtigerTreatment = inferTreatmentFromCampaignOrUtm(vCond) || (vCond.length > 2 ? vCond : null);
        if (vtigerTreatment) {
          console.log(`[Agente 3] [VTIGER] Ground Truth vTiger para ${contact.id}: [${vtigerTreatment}]`);
          learningBrain.learnFromVtigerSale({
            treatment: vtigerTreatment,
            chatText: combinedText,
            campaignName: latestCampaign
          });
        }
        // 🎯 RECUPERACIÓN DE META AD ID REAL DESDE VTIGER (cf_2850)
        if (!latestAdId && isValidMetaAdId(vContact.cf_2850)) {
          latestAdId = String(vContact.cf_2850).trim();
          console.log(`[Agente 3] [VTIGER] Meta Ad ID recuperado desde vTiger (cf_2850): ${latestAdId}`);
        }
        if (!latestCampaign && vContact.cf_3472) {
          latestCampaign = vContact.cf_3472;
        }
      }
    } catch (vErr) {
      // Continuar con NLP si vTiger no responde
    }

    let targetAdId = latestAdId || currentAdId || null;
    let targetAdName = null;

    if (targetAdId && isValidMetaAdId(targetAdId)) {
      const metaDetails = await getMetaAdDetails(targetAdId, {
        sede: currentSedeName,
        pageId: targetPageId,
        locationId: activeLocationId
      });
      if (metaDetails) {
        latestCampaign = metaDetails.campaignName || latestCampaign;
        targetAdName = metaDetails.adName || metaDetails.creativeTitle;
        if (metaDetails.adsetName) {
          latestAdSetName = metaDetails.adsetName;
        }
        console.log(`[Agente 3] [META] UTMs Actualizados en vivo desde Meta: Campaña [${latestCampaign}], AdSet [${latestAdSetName}], Ad [${targetAdName}]`);
      }
    }

    const nlpAnalysis = analyzeSymptoms(combinedText, latestCampaign, latestMedium);

    // 🔬 D. Inferencia Clínica y de Pauta Ponderada:
    // Prioridad 1: Síntomas clínicos y Cerebro de Aprendizaje (NLP) - (La intención ACTUAL del cliente en chat)
    // Prioridad 2: Conjunto de Anuncios / Campaña / Anuncio / UTM Medium (ej: "TESTOSTERONA - ERNESTO - ...", "ARTRITIS - ERNESTO - ...")
    // Prioridad 3: Ground Truth de Ventas vTiger CRM (Útil si el cliente solo dice "Hola" y NO hay pauta activa o AdSet)
    // Prioridad 4: Tratamiento previo registrado en GHL
    const utmInferredTreatment = inferTreatmentFromCampaignOrUtm(latestAdSetName) ||
                                  inferTreatmentFromCampaignOrUtm(targetAdName) ||
                                  inferTreatmentFromCampaignOrUtm(latestMedium) ||
                                  inferTreatmentFromCampaignOrUtm(latestCampaign) ||
                                  inferTreatmentFromCampaignOrUtm(contact.attributionSource?.campaign) ||
                                  inferTreatmentFromCampaignOrUtm(contact.attributionSource?.utmContent);

    // 🛡️ REGLA DE ORO DE PAUTA ACTIVA:
    // Si el lead viene por Pauta Publicitaria (Meta Ads / Paid Social / Ad ID / AdSet) y el AdSet o Campaña
    // define explícitamente la DOLENCIA (ej: TESTOSTERONA -> Potencia), dicha dolencia es la verdad clínica de la consulta actual.
    // Un tratamiento histórico de vTiger (ej: Artritis en 2019) NUNCA debe anular la dolencia de la pauta que el usuario acaba de cliquear.
    let targetTratamiento = nlpAnalysis.primaryTreatment || utmInferredTreatment;
    if (!targetTratamiento) {
      targetTratamiento = vtigerTreatment || currentTratamiento || 'General';
    }
    let targetVtigerNota = currentVtigerNota || null;
    let duplicateCount = 1;

    // ⚖️ E. Penalización Automática de Falsos Positivos en el Cerebro:
    if ((contact.tags || []).includes('producto-artritis') && targetTratamiento !== 'Artritis') {
      learningBrain.penalizeAssociation({
        phrase: combinedText.slice(0, 100),
        incorrectTreatment: 'Artritis',
        correctTreatment: targetTratamiento
      });
    }

    // 🔍 C. FUZZY MATCHING FORENSE (Deduplicación Contextual de Historial)
    const fullName = `${contact.firstName || ''} ${contact.lastName || ''}`.trim();
    if ((!targetVtigerNota || !targetAdId || !targetTratamiento) && fullName.length >= 3) {
      try {
        const searchRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/?locationId=${activeLocationId}&query=${encodeURIComponent(fullName)}`, { headers: activeHeaders }, 1, isLive);
        if (searchRes.status === 200) {
          const sData = await searchRes.json();
          const matches = (sData.contacts || []).filter(c => c.id !== contact.id);

          for (const m of matches) {
            // Solo heredar notas o tratamientos si comparten teléfono confirmado o coincidencia geográfica
            if (isContextualDuplicate(contact, m, 0.90)) {
              const hasPhoneMatch = Boolean(contact.phone && m.phone && contact.phone.replace(/\D/g,'').slice(-10) === m.phone.replace(/\D/g,'').slice(-10));
              if (hasPhoneMatch) {
                duplicateCount++;
                const mCF = m.customFields || [];
                const vN = mCF.find(f => f.id === VTIGER_NOTAS_FIELD && f.value);
                const aId = mCF.find(f => (f.id === ID_ANUNCIO_FIELD || f.id === AD_ID_ALT_FIELD) && f.value);
                const trat = mCF.find(f => f.id === TRATAMIENTO_FIELD && f.value);
                const attrA = (m.attributions || []).find(a => a.utmAdId || a.adId);

                const candidateAId = aId?.value || attrA?.utmAdId || attrA?.adId;
                if (!targetAdId && isValidMetaAdId(candidateAId)) targetAdId = String(candidateAId).trim();
                if (!targetTratamiento && trat) targetTratamiento = trat.value;
              }
            }
          }
        }
      } catch (err) {
        console.error(`[Agente 3 Fuzzy Error] ${fullName}:`, err.message);
      }
    }

    // 🏷️ D. PREPARACIÓN DE FUENTE ESTILO VTIGER: [SEDE]-[PROVEEDOR]-[CANAL]-[TRATAMIENTO]
    // Un lead es pauta pagada si tiene un Meta Ad ID numérico válido O parámetros explícitos de cobro (Paid Social / cpc)
    const isPaidAd = Boolean(
      (targetAdId && isValidMetaAdId(targetAdId)) ||
      latestAdSetName ||
      contact.attributionSource?.sessionSource === 'Paid Social' ||
      contact.attributionSource?.utmMedium === 'cpc' ||
      contact.attributionSource?.utmMedium === 'paid' ||
      latestMedium === 'cpc' ||
      latestMedium === 'paid'
    );

    const targetProvider = resolveLeadProvider({
      pageId: targetPageId,
      pageName: targetPageName,
      campaignName: latestCampaign,
      adsetName: latestAdSetName,
      adName: targetAdName,
      isPaidAd,
      existingSource: contact.source
    });

    // 🏢 AFINAMIENTO DE ASESOR SEGÚN PROVEEDOR DETECTADO EN ADSET / CAMPAÑA:
    if (resolvedSede && resolvedSede.users) {
      if (resolvedSede.sedeId === 'PALACIOS') {
        if (targetProvider === 'CLICK2RING') {
          targetAdvisorId = resolvedSede.users.ultra.id;
          targetAdvisorName = resolvedSede.users.ultra.name;
        } else if (targetProvider === 'ERNESTO' || targetProvider === 'IN_HOUSE') {
          targetAdvisorId = resolvedSede.users.ernesto.id;
          targetAdvisorName = resolvedSede.users.ernesto.name;
        }
      } else if (resolvedSede.sedeId === 'BENAVIDES') {
        if (targetProvider === 'CLICK2RING') {
          targetAdvisorId = resolvedSede.users.redes2.id;
          targetAdvisorName = resolvedSede.users.redes2.name;
        } else if (targetProvider === 'ERNESTO' || targetProvider === 'IN_HOUSE') {
          targetAdvisorId = resolvedSede.users.redes1.id;
          targetAdvisorName = resolvedSede.users.redes1.name;
        }
      }
    }

    const targetChannel = resolveLeadChannel({
      campaignName: latestCampaign || targetAdName
    });

    const vtigerSource = buildVtigerSource({
      sedeName: targetPageName,
      campaignName: latestCampaign || targetAdName,
      pageId: targetPageId,
      provider: targetProvider,
      channel: targetChannel,
      treatment: targetTratamiento || 'General'
    });

    // 🏷️ E. ETIQUETADO INTELIGENTE Y MULTI-CONDICIÓN
    const tagsToRemove = [];
    const newTagsSet = new Set((contact.tags || []).map(t => String(t).trim()));
    newTagsSet.add('facebook-messenger');

    if (isPaidAd) {
      newTagsSet.add('meta-ads');
      newTagsSet.delete('organico');
    } else {
      newTagsSet.add('organico');
      // Si entra puramente orgánico sin historial previo de pauta, purgar meta-ads erróneo
      if (!currentAdId && !targetAdId) {
        newTagsSet.delete('meta-ads');
        if ((contact.tags || []).includes('meta-ads')) {
          tagsToRemove.push('meta-ads');
        }
      }
    }

    if (targetPageName) {
      const pageSlug = targetPageName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      newTagsSet.add(pageSlug);
    }

    // 1. Definir la ÚNICA etiqueta de producto permitida (El Tratamiento Principal)
    const ALL_PRODUCT_TAGS = [
      'producto-artritis', 'producto-diabetes', 'producto-prostata', 'producto-potencia', 
      'producto-tetosterona', 'producto-colageno', 'producto-vision', 'producto-gastro', 
      'producto-hongos', 'producto-gummies'
    ];
    const activeProductTag = targetTratamiento ? `producto-${targetTratamiento.toLowerCase()}` : null;
    
    // 2. Solo añadimos LA etiqueta principal, ignorando detecciones secundarias de NLP para evitar que se disparen múltiples bots
    if (activeProductTag) {
      newTagsSet.add(activeProductTag);
    }

    // 3. 🧹 Limpieza Quirúrgica ESTRICTA de etiquetas huérfanas
    if (activeProductTag) {
      for (const pTag of ALL_PRODUCT_TAGS) {
        if (pTag !== activeProductTag) {
          newTagsSet.delete(pTag);
          // Si el contacto ya tenía esta etiqueta falsa/antigua en GHL, la preparamos para el borrado forzoso
          if ((contact.tags || []).includes(pTag)) {
            tagsToRemove.push(pTag);
          }
        }
      }
    }

    // 🏢 RE-EVALUAR SEDE SI EL NOMBRE DE CAMPAÑA TRAE DIRECTIVA EXPLÍCITA (MÁXIMA PRIORIDAD):
    if (latestCampaign || targetAdName) {
      const campSede = resolveLeadSede({
        pageId: targetPageId,
        pageName: targetPageName,
        campaignName: latestCampaign || targetAdName
      });
      if (campSede) currentSedeName = campSede;
    }

    const previousSource = contact.source || '';
    let previousSede = null;
    if (previousSource) {
      if (previousSource.includes('BENAVIDES_2') || previousSource.includes('FUERZA')) previousSede = 'BENAVIDES_2';
      else if (previousSource.includes('BENAVIDES') || previousSource.includes('CORP')) previousSede = 'BENAVIDES';
      else if (previousSource.includes('ROOSEVELT') || previousSource.includes('ROOSVELT')) previousSede = 'ROOSEVELT';
      else if (previousSource.includes('PIURA')) previousSede = 'PIURA';
      else if (previousSource.includes('PALACIOS') || previousSource.includes('ULTRA')) previousSede = 'PALACIOS';
    }
    if (!previousSede && vContact?.cf_3451) {
      previousSede = String(vContact.cf_3451).trim().toUpperCase();
    }
    if (!previousSede && expiredGraceMsg) {
      const pName = FB_PAGE_ID_MAP[expiredGraceMsg.pageId] || '';
      if (pName.includes('Benavides') || pName.includes('Corp') || pName.includes('Fuerza')) previousSede = 'BENAVIDES';
      else if (pName.includes('Roosevelt') || pName.includes('Plus')) previousSede = 'ROOSEVELT';
      else if (pName.includes('Piura')) previousSede = 'PIURA';
      else if (pName.includes('Palacios') || pName.includes('Ultra')) previousSede = 'PALACIOS';
    }

    // 🛡️ ARQUITECTURA MULTI-TENANT: Cada subcuenta en GHL es su propia sede soberana e independiente.
    // La mudanza de sede entre subcuentas ya no existe. Cada contacto pertenece a la sede de su subcuenta.
    const isMudanzaDeSede = false;
    newTagsSet.add(`sede-${currentSedeName.toLowerCase()}`);

    // 🧹 Purga forzosa de etiquetas obsoletas de mudanza que hayan quedado de sincronizaciones previas
    const MUDANZA_OBSOLETE_TAGS = ['mudanza-desde-palacios', 'mudanza-desde-benavides', 'mudanza-de-sede', 'mudanza-gracia-expirada'];
    for (const mTag of MUDANZA_OBSOLETE_TAGS) {
      if (newTagsSet.has(mTag)) {
        newTagsSet.delete(mTag);
        tagsToRemove.push(mTag);
      }
    }

    // Alerta de Lead Caliente (Teléfono o Dirección)
    if (shippingData.isHotLead) {
      newTagsSet.add('🔥-lead-caliente');
    }

    if (duplicateCount > 1) {
      newTagsSet.add('alerta-duplicado-clic');
      newTagsSet.add(`pauta-clic-x${duplicateCount}`);
    }

    // 🚨 ALERTA: Doble Ingreso Publicitario (Detección Avanzada CPM)
    let isDoubleAdEntry = false;

    // Regla 1: Entró por un Ad diferente al que tenía registrado.
    if (latestAdId && currentAdId && latestAdId !== currentAdId) {
      isDoubleAdEntry = true;
    } 
    // Regla 2: Entró por el MISMO Ad, pero pasaron más de 24 horas (Nuevo cobro de Meta)
    else if (latestAdId && latestAdId === currentAdId) {
      const adClicks = fbMessages.filter(m => m.adId === latestAdId);
      if (adClicks.length >= 2) {
        const timeDiffHours = (adClicks[0].timestamp - adClicks[adClicks.length - 1].timestamp) / (1000 * 60 * 60);
        if (timeDiffHours >= 24) {
          isDoubleAdEntry = true;
        }
      }
    }

    if (isDoubleAdEntry) {
      newTagsSet.add('doble-ingreso-publicitario');
    }

    // 📝 F. PREPARAR CUSTOM FIELDS (FULL DATA STACK)
    const customFieldsToUpdate = [];
    if (targetAdId && isValidMetaAdId(targetAdId)) {
      customFieldsToUpdate.push({ id: ID_ANUNCIO_FIELD, key: 'contact.id_de_anuncio', field_value: String(targetAdId) });
      customFieldsToUpdate.push({ id: AD_ID_ALT_FIELD, key: 'contact.ad_id', field_value: String(targetAdId) });
    } else if (rawCurrentAdId && !isValidMetaAdId(rawCurrentAdId)) {
      // 🧹 PURGA QUIRÚRGICA: Si el contacto tenía una cadena de origen (ej: PALACIOS-...) en el Ad ID, limpiarlo
      console.log(`[Agente 3] [PURGE] Limpiando Ad ID invalido ("${rawCurrentAdId}") para ${contactId}`);
      customFieldsToUpdate.push({ id: ID_ANUNCIO_FIELD, key: 'contact.id_de_anuncio', field_value: '' });
      customFieldsToUpdate.push({ id: AD_ID_ALT_FIELD, key: 'contact.ad_id', field_value: '' });
    }
    if (targetTratamiento && targetTratamiento !== 'General') {
      customFieldsToUpdate.push({ id: TRATAMIENTO_FIELD, key: 'contact.tratamiento_comprado', field_value: targetTratamiento });
    }
    if (targetVtigerNota) customFieldsToUpdate.push({ id: VTIGER_NOTAS_FIELD, key: 'contact.vtiger_historial_completo', field_value: targetVtigerNota });
    
    // UTMs & Tarjeta de Contacto Completa (Sede, Origen, UTMs, Teléfono, Interacción)
    if (UTM_SOURCE_FIELD) customFieldsToUpdate.push({ id: UTM_SOURCE_FIELD, key: 'contact.utm_source', field_value: 'facebook' });
    if (UTM_MEDIUM_FIELD) customFieldsToUpdate.push({ id: UTM_MEDIUM_FIELD, key: 'contact.utm_medium', field_value: isPaidAd ? 'cpc' : 'messenger' });
    if (UTM_CAMPAIGN_FIELD && latestCampaign) customFieldsToUpdate.push({ id: UTM_CAMPAIGN_FIELD, key: 'contact.utm_campaign', field_value: latestCampaign });
    if (UTM_CONTENT_FIELD) customFieldsToUpdate.push({ id: UTM_CONTENT_FIELD, key: 'contact.utm_content', field_value: targetAdName || targetTratamiento || 'Anuncio' });
    if (UTM_TERM_FIELD && latestAdSetName) customFieldsToUpdate.push({ id: UTM_TERM_FIELD, key: 'contact.utm_term', field_value: latestAdSetName });
    if (ADSET_ID_FIELD && latestAdSetName) customFieldsToUpdate.push({ id: ADSET_ID_FIELD, key: 'contact.adset_id', field_value: latestAdSetName });
    if (SEDE_ASIGNADA_FIELD) customFieldsToUpdate.push({ id: SEDE_ASIGNADA_FIELD, key: 'contact.sede_asignada', field_value: currentSedeName });
    if (ORIGEN_LEAD_FIELD && vtigerSource) customFieldsToUpdate.push({ id: ORIGEN_LEAD_FIELD, key: 'contact.origen_lead', field_value: vtigerSource });
    if (TIENE_TELEFONO_FIELD) customFieldsToUpdate.push({ id: TIENE_TELEFONO_FIELD, key: 'contact.tiene_telfono', field_value: (contact.phone || (shippingData && shippingData.hasPhone)) ? 'Sí' : 'No' });
    if (ULTIMA_INTERACCION_FIELD) customFieldsToUpdate.push({ id: ULTIMA_INTERACCION_FIELD, key: 'contact.ultima_interaccion', field_value: new Date().toISOString().split('T')[0] });

    // 🏢 G. SINCRONIZACIÓN COMERCIAL CON VTIGER Y PURGA DE COMPRAS FALSAS (EN VIVO - DOMINIO AISLADO)
    let finalCustomerWon = isCustomerWon;
    let finalMonetaryValue = 0;
    try {
      const truth = evaluateCommercialTruth(contact, vContact);
      finalCustomerWon = truth.isWon;
      finalMonetaryValue = truth.totalSpent;
      const sanitizedCommercialFields = buildSanitizedCommercialFields(contact, vContact, activeLocationId);
      customFieldsToUpdate.push(...sanitizedCommercialFields);
    } catch (commErr) {
      console.warn(`[Agente 3] [WARN] No se pudo evaluar estado comercial en vivo para ${contactId}:`, commErr.message);
    }

    // 🏷️ INYECCIÓN DE ETIQUETAS ACCIONABLES (TELÉFONO & ESTADO COMERCIAL)
    const hasPhone = Boolean(contact.phone || (shippingData && shippingData.hasPhone));
    if (hasPhone) {
      newTagsSet.add('con-telefono');
      newTagsSet.delete('sin-telefono');
      if ((contact.tags || []).includes('sin-telefono')) tagsToRemove.push('sin-telefono');
    } else {
      newTagsSet.add('sin-telefono');
      newTagsSet.delete('con-telefono');
      if ((contact.tags || []).includes('con-telefono')) tagsToRemove.push('con-telefono');
    }

    if (finalCustomerWon) {
      newTagsSet.add('compro');
      newTagsSet.delete('no-compro');
      if ((contact.tags || []).includes('no-compro')) tagsToRemove.push('no-compro');
    } else {
      newTagsSet.add('no-compro');
      newTagsSet.delete('compro');
      if ((contact.tags || []).includes('compro')) tagsToRemove.push('compro');
    }

    // 🏢 INYECCIÓN FLUIDA DE ETIQUETAS VTIGER EN VIVO
    if (vContact || targetVtigerNota) {
      newTagsSet.add('vtiger');
      newTagsSet.add('vtiger-sincronizado');
      if (finalCustomerWon) {
        newTagsSet.add('cliente-vtiger');
        newTagsSet.delete('prospecto-vtiger');
        if ((contact.tags || []).includes('prospecto-vtiger')) tagsToRemove.push('prospecto-vtiger');
      } else {
        newTagsSet.add('prospecto-vtiger');
        newTagsSet.delete('cliente-vtiger');
        if ((contact.tags || []).includes('cliente-vtiger')) tagsToRemove.push('cliente-vtiger');
      }
      if (vContact?.cf_994) {
        const vStClean = String(vContact.cf_994).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (vStClean) newTagsSet.add(`vtiger-status-${vStClean}`);
      }
      if (vContact?.cf_3507) {
        const vCanalClean = String(vContact.cf_3507).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (vCanalClean) newTagsSet.add(`canal-${vCanalClean}`);
      }
    }

    // SINCRONIZACION DE PIPELINE (Orquestacion LOA)
    try {
      const cleanSede = (targetPageName?.toLowerCase().includes('bionatural') || targetPageName?.toLowerCase().includes('palacios')) 
        ? 'PALACIOS' 
        : (targetPageName ? targetPageName.replace(/Naturales\s*/i, '').trim().toUpperCase() : 'SEDE');
      const campaignSnippet = (latestCampaign || targetAdName || 'Directa').substring(0, 32);
      const prodPrefix = targetTratamiento && targetTratamiento !== 'General' ? `[${targetTratamiento.toUpperCase()}] ` : '';
      const cardTitle = `${prodPrefix}${fullName} | ${cleanSede} | ${campaignSnippet}`;
      await syncUnifiedPipelineOpportunity(contactId, cardTitle, finalCustomerWon, true, finalMonetaryValue, targetAdvisorId, { locationId: activeLocationId, headers: activeHeaders });
    } catch (oppErr) {
      console.error(`[Agente 3] Error sincronizando pipeline para ${contactId}:`, oppErr.message);
    }

    // 📦 G. CONSTRUIR PAYLOAD ATÓMICO (1 SOLO PUT)
    const updatePayload = {
      source: vtigerSource,        // Fuente de contacto estilo vTiger
      tags: Array.from(newTagsSet),
      customFields: customFieldsToUpdate
    };

    // 🛡️ ESCUDO DE PROPIETARIO & UX GUARD
    // No robar la asignación si ya es cliente cerrado en vTiger, O si el usuario está en chat activo
    if (isLiveChatting || (finalCustomerWon && contact.assignedTo)) {
      console.log(`[Agente 3] [UX-GUARD] Escudo de Propietario activado para ${contactId}. Se mantiene asignado al actual.`);
      // No incluimos 'assignedTo' en el payload
    } else {
      updatePayload.assignedTo = targetAdvisorId; // Regla de Oro: Sede actual
    }

    // 🌍 INYECCIÓN AUTOMÁTICA DE "GENERAL INFO" (ESTRICTO USA)
    // 1. Teléfono
    if (!contact.phone) {
      if (shippingData && shippingData.hasPhone) {
        updatePayload.phone = shippingData.phone;
      } else if (vContact) {
        const vPhone = vContact.mobile || vContact.phone || vContact.homephone || vContact.otherphone;
        if (vPhone) updatePayload.phone = String(vPhone).replace(/\D/g, '');
      }
    }

    // 2. País (Siempre United States / US)
    if (!contact.country || contact.country === '--') {
      updatePayload.country = 'United States';
    }

    // 3. Dirección Postal (address1)
    if (!contact.address1) {
      if (shippingData && shippingData.address1) updatePayload.address1 = shippingData.address1;
      else if (vContact && vContact.mailingstreet) updatePayload.address1 = String(vContact.mailingstreet).trim();
    }

    // 4. Ciudad (city)
    if (!contact.city) {
      if (shippingData && shippingData.city) updatePayload.city = shippingData.city;
      else if (vContact && (vContact.cf_1157 || vContact.mailingcity)) updatePayload.city = String(vContact.cf_1157 || vContact.mailingcity).trim();
    }

    // 5. Región / Estado (state: e.g. TX, FL, CA, NY)
    if (!contact.state || contact.state === '--') {
      if (shippingData && shippingData.state) updatePayload.state = shippingData.state;
      else if (vContact && (vContact.mailingstate || vContact.splareacodes_state)) {
        updatePayload.state = String(vContact.mailingstate || vContact.splareacodes_state).trim();
      }
    }

    // 6. Código Postal (postalCode: e.g. 33135, 77002)
    if (!contact.postalCode) {
      if (shippingData && shippingData.postalCode) updatePayload.postalCode = shippingData.postalCode;
      else if (vContact && vContact.mailingzip) updatePayload.postalCode = String(vContact.mailingzip).trim();
    }

    // 7. Zona Horaria (timezone IANA: e.g. America/Chicago, America/New_York)
    if ((!contact.timezone || contact.timezone === '--') && shippingData.timezone) {
      updatePayload.timezone = shippingData.timezone;
    }

    // 🔍 Filtro Silencioso: Comprobar si realmente hay cambios antes de hacer PUT
    const isSameAdvisor = contact.assignedTo === targetAdvisorId;
    const isSameSource = contact.source === vtigerSource;
    const currentTags = (contact.tags || []).map(t => String(t).trim());
    const tagsChanged = newTagsSet.size !== currentTags.length || Array.from(newTagsSet).some(t => !currentTags.includes(t));
    const currentCFs = contact.customFields || [];

    // 🚀 EJECUTAR PURGA DE ETIQUETAS FALSAS EN GHL (API V2)
    if (tagsToRemove.length > 0) {
      console.log(`[Agente 3] [CLEANUP] Purgando etiquetas huérfanas de ${contactId}: ${tagsToRemove.join(', ')}`);
      await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
        method: 'DELETE',
        headers: activeHeaders,
        body: JSON.stringify({ tags: tagsToRemove })
      }, 1, isLive);
    }

    const CRITICAL_CF_IDS = [
      ...Object.values(sedeFields),
      // Palacios (Legacy Fallback)
      '8EQtKkiW7Z022bcN0vhS', '5TY5AIOpu1c8f6WosyF2', 'RLxFOTXkICXLWShjaLaB',
      'GZKRu2z1Z156lRUfyrpo', '5js0Lfbh5XDLq87SDgdT', 'jfaxRCXTLZQCuzsTl49v',
      '7SgOMq4Aeti7gN1SqVN6', 'cN6NrhXqMlEhyp35g7bs', 'Wh4IIv4TEbxJaZBi95cp',
      'XTGicfQtDwBrlr2qPKxF', 'Yd0Ix40PYOcZQn6TokaX'
    ].filter(Boolean);
    const hasCFChanges = customFieldsToUpdate.some(cf => {
      if (!CRITICAL_CF_IDS.includes(cf.id)) return false;
      const existing = currentCFs.find(f => f.id === cf.id);
      const existingVal = existing ? String(existing.value || '') : '';
      const newVal = String(cf.field_value || '');
      return existingVal !== newVal;
    });
    const hasPhoneUpdate = !contact.phone && shippingData.hasPhone;
    const hasCountryUpdate = (!contact.country || contact.country === '--');
    const hasAddressUpdate = !contact.address1 && Boolean(shippingData.address1);
    const hasCityUpdate = !contact.city && Boolean(shippingData.city);
    const hasStateUpdate = (!contact.state || contact.state === '--') && Boolean(shippingData.state);
    const hasZipUpdate = !contact.postalCode && Boolean(shippingData.postalCode);
    const hasTzUpdate = (!contact.timezone || contact.timezone === '--') && Boolean(shippingData.timezone);

    const hasGeoUpdate = hasCountryUpdate || hasAddressUpdate || hasCityUpdate || hasStateUpdate || hasZipUpdate || hasTzUpdate;
    const hasChanges = !isSameAdvisor || !isSameSource || tagsChanged || hasCFChanges || hasPhoneUpdate || hasGeoUpdate;

    if (!hasChanges) {
      console.log(`[Agente 3] [SYNC] Contacto ${contactId} ya está 100% sincronizado. Omitiendo PUT para evitar parpadeos en pantalla.`);
      return 'UNCHANGED';
    }

    // 🧹 Limpieza final del payload para evitar 400 Bad Request por strings vacíos
    for (const key of Object.keys(updatePayload)) {
      if (updatePayload[key] === '') {
        delete updatePayload[key];
      }
    }

    if (isDryRun) {
      console.log(`[Agente 3] 🧪 DRY RUN: Simulación completada para ${contactId}. Cambios que se habrían inyectado:`);
      console.log(JSON.stringify(updatePayload, null, 2));
      return;
    }

    const updateRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: activeHeaders,
      body: JSON.stringify(updatePayload)
    }, 1, isLive);

    if (updateRes.status === 200) {
      if (global.pushLiveLog) {
        global.pushLiveLog(`[ROUTING] Agente 3: ${contact.name || 'Lead'} -> ${targetAdvisorName} | Src: ${vtigerSource}`);
      }
      console.log(`[Agente 3] [SUCCESS] ${contact.firstName || ''} ${contact.lastName || ''} (${contactId}) | Ad ID: ${targetAdId || 'N/A'} | Fuente: ${vtigerSource} | Estado: ${updatePayload.state || contact.state || '--'} | Actualizado OK.`);

      // 📌 H. SAVE PROCESS: INYECTAR NOTA HISTÓRICA SOLO SI HUBO CAMBIO DE AD O DE TRATAMIENTO
      const adChanged = Boolean(
        (latestAdId && currentAdId && latestAdId !== currentAdId) ||
        (latestAdId && !currentAdId)
      );
      const treatmentChanged = targetTratamiento && targetTratamiento !== currentTratamiento;

      if (adChanged || treatmentChanged) {
        let prevAdDateStr = null;
        let prevAdTimestamp = 0;
        if (currentAdId && fbMessages.length > 0) {
          const prevAdMsg = fbMessages.find(m => m.adId === currentAdId);
          if (prevAdMsg && prevAdMsg.timestamp) {
            prevAdTimestamp = prevAdMsg.timestamp;
            prevAdDateStr = new Date(prevAdMsg.timestamp).toLocaleDateString('es-PE', { timeZone: 'America/New_York' });
          }
        }
        if (!prevAdDateStr && contact.dateAdded) {
          prevAdTimestamp = new Date(contact.dateAdded).getTime();
          prevAdDateStr = new Date(contact.dateAdded).toLocaleDateString('es-PE', { timeZone: 'America/New_York' });
        }

        const nowMs = newestMsg?.timestamp || Date.now();
        const diffHours = prevAdTimestamp > 0 ? (nowMs - prevAdTimestamp) / (1000 * 60 * 60) : 999;
        const graceThreshold = isCustomerWon ? 30 * 24 : 96; // 30 días si es cliente con venta, 4 días si es prospecto
        const isGraceExpiredCalc = Boolean(
          expiredGraceMsg || 
          isMudanzaDeSede || 
          diffHours > graceThreshold
        );

        const prevCampaignVal = existingCustomFields.find(f => f.id === UTM_CAMPAIGN_FIELD && f.value)?.value ||
                                contact.attributionSource?.utmCampaign ||
                                previousSource ||
                                '';
        const prevTreatmentVal = currentTratamiento || 
                                 (vContact?.cf_2610 ? inferTreatmentFromCampaignOrUtm(vContact.cf_2610) || vContact.cf_2610 : null) ||
                                 'General';

        await saveAdHistoryNote(contactId, {
          newAdId: latestAdId,
          oldAdId: currentAdId || 'Ninguna previa (Orgánico)',
          oldAdDate: prevAdDateStr,
          previousSede: previousSede || currentSedeName || 'PALACIOS',
          previousCampaign: prevCampaignVal,
          previousTreatment: prevTreatmentVal,
          campaign: latestCampaign || 'Pauta Reciente',
          pageName: targetPageName,
          clickCount: duplicateCount,
          source: vtigerSource,
          treatment: targetTratamiento,
          isDoubleAdEntry,
          isGraceExpired: isGraceExpiredCalc,
          isMudanzaDeSede: false
        }, { locationId: activeLocationId, headers: activeHeaders });
      }
      return 'SUCCESS';
    } else {
      const errText = await updateRes.text();
      const isDuplicateConflict = updateRes.status === 400 && errText.includes('duplicated contacts') && errText.includes('matchingField');
      const isUserNotExist = updateRes.status === 400 && (
        errText.includes('does not exist in this location') ||
        errText.includes('User') ||
        errText.includes('assignedTo')
      );

      // 🛡️ AUTO-HEALING: Asesor no existe en esta ubicación (Reintentar sin assignedTo)
      if (isUserNotExist) {
        console.warn(`[Agente 3] [AUTO-HEAL] Asesor no válido para ubicación (${activeLocationId}). Reintentando actualización atómica sin assignedTo para ${contactId}...`);
        delete updatePayload.assignedTo;
        const retryUserRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
          method: 'PUT',
          headers: activeHeaders,
          body: JSON.stringify(updatePayload)
        }, 1, isLive);
        if (retryUserRes.status === 200) {
          console.log(`[Agente 3] [SUCCESS] [AUTO-HEAL] Contacto ${contactId} actualizado exitosamente sin assignedTo.`);
          return 'SUCCESS';
        }
      }

      // 🛡️ AUTO-HEALING: Conflicto de Contacto Duplicado (Phone/Email)
      if (isDuplicateConflict) {
        try {
          const errObj = JSON.parse(errText);
          const conflictField = errObj.meta && errObj.meta.matchingField;
          
          if (conflictField && updatePayload[conflictField]) {
            const rescateValor = updatePayload[conflictField];
            console.log(`[Agente 3] [AUTO-HEAL] Conflicto de duplicado en '${conflictField}'. Contacto existente en GHL: ${errObj.meta.contactId}. Aplicando protocolo de rescate...`);
            
            // 1. Remover el campo que causa el conflicto (GHL no permite 2 contactos con el mismo teléfono)
            delete updatePayload[conflictField];
            
            // 2. Añadir alerta visual
            updatePayload.tags.push('alerta-duplicado-crm');
            
            // 3. Reintentar el PUT salvando el resto del contexto (Tags, Custom Fields, Tratamientos)
            const retryRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
              method: 'PUT',
              headers: activeHeaders,
              body: JSON.stringify(updatePayload)
            }, 1, isLive);
            
            if (retryRes.status === 200) {
               console.log(`[Agente 3] [SUCCESS] [AUTO-HEAL] Contacto ${contactId} actualizado exitosamente tras esquivar conflicto de duplicado.`);
               
               if (rescateValor && isLive) {
                 try {
                   const notaText = `[AVISO] NÚMERO RESCATADO DE VTIGER: ${rescateValor}\n(GHL bloqueó la inserción automática porque este número ya le pertenece a otro contacto/familiar en esta ubicación. Usa este número para llamar.)`;
                   await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
                     method: 'POST',
                     headers: activeHeaders,
                     body: JSON.stringify({ body: notaText, userId: updatePayload.assignedTo || null })
                   }, 1, true);
                   console.log(`[Agente 3] [NOTE] Nota de Rescate insertada exitosamente en GHL para ${contactId}.`);
                 } catch (noteErr) {
                   console.log(`[Agente 3] [WARN] No se pudo insertar la nota de rescate: ${noteErr.message}`);
                 }
               }
               return 'SUCCESS';
            } else {
               console.error(`[Agente 3] [ERROR] [AUTO-HEAL] Auto-Heal falló para ${contactId}. Status: ${retryRes.status}`);
            }
          }
        } catch (parseErr) {
           console.error("[Agente 3] [ERROR] Error en protocolo de Auto-Heal:", parseErr.message);
        }
      } else {
        console.error(`[Agente 3] [ERROR] Falló actualización atómica de ${contactId}. Status: ${updateRes.status} - Detalles: ${errText}`);
      }

      // 🛡️ AUTO-HEALING: Errores de servidor GHL (500/502/503)
      // Marcar el contacto para re-proceso en el siguiente ciclo del Radar
      if (updateRes.status >= 500) {
        console.warn(`[Agente 3] [WARN] GHL devolvió ${updateRes.status} para ${contactId}. Marcando para re-proceso en el siguiente ciclo.`);
        return 'RETRY';
      }
    }

  } catch (error) {
    console.error(`[Agente 3] Error crítico en routeChatByContact:`, error.message);
    return 'ERROR';
  } finally {
    releaseContactLock(contactId);
  }
}

// ==========================================
// POLLER GRATUITO (Alternativa al Webhook Premium)
// ==========================================
// Mantiene un registro de los últimos contactos procesados para no repetir
const processedTimestamps = new Map();
let lastSyncCheck = Date.now() - 60000; // Buscar desde hace 1 minuto

export async function runChatRouterPoller() {
  try {
    const targetPalaciosLoc = SEDES_GATEWAY.PALACIOS.ghl.locationId;
    const targetPalaciosHeaders = getGhlHeaders({ locationId: targetPalaciosLoc });
    const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${targetPalaciosLoc}&limit=20`;
    const res = await fetchWithRetry(convUrl, { headers: targetPalaciosHeaders });
    
    if (res.status !== 200) return;
    
    const data = await res.json();
    const conversations = data.conversations || [];
    
    for (const conv of conversations) {
      if (!conv.contactId) continue;
      const lastProc = processedTimestamps.get(conv.contactId) || 0;
      if (Date.now() - lastProc > 60000) { // 60 segundos de debounce por contacto
        processedTimestamps.set(conv.contactId, Date.now());
        routeChatByContact(conv.contactId, false, false, { locationId: targetPalaciosLoc, headers: targetPalaciosHeaders }).catch(err => console.error(err));
      }
    }
  } catch (error) {
    console.error(`[Agente 3 Poller Error]:`, error.message);
  }
}

/**
 * Agente 2 / 3: Limpiador y Reasignador Continuo de Bandejas por Sede
 * Barre las bandejas asignadas a cada asesor y reasigna cualquier lead que pertenezca a otra página.
 */
export async function runInboxSedeCleaner() {
  const targetPalaciosLoc = SEDES_GATEWAY.PALACIOS.ghl.locationId;
  const targetPalaciosHeaders = getGhlHeaders({ locationId: targetPalaciosLoc });
  for (const [, advisor] of Object.entries(PALACIOS_USERS)) {
    try {
      const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${targetPalaciosLoc}&assignedTo=${advisor.id}&limit=20`;
      const res = await fetchWithRetry(convUrl, { headers: targetPalaciosHeaders });
      if (res.status !== 200) continue;

      const data = await res.json();
      const conversations = data.conversations || [];

      for (const conv of conversations) {
        if (!conv.contactId) continue;
        const lastProc = processedTimestamps.get(conv.contactId) || 0;
        if (Date.now() - lastProc > 45000) {
          processedTimestamps.set(conv.contactId, Date.now());
          await routeChatByContact(conv.contactId);
        }
      }
    } catch (e) {
      console.error(`[Agente 2 Cleaner Error en ${advisor.name}]:`, e.message);
    }
  }
}
