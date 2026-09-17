import { GHL_CONFIG, FB_PAGE_ID_MAP, PALACIOS_USERS } from '../config/index.js';
import { ghlFetch, GHL_HEADERS } from '../utils/ghl_http_client.js';
import { analyzeSymptoms, extractShippingData, buildVtigerSource, resolveLeadProvider, inferTreatmentFromCampaignOrUtm, isValidMetaAdId } from './nlp_symptom_engine.js';
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
export async function saveAdHistoryNote(contactId, { newAdId, oldAdId, campaign, pageName, clickCount, source, treatment }) {
  const dateStr = new Date().toLocaleString('es-PE', { timeZone: 'America/New_York' });
  const noteBody = `[SAVE PROCESS: Ruteo y Diagnostico]
- Fecha: ${dateStr} (EST)
- Origen/Fuente Asignada: ${source || 'N/A'}
- Tratamiento Detectado: ${treatment || 'General'}
- Nuevo Ad ID: ${newAdId || 'Organico / Sin Ad'}
- Anuncio / Campana Previa: ${oldAdId || 'Ninguna previa'}
- Fanpage de Entrada: ${pageName || 'N/A'}
- Campana Detectada: ${campaign || 'N/A'}
- Interaccion: Clic #${clickCount || 1}

----------------------------------------
Powered by LOA Engine
Desarrollado por Gabriel Loayza
Marketing GHL Solutions`;

  try {
    const noteUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;
    await fetchWithRetry(noteUrl, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ body: noteBody })
    });
    console.log(`[Agente 4 Save Process] [NOTE] Nota histórica inyectada para contacto ${contactId}`);
  } catch (err) {
    console.error(`[Agente 4 Save Process Error]:`, err.message);
  }
}

/**
 * 📌 Save Process: Inyecta una Nota Histórica de MUDANZA DE SEDE AUTORIZADA en GHL
 */
export async function saveMudanzaHistoryNote(contactId, {
  previousSede,
  previousSource,
  currentSede,
  newSource,
  advisorName,
  pageName,
  campaign,
  motivo,
  timeDiffStr,
  isCustomerWon,
  vContact
}) {
  const dateStr = new Date().toLocaleString('es-PE', { timeZone: 'America/New_York' });
  const noteBody = `🚨 [MUDANZA DE SEDE AUTORIZADA - TIEMPO DE GRACIA EXPIRADO]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Fecha y Hora: ${dateStr} (EST)
• Procedencia / Sede Anterior: ${previousSede || 'Sede Externa'}
• Origen Anterior: ${previousSource || 'N/A'}
• Nueva Sede Receptora: ${currentSede}
• Nuevo Origen Asignado: ${newSource}
• Asesor Comercial Asignado: ${advisorName || 'N/A'}
• Fanpage de Reingreso: ${pageName || 'N/A'}
• Campaña / Pauta: ${campaign || 'Directa / Orgánica'}
• Justificación de Traspaso: ${motivo} (${timeDiffStr})
• Condición del Contacto: ${isCustomerWon ? 'CLIENTE VENDIDO (+30d sin recompra)' : 'PROSPECTO SIN VENTA (+4d / 96h)'}
${vContact ? `• Historial vTiger: ID ${vContact.id} | Compras: ${vContact.spl_num_compras || '0'} | Total: $${vContact.cf_3392 || '0'}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Protocolo de Exclusividad y Tiempos de Gracia
LOA Engine - Laboratorios Naturales`;

  try {
    const noteUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;
    await fetchWithRetry(noteUrl, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ body: noteBody })
    });
    console.log(`[Agente 3] [MUDANZA-NOTE] Tarjeta de nota histórica de mudanza inyectada para contacto ${contactId}`);
  } catch (err) {
    console.error(`[Agente 3 Mudanza Note Error]:`, err.message);
  }
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
export async function routeChatByContact(contactId, isLive = false, isDryRun = false) {
  await acquireContactLock(contactId);
  try {
    console.log(`[Agente 3] Analizando ruteo para el contacto ${contactId}... (Live: ${isLive}, DryRun: ${isDryRun})`);

    // 1. Obtener la conversación del contacto
    const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&contactId=${contactId}`;
    const convRes = await fetchWithRetry(convUrl, { headers: HEADERS }, 1, isLive);
    
    if (convRes.status !== 200) {
      console.log(`[Agente 3] No se pudieron obtener las conversaciones para ${contactId}. Status: ${convRes.status}`);
      if (convRes.status >= 500) return 'RETRY';
      return;
    }

    const convData = await convRes.json();
    const conversations = convData.conversations || [];
    
    if (conversations.length === 0) {
      const retries = indexingRetries.get(contactId) || 0;
      if (retries < 2) {
        console.log(`[Agente 3] [WAIT] Posible delay de indexación para ${contactId}. Conversaciones vacías. Reintentando en próximo ciclo (Intento ${retries + 1}/2).`);
        indexingRetries.set(contactId, retries + 1);
        return 'RETRY_INDEXING';
      }
      console.log(`[Agente 3] Sin conversaciones indexadas tras 2 reintentos para ${contactId}. Ignorando.`);
      indexingRetries.delete(contactId);
      return;
    }

    // Usaremos la conversación más reciente
    const convId = conversations[0].id;

    // 2. Traer los últimos mensajes (pedimos unos 20 para ver el historial cercano)
    const msgUrl = `https://services.leadconnectorhq.com/conversations/${convId}/messages?locationId=${locationId}&limit=20`;
    const msgRes = await fetchWithRetry(msgUrl, { headers: HEADERS }, 1, isLive);
    
    if (msgRes.status !== 200) {
      console.log(`[Agente 3] No se pudieron obtener los mensajes para la conv ${convId}. Status: ${msgRes.status}`);
      if (msgRes.status >= 500) return 'RETRY';
      return;
    }

    const msgData = await msgRes.json();
    const allMessages = msgData.messages?.messages || [];
    
    // Ordenar todos los mensajes de más reciente a más antiguo
    allMessages.sort((a, b) => new Date(b.dateAdded).getTime() - new Date(a.dateAdded).getTime());

    // 3. Extraer solo los mensajes entrantes relacionados a una PageID de FB
    let fbMessages = [];
    for (const m of allMessages) {
      const fbMeta = m.meta?.fb || {};
      const pageId = fbMeta.fromPageId || fbMeta.pageId;
      if (pageId) {
        fbMessages.push({
          id: m.id,
          pageId: String(pageId),
          timestamp: new Date(m.dateAdded).getTime(),
          dateStr: m.dateAdded,
          adId: fbMeta.adId && fbMeta.adId !== 'N/A' ? String(fbMeta.adId) : null
        });
      }
    }

    // Ordenar de más reciente a más antiguo
    fbMessages.sort((a, b) => b.timestamp - a.timestamp);

    if (fbMessages.length === 0) {
      const retries = indexingRetries.get(contactId) || 0;
      if (retries < 2) {
        console.log(`[Agente 3] [WAIT] Posible delay de indexación de FB para ${contactId}. Mensajes de FB vacíos. Reintentando en próximo ciclo (Intento ${retries + 1}/2).`);
        indexingRetries.set(contactId, retries + 1);
        return 'RETRY_INDEXING';
      }
    }

    let targetPageId = null;
    let targetPageName = null;
    const newestMsg = fbMessages.length > 0 ? fbMessages[0] : null;

    if (newestMsg) {
      // El mensaje más reciente dicta a qué página acaba de escribir el usuario
      targetPageId = newestMsg.pageId;
      targetPageName = FB_PAGE_ID_MAP[targetPageId];
    }

    // 5. Cargar contacto de GHL UNA SOLA VEZ (se reutiliza para fallback de sede y para el procesamiento completo)
    const contactRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: HEADERS }, 1, isLive);
    if (contactRes.status !== 200) return;
    const contactData = await contactRes.json();
    const contact = contactData.contact || contactData;

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
      console.log(`[Agente 3] No se pudo determinar la página para el contacto ${contactId}.`);
      return;
    }

    // Determinar a qué asesor le corresponde esta página (por Page ID o por Nombre de Fanpage)
    let targetAdvisorId = null;
    let targetAdvisorName = null;
    for (const [, advisor] of Object.entries(PALACIOS_USERS)) {
      const matchById = targetPageId && advisor.fbPageIds && advisor.fbPageIds.includes(targetPageId);
      const matchByName = targetPageName && advisor.pages && advisor.pages.includes(targetPageName);
      if (matchById || matchByName) {
        targetAdvisorId = advisor.id;
        targetAdvisorName = advisor.name;
        break;
      }
    }

    if (!targetAdvisorId) {
      console.log(`[Agente 3] No se encontró un asesor asignado para la página ${targetPageName}.`);
      return;
    }

    indexingRetries.delete(contactId); // Limpiar reintentos en caso de éxito

    const existingTags = (contact.tags || []).map(t => String(t).toLowerCase());
    const isCustomerWon = existingTags.includes('cliente-comprador') || existingTags.includes('venta-cerrada');

    // 4. REGLA DE TIEMPO DE GRACIA (4 DÍAS SIN VENTA / 30 DÍAS CON VENTA)
    const GRACE_PERIOD_HOURS_LEAD = 96; // 4 días para prospectos sin venta
    const GRACE_PERIOD_HOURS_WON = 30 * 24; // 30 días (1 mes) para clientes convertidos
    let blockingMsg = null;
    let expiredGraceMsg = null;
    let expiredTimeDiffHours = 0;

    if (newestMsg && fbMessages.length > 1) {
      for (const msg of fbMessages) {
        if (msg.pageId !== targetPageId) {
          const timeDiffHours = (newestMsg.timestamp - msg.timestamp) / (1000 * 60 * 60);
          if (isCustomerWon) {
            // CLIENTE CON VENTA: Bloqueado dentro de sus 30 días (1 mes) de gracia de recompra
            if (timeDiffHours >= 0 && timeDiffHours <= GRACE_PERIOD_HOURS_WON) {
              blockingMsg = msg;
              break;
            } else if (timeDiffHours > GRACE_PERIOD_HOURS_WON) {
              expiredGraceMsg = msg;
              expiredTimeDiffHours = timeDiffHours;
            }
          } else if (timeDiffHours >= 0 && timeDiffHours <= GRACE_PERIOD_HOURS_LEAD) {
            // PROSPECTO SIN VENTA: Bloqueado dentro de sus 4 días de gracia
            blockingMsg = msg;
            break;
          } else if (timeDiffHours > GRACE_PERIOD_HOURS_LEAD) {
            expiredGraceMsg = msg;
            expiredTimeDiffHours = timeDiffHours;
          }
        }
      }
    }

    if (blockingMsg) {
      const blockingPageName = FB_PAGE_ID_MAP[blockingMsg.pageId] || blockingMsg.pageId;
      console.log(`[Agente 3] [GUARD] Blindaje de sede activo para ${contactId}.`);
      console.log(`El contacto acaba de escribir a [${targetPageName}], pero está protegido por [${blockingPageName}] (${isCustomerWon ? 'GRACIA 1 MES DE RECOMPRA ACTIVA' : 'GRACIA 4 DÍAS ACTIVA'}).`);
      console.log(`-> Se aborta la reasignación para mantener la exclusividad de la sede.`);
      return;
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

    // Custom Field IDs Oficiales
    const ID_ANUNCIO_FIELD = '6w3yMjLgIw6npUKWIosr';
    const AD_ID_ALT_FIELD = 'ujLG5Ogp94WfynVubapT';
    const TRATAMIENTO_FIELD = 'WcrrCIL4A2203kIbeFsJ';
    const VTIGER_NOTAS_FIELD = 'cZu95uKBqVydDEh24enl';
    const UTM_SOURCE_FIELD = 'L3eEulpe8II7q0UAJnKZ';
    const UTM_MEDIUM_FIELD = 'HVjiEMKYR2feXviAZ2Jd';
    const UTM_CAMPAIGN_FIELD = 'KS3iYmIjVcmFJV7MIDnT';
    const UTM_CONTENT_FIELD = 'Vmzz5BxbMcrlInmuiblM';

    const existingCustomFields = contact.customFields || [];
    const rawCurrentAdId = existingCustomFields.find(f => (f.id === ID_ANUNCIO_FIELD || f.id === AD_ID_ALT_FIELD) && f.value)?.value;
    const currentAdId = isValidMetaAdId(rawCurrentAdId) ? String(rawCurrentAdId).trim() : null;
    const currentTratamiento = existingCustomFields.find(f => f.id === TRATAMIENTO_FIELD && f.value)?.value;
    const currentVtigerNota = existingCustomFields.find(f => f.id === VTIGER_NOTAS_FIELD && f.value)?.value;

    // 🎯 A. FRESHNESS FIRST: DETECCIÓN DEL AD ID Y CAMPAÑA / UTM
    let latestAdId = null;
    let latestCampaign = null;
    let latestMedium = null;

    // 1. Mensajes de Facebook más recientes (prioridad máxima)
    for (const m of allMessages) {
      const fbMeta = m.meta?.fb || {};
      if (fbMeta.adId && fbMeta.adId !== 'N/A' && isValidMetaAdId(fbMeta.adId)) {
        latestAdId = String(fbMeta.adId).trim();
        break;
      }
    }

    // 2. attributionSource nativo de GHL
    if (contact.attributionSource) {
      if (!latestAdId && isValidMetaAdId(contact.attributionSource.adId)) latestAdId = String(contact.attributionSource.adId).trim();
      if (!latestCampaign) latestCampaign = contact.attributionSource.utmCampaign || contact.attributionSource.campaign;
      if (!latestMedium) latestMedium = contact.attributionSource.utmMedium;
    }

    // 3. Última Atribución registrada en GHL con datos de pauta
    if (contact.attributions && contact.attributions.length > 0) {
      const attrWithData = [...contact.attributions].reverse().find(a => a.utmAdId || a.adId || a.utmCampaign || a.utmMedium);
      const lastAttr = attrWithData || contact.attributions.find(a => a.isLast) || contact.attributions[contact.attributions.length - 1];
      if (lastAttr) {
        const rawAttrId = lastAttr.utmAdId || lastAttr.adId;
        if (!latestAdId && isValidMetaAdId(rawAttrId)) latestAdId = String(rawAttrId).trim();
        if (!latestCampaign && lastAttr.utmCampaign) latestCampaign = lastAttr.utmCampaign;
        if (!latestMedium && lastAttr.utmMedium) latestMedium = lastAttr.utmMedium;
      }
    }

    // 4. Fallback a lastAttributionSource nativo
    if (contact.lastAttributionSource) {
      if (!latestAdId && isValidMetaAdId(contact.lastAttributionSource.adId)) latestAdId = String(contact.lastAttributionSource.adId).trim();
      if (!latestCampaign && contact.lastAttributionSource.utmCampaign) latestCampaign = contact.lastAttributionSource.utmCampaign;
      if (!latestMedium && contact.lastAttributionSource.utmMedium) latestMedium = contact.lastAttributionSource.utmMedium;
    }

    // 🧠 B. ANÁLISIS INTELIGENTE DE SÍNTOMAS (NLP + LEARNING BRAIN) Y DATOS DE ENVÍO
    const combinedText = allMessages.map(m => m.body || '').join(' \n ');
    const shippingData = extractShippingData(combinedText, contact.phone);
    const effectivePhone = contact.phone || (shippingData?.hasPhone ? shippingData.phone : null);

    // 🏢 C. GROUND TRUTH DE VTIGER CRM: Verdad Clínica y Comercial Confirmada
    let vtigerTreatment = null;
    let vContact = null;
    try {
      vContact = await findVTigerContact({ ...contact, phone: effectivePhone });
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
    let latestAdSetName = null;

    // 🔥 ACTUALIZACIÓN CONSTANTE DE UTMs EN VIVO (Meta Graph)
    if (targetAdId && isValidMetaAdId(targetAdId)) {
      const metaDetails = await getMetaAdDetails(targetAdId);
      if (metaDetails) {
        latestCampaign = metaDetails.campaignName || latestCampaign;
        targetAdName = metaDetails.adName || metaDetails.creativeTitle;
        latestAdSetName = metaDetails.adsetName || null;
        console.log(`[Agente 3] [META] UTMs Actualizados en vivo desde Meta: Campaña [${latestCampaign}], AdSet [${latestAdSetName}], Ad [${targetAdName}]`);
      }
    }

    const nlpAnalysis = analyzeSymptoms(combinedText, latestCampaign, latestMedium);

    // 🔬 D. Inferencia Clínica y de Pauta Ponderada:
    // Prioridad 1: Síntomas clínicos y Cerebro de Aprendizaje (NLP) - (La intención ACTUAL del cliente)
    // Prioridad 2: Conjunto de Anuncios / Campaña / Anuncio / UTM Medium (ej: "TETOSTERONA - IN HOUSE - ...", "ARTRITIS - ERNESTO - ...")
    // Prioridad 3: Ground Truth de Ventas vTiger CRM (Útil si el cliente solo dice "Hola" pero sabemos que es paciente crónico de algo)
    // Prioridad 4: Tratamiento previo registrado en GHL
    const utmInferredTreatment = inferTreatmentFromCampaignOrUtm(latestAdSetName) ||
                                  inferTreatmentFromCampaignOrUtm(targetAdName) ||
                                  inferTreatmentFromCampaignOrUtm(latestMedium) ||
                                  inferTreatmentFromCampaignOrUtm(latestCampaign) ||
                                  inferTreatmentFromCampaignOrUtm(contact.attributionSource?.campaign) ||
                                  inferTreatmentFromCampaignOrUtm(contact.attributionSource?.utmContent);

    let targetTratamiento = nlpAnalysis.primaryTreatment || utmInferredTreatment || vtigerTreatment || currentTratamiento || 'General';
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
        const searchRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&query=${encodeURIComponent(fullName)}`, { headers: HEADERS }, 1, isLive);
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
    const isPaidAd = Boolean(
      targetAdId ||
      contact.attributionSource?.sessionSource === 'Paid Social' ||
      contact.attributionSource?.medium === 'facebook' ||
      contact.attributionSource?.adId ||
      contact.attributionSource?.utmCampaign ||
      latestCampaign ||
      latestAdSetName ||
      (contact.tags || []).includes('meta-ads') ||
      (contact.source || '').includes('CLICK2RING') ||
      (contact.source || '').includes('ERNESTO')
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

    const vtigerSource = buildVtigerSource({
      sedeName: targetPageName,
      provider: targetProvider,
      channel: 'FB-MSGR',
      treatment: targetTratamiento || 'General'
    });

    // 🏷️ E. ETIQUETADO INTELIGENTE Y MULTI-CONDICIÓN
    const newTagsSet = new Set((contact.tags || []).map(t => String(t).trim()));
    newTagsSet.add('meta-ads');
    newTagsSet.add('facebook-messenger');

    if (targetPageName) {
      const pageSlug = targetPageName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      newTagsSet.add(pageSlug);
    }

    // 1. Definir la ÚNICA etiqueta de producto permitida (El Tratamiento Principal)
    const ALL_PRODUCT_TAGS = ['producto-artritis', 'producto-diabetes', 'producto-prostata', 'producto-potencia', 'producto-colageno', 'producto-vision', 'producto-gastro'];
    const activeProductTag = targetTratamiento ? `producto-${targetTratamiento.toLowerCase()}` : null;
    
    // 2. Solo añadimos LA etiqueta principal, ignorando detecciones secundarias de NLP para evitar que se disparen múltiples bots
    if (activeProductTag) {
      newTagsSet.add(activeProductTag);
    }

    // 3. 🧹 Limpieza Quirúrgica ESTRICTA de etiquetas huérfanas
    const tagsToRemove = [];
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

    // 🏢 DETECCIÓN DE MUDANZA DE SEDE AUTORIZADA (TIEMPO DE GRACIA EXPIRADO):
    const currentSedeName = (targetPageName?.toLowerCase().includes('bionatural') || targetPageName?.toLowerCase().includes('palacios') || targetPageName?.toLowerCase().includes('ultra'))
      ? 'PALACIOS'
      : (targetPageName ? targetPageName.replace(/Naturales\s*/i, '').trim().toUpperCase() : 'PALACIOS');

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

    const isMudanzaDeSede = Boolean(
      (previousSede && previousSede !== currentSedeName) ||
      (expiredGraceMsg && FB_PAGE_ID_MAP[expiredGraceMsg.pageId] && !FB_PAGE_ID_MAP[expiredGraceMsg.pageId].toLowerCase().includes('palacios') && currentSedeName === 'PALACIOS')
    );

    if (isMudanzaDeSede) {
      newTagsSet.add('mudanza-gracia-expirada');
      newTagsSet.add('mudanza-de-sede');
      if (previousSede) newTagsSet.add(`mudanza-desde-${previousSede.toLowerCase()}`);
      newTagsSet.add(`sede-${currentSedeName.toLowerCase()}`);

      const mudanzaDate = new Date().toLocaleDateString('es-PE');
      const mudanzaHeader = `[MUDANZA AUTORIZADA ${mudanzaDate}: De ${previousSede || 'Sede Previa'} a ${currentSedeName} (Gracia Expirada)]`;
      if (!targetVtigerNota || !targetVtigerNota.includes(mudanzaHeader)) {
        targetVtigerNota = `${mudanzaHeader}\n${targetVtigerNota || ''}`.trim();
      }
    }

    // Alerta de Lead Caliente (Teléfono o Dirección)
    if (shippingData.isHotLead) {
      newTagsSet.add('🔥-lead-caliente');
    }

    if (targetVtigerNota) {
      newTagsSet.add('vtiger');
      newTagsSet.add('prospecto-vtiger');
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
    
    // UTMs
    customFieldsToUpdate.push({ id: UTM_SOURCE_FIELD, key: 'contact.utm_source', field_value: 'facebook' });
    customFieldsToUpdate.push({ id: UTM_MEDIUM_FIELD, key: 'contact.utm_medium', field_value: isPaidAd ? 'cpc' : 'messenger' });
    if (latestCampaign) customFieldsToUpdate.push({ id: UTM_CAMPAIGN_FIELD, key: 'contact.utm_campaign', field_value: latestCampaign });
    if (targetAdName) customFieldsToUpdate.push({ id: UTM_CONTENT_FIELD, key: 'contact.utm_content', field_value: targetAdName });

    // 🏢 G. SINCRONIZACIÓN COMERCIAL CON VTIGER Y PURGA DE COMPRAS FALSAS (EN VIVO - DOMINIO AISLADO)
    let finalCustomerWon = isCustomerWon;
    let finalMonetaryValue = 0;
    try {
      const truth = evaluateCommercialTruth(contact, vContact);
      finalCustomerWon = truth.isWon;
      finalMonetaryValue = truth.totalSpent;
      const sanitizedCommercialFields = buildSanitizedCommercialFields(contact, vContact);
      customFieldsToUpdate.push(...sanitizedCommercialFields);
    } catch (commErr) {
      console.warn(`[Agente 3] [WARN] No se pudo evaluar estado comercial en vivo para ${contactId}:`, commErr.message);
    }

    // SINCRONIZACION DE PIPELINE (Orquestacion LOA)
    try {
      const cleanSede = (targetPageName?.toLowerCase().includes('bionatural') || targetPageName?.toLowerCase().includes('palacios')) 
        ? 'PALACIOS' 
        : (targetPageName ? targetPageName.replace(/Naturales\s*/i, '').trim().toUpperCase() : 'SEDE');
      const campaignSnippet = (latestCampaign || targetAdName || 'Directa').substring(0, 32);
      const prodPrefix = targetTratamiento && targetTratamiento !== 'General' ? `[${targetTratamiento.toUpperCase()}] ` : '';
      const cardTitle = `${prodPrefix}${fullName} | ${cleanSede} | ${campaignSnippet}`;
      await syncUnifiedPipelineOpportunity(contactId, cardTitle, finalCustomerWon, true, finalMonetaryValue, targetAdvisorId);
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
        headers: HEADERS,
        body: JSON.stringify({ tags: tagsToRemove })
      }, 1, isLive);
    }

    const CRITICAL_CF_IDS = [
      ID_ANUNCIO_FIELD, AD_ID_ALT_FIELD, TRATAMIENTO_FIELD, VTIGER_NOTAS_FIELD,
      UTM_SOURCE_FIELD, UTM_MEDIUM_FIELD, UTM_CAMPAIGN_FIELD, UTM_CONTENT_FIELD,
      '8EQtKkiW7Z022bcN0vhS', '5TY5AIOpu1c8f6WosyF2', 'RLxFOTXkICXLWShjaLaB',
      'GZKRu2z1Z156lRUfyrpo', '5js0Lfbh5XDLq87SDgdT'
    ];
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
      return;
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
      headers: HEADERS,
      body: JSON.stringify(updatePayload)
    }, 1, isLive);

    if (updateRes.status === 200) {
      if (global.pushLiveLog) {
        global.pushLiveLog(`[ROUTING] Agente 3: ${contact.name || 'Lead'} -> ${targetAdvisorName} | Src: ${vtigerSource}`);
      }
      console.log(`[Agente 3] [SUCCESS] ${contact.firstName || ''} ${contact.lastName || ''} (${contactId}) | Ad ID: ${targetAdId || 'N/A'} | Fuente: ${vtigerSource} | Estado: ${updatePayload.state || contact.state || '--'} | Actualizado OK.`);

      // 📌 H. SAVE PROCESS: INYECTAR NOTA HISTÓRICA SOLO SI HUBO CAMBIO DE AD O DE TRATAMIENTO
      const adChanged = latestAdId && latestAdId !== currentAdId;
      const treatmentChanged = targetTratamiento && targetTratamiento !== currentTratamiento;

      if (adChanged || treatmentChanged) {
        await saveAdHistoryNote(contactId, {
          newAdId: latestAdId,
          oldAdId: currentAdId || 'Ninguna previa',
          campaign: latestCampaign || 'Pauta Reciente',
          pageName: targetPageName,
          clickCount: duplicateCount,
          source: vtigerSource,
          treatment: targetTratamiento
        });
      }

      // 📌 I. REGISTRO HISTÓRICO DE PROCEDENCIA DE MUDANZA EN TARJETA DE NOTAS
      if (isMudanzaDeSede) {
        const daysPassed = expiredTimeDiffHours > 0 ? Math.round(expiredTimeDiffHours / 24) : 5;
        const timeStr = expiredTimeDiffHours > 0 ? `${daysPassed} días (${Math.round(expiredTimeDiffHours)}h)` : '+4 días (Tiempo de Gracia Expirado)';
        const motivoStr = isCustomerWon ? 'Gracia de recompra expirada (+30 días)' : 'Gracia de prospecto expirada (+4 días / 96h)';
        await saveMudanzaHistoryNote(contactId, {
          previousSede: previousSede || 'Sede Externa',
          previousSource: previousSource || 'Sin fuente previa',
          currentSede: currentSedeName,
          newSource: vtigerSource,
          advisorName: targetAdvisorName,
          pageName: targetPageName,
          campaign: latestCampaign || targetAdName,
          motivo: motivoStr,
          timeDiffStr: timeStr,
          isCustomerWon,
          vContact
        });
      }
    } else {
      const errText = await updateRes.text();
      const isDuplicateConflict = updateRes.status === 400 && errText.includes('duplicated contacts') && errText.includes('matchingField');
      
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
              headers: HEADERS,
              body: JSON.stringify(updatePayload)
            }, 1, isLive);
            
            if (retryRes.status === 200) {
               console.log(`[Agente 3] [SUCCESS] [AUTO-HEAL] Contacto ${contactId} actualizado exitosamente tras esquivar conflicto de duplicado.`);
               
               if (rescateValor && isLive) {
                 try {
                   const notaText = `[AVISO] NÚMERO RESCATADO DE VTIGER: ${rescateValor}\n(GHL bloqueó la inserción automática porque este número ya le pertenece a otro contacto/familiar en esta ubicación. Usa este número para llamar.)`;
                   await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
                     method: 'POST',
                     headers: HEADERS,
                     body: JSON.stringify({ body: notaText, userId: updatePayload.assignedTo || null })
                   }, 1, true);
                   console.log(`[Agente 3] [NOTE] Nota de Rescate insertada exitosamente en GHL para ${contactId}.`);
                 } catch (noteErr) {
                   console.log(`[Agente 3] [WARN] No se pudo insertar la nota de rescate: ${noteErr.message}`);
                 }
               }
               return;
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
    // Buscar conversaciones que tuvieron actividad reciente
    const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&limit=20`;
    const res = await fetchWithRetry(convUrl, { headers: HEADERS });
    
    if (res.status !== 200) return;
    
    const data = await res.json();
    const conversations = data.conversations || [];
    
    for (const conv of conversations) {
      if (!conv.contactId) continue;
      const lastProc = processedTimestamps.get(conv.contactId) || 0;
      if (Date.now() - lastProc > 60000) { // 60 segundos de debounce por contacto
        processedTimestamps.set(conv.contactId, Date.now());
        routeChatByContact(conv.contactId).catch(err => console.error(err));
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
  for (const [, advisor] of Object.entries(PALACIOS_USERS)) {
    try {
      const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&assignedTo=${advisor.id}&limit=20`;
      const res = await fetchWithRetry(convUrl, { headers: HEADERS });
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
