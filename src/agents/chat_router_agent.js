import { GHL_CONFIG, FB_PAGE_ID_MAP, PALACIOS_USERS } from '../config/index.js';
import { analyzeSymptoms, extractShippingData, buildVtigerSource, inferTreatmentFromCampaignOrUtm } from './nlp_symptom_engine.js';
import { isContextualDuplicate } from './fuzzy_matcher.js';
import { findVTigerContact } from '../services/vtiger_api_service.js';
import { learningBrain } from '../services/learning_brain.js';
import { buildSanitizedCommercialFields, evaluateCommercialTruth } from '../domain/commercial_engine.js';
import { syncUnifiedPipelineOpportunity } from '../services/ghl_opportunity_service.js';

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
    console.log(`[Agente 4 Save Process] 📝 Nota histórica inyectada para contacto ${contactId}`);
  } catch (err) {
    console.error(`[Agente 4 Save Process Error]:`, err.message);
  }
}

const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let routerRateLimitBlockedUntil = 0;

async function fetchWithRetry(url, options, attempt = 1) {
  const now = Date.now();
  if (now < routerRateLimitBlockedUntil) {
    const waitMs = routerRateLimitBlockedUntil - now;
    await sleep(waitMs);
  }

  try {
    if (global.apiCounters) global.apiCounters.ghl++;
    const res = await fetch(url, options);
    if (res.status === 429) {
      console.warn(`[Chat Router Shield] ⚠️ GHL retornó 429. Pausando peticiones durante 60 segundos...`);
      routerRateLimitBlockedUntil = Date.now() + 60000;
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
 * Agente 3: Chat Router
 * Evalúa los últimos mensajes de un contacto para enrutar el chat a la sede correcta,
 * aplicando una regla "Anti-Vivazos" (cooldown de 24 horas) para evitar rebotes entre oficinas.
 */
export async function routeChatByContact(contactId) {
  try {
    console.log(`[Agente 3] Analizando ruteo para el contacto ${contactId}...`);

    // 1. Obtener la conversación del contacto
    const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&contactId=${contactId}`;
    const convRes = await fetchWithRetry(convUrl, { headers: HEADERS });
    
    if (convRes.status !== 200) {
      console.log(`[Agente 3] No se pudieron obtener las conversaciones para ${contactId}`);
      return;
    }

    const convData = await convRes.json();
    const conversations = convData.conversations || [];
    
    if (conversations.length === 0) {
      console.log(`[Agente 3] Sin conversaciones para ${contactId}.`);
      return;
    }

    // Usaremos la conversación más reciente
    const convId = conversations[0].id;

    // 2. Traer los últimos mensajes (pedimos unos 20 para ver el historial cercano)
    const msgUrl = `https://services.leadconnectorhq.com/conversations/${convId}/messages?locationId=${locationId}&limit=20`;
    const msgRes = await fetchWithRetry(msgUrl, { headers: HEADERS });
    
    if (msgRes.status !== 200) {
      console.log(`[Agente 3] No se pudieron obtener los mensajes para la conv ${convId}`);
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
      const cRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: HEADERS });
      if (cRes.status === 200) {
        const cData = await cRes.json();
        const c = cData.contact || cData;
        const tags = (c.tags || []).map(t => String(t).toLowerCase());
        for (const [pName, tag] of Object.entries(PAGE_TAG_MAP)) {
          if (tags.includes(tag.toLowerCase())) {
            targetPageName = pName;
            break;
          }
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

    // 5. Cargar contacto de GHL para reasignación e inyección inteligente
    const contactRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: HEADERS });
    if (contactRes.status !== 200) return;

    const contactData = await contactRes.json();
    const contact = contactData.contact || contactData;
    const existingTags = (contact.tags || []).map(t => String(t).toLowerCase());
    const isCustomerWon = existingTags.includes('cliente-comprador') || existingTags.includes('venta-cerrada');

    // 4. REGLA DE TIEMPO DE GRACIA (4 DÍAS SIN VENTA / 30 DÍAS CON VENTA)
    const GRACE_PERIOD_HOURS_LEAD = 96; // 4 días para prospectos sin venta
    const GRACE_PERIOD_HOURS_WON = 30 * 24; // 30 días (1 mes) para clientes convertidos
    let blockingMsg = null;

    if (newestMsg && fbMessages.length > 1) {
      for (const msg of fbMessages) {
        if (msg.pageId !== targetPageId) {
          const timeDiffHours = (newestMsg.timestamp - msg.timestamp) / (1000 * 60 * 60);
          if (isCustomerWon) {
            // CLIENTE CON VENTA: Bloqueado dentro de sus 30 días (1 mes) de gracia de recompra
            if (timeDiffHours >= 0 && timeDiffHours <= GRACE_PERIOD_HOURS_WON) {
              blockingMsg = msg;
              break;
            }
          } else if (timeDiffHours >= 0 && timeDiffHours <= GRACE_PERIOD_HOURS_LEAD) {
            // PROSPECTO SIN VENTA: Bloqueado dentro de sus 4 días de gracia
            blockingMsg = msg;
            break;
          }
        }
      }
    }

    if (blockingMsg) {
      const blockingPageName = FB_PAGE_ID_MAP[blockingMsg.pageId] || blockingMsg.pageId;
      console.log(`[Agente 3] 🛡️ BLINDAJE DE SEDE ACTIVO para ${contactId}.`);
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
          console.log(`[Agente 3] 🛡️ UX GUARD ACTIVO: El asesor actual está chateando activamente. Se congela TODO ruteo y actualización para no interrumpir la pantalla.`);
          return;
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

    const existingCustomFields = contact.customFields || [];
    const currentAdId = existingCustomFields.find(f => (f.id === ID_ANUNCIO_FIELD || f.id === AD_ID_ALT_FIELD) && f.value)?.value;
    const currentTratamiento = existingCustomFields.find(f => f.id === TRATAMIENTO_FIELD && f.value)?.value;
    const currentVtigerNota = existingCustomFields.find(f => f.id === VTIGER_NOTAS_FIELD && f.value)?.value;

    // 🎯 A. FRESHNESS FIRST: DETECCIÓN DEL AD ID Y CAMPAÑA / UTM
    let latestAdId = null;
    let latestCampaign = null;
    let latestMedium = null;

    // 1. Mensajes de Facebook más recientes (prioridad máxima)
    for (const m of allMessages) {
      const fbMeta = m.meta?.fb || {};
      if (fbMeta.adId && fbMeta.adId !== 'N/A') {
        latestAdId = String(fbMeta.adId);
        break;
      }
    }

    // 2. attributionSource nativo de GHL
    if (contact.attributionSource) {
      if (!latestAdId && contact.attributionSource.adId) latestAdId = String(contact.attributionSource.adId);
      if (!latestCampaign) latestCampaign = contact.attributionSource.utmCampaign || contact.attributionSource.campaign;
      if (!latestMedium) latestMedium = contact.attributionSource.utmMedium;
    }

    // 3. Última Atribución registrada en GHL (isLast: true)
    if (contact.attributions && contact.attributions.length > 0) {
      const lastAttr = contact.attributions.find(a => a.isLast) || contact.attributions[contact.attributions.length - 1];
      if (lastAttr) {
        if (!latestAdId && (lastAttr.utmAdId || lastAttr.adId)) latestAdId = String(lastAttr.utmAdId || lastAttr.adId);
        if (!latestCampaign && lastAttr.utmCampaign) latestCampaign = lastAttr.utmCampaign;
        if (!latestMedium && lastAttr.utmMedium) latestMedium = lastAttr.utmMedium;
      }
    }

    // 4. Fallback a lastAttributionSource nativo
    if (contact.lastAttributionSource) {
      if (!latestAdId && contact.lastAttributionSource.adId) latestAdId = String(contact.lastAttributionSource.adId);
      if (!latestCampaign && contact.lastAttributionSource.utmCampaign) latestCampaign = contact.lastAttributionSource.utmCampaign;
      if (!latestMedium && contact.lastAttributionSource.utmMedium) latestMedium = contact.lastAttributionSource.utmMedium;
    }

    let targetAdId = latestAdId || currentAdId || null;

    // 🧠 B. ANÁLISIS INTELIGENTE DE SÍNTOMAS (NLP + LEARNING BRAIN) Y DATOS DE ENVÍO
    const combinedText = allMessages.map(m => m.body || '').join(' \n ');
    const nlpAnalysis = analyzeSymptoms(combinedText, latestCampaign, latestMedium);
    const shippingData = extractShippingData(combinedText, contact.phone);

    // 🏢 C. GROUND TRUTH DE VTIGER CRM: Verdad Clínica y Comercial Confirmada
    let vtigerTreatment = null;
    let vContact = null;
    try {
      vContact = await findVTigerContact(contact);
      if (vContact) {
        const vCond = vContact.cf_2610 || '';
        vtigerTreatment = inferTreatmentFromCampaignOrUtm(vCond) || (vCond.length > 2 ? vCond : null);
        if (vtigerTreatment) {
          console.log(`[Agente 3] 🏢 Ground Truth vTiger para ${contact.id}: [${vtigerTreatment}]`);
          learningBrain.learnFromVtigerSale({
            treatment: vtigerTreatment,
            chatText: combinedText,
            campaignName: latestCampaign
          });
        }
      }
    } catch (vErr) {
      // Continuar con NLP si vTiger no responde
    }

    // 🔬 D. Inferencia Clínica y de Pauta Ponderada:
    // Prioridad 1: Ground Truth de Ventas vTiger CRM
    // Prioridad 2: Síntomas clínicos y Cerebro de Aprendizaje (NLP)
    // Prioridad 3: Campaña / Anuncio / UTM Medium (ej: "DOMINGOS - COLÁGENO...", "MUESTRA GRATIS POTENCIA")
    // Prioridad 4: Tratamiento previo registrado
    const utmInferredTreatment = inferTreatmentFromCampaignOrUtm(latestMedium) ||
                                  inferTreatmentFromCampaignOrUtm(latestCampaign) ||
                                  inferTreatmentFromCampaignOrUtm(contact.attributionSource?.campaign) ||
                                  inferTreatmentFromCampaignOrUtm(contact.attributionSource?.utmContent);

    let targetTratamiento = vtigerTreatment || nlpAnalysis.primaryTreatment || utmInferredTreatment || currentTratamiento || 'General';
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
        const searchRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&query=${encodeURIComponent(fullName)}`, { headers: HEADERS });
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

                if (!targetVtigerNota && vN) targetVtigerNota = vN.value;
                if (!targetAdId && (aId || attrA)) targetAdId = String(aId?.value || attrA?.utmAdId || attrA?.adId);
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
      (contact.tags || []).includes('meta-ads') ||
      (contact.source || '').includes('CLICK2RING')
    );

    const vtigerSource = buildVtigerSource({
      sedeName: targetPageName,
      provider: isPaidAd ? 'CLICK2RING' : 'IN_HOUSE',
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

    // Añadir todas las etiquetas de productos detectadas por NLP o UTM
    nlpAnalysis.productTags.forEach(t => newTagsSet.add(t));
    if (targetTratamiento && !nlpAnalysis.productTags.includes(`producto-${targetTratamiento.toLowerCase()}`)) {
      newTagsSet.add(`producto-${targetTratamiento.toLowerCase()}`);
    }

    // 🧹 Limpieza quirúrgica de etiquetas de productos huérfanas / falsas:
    // Si se identificó un producto claro (por NLP o UTM), eliminar etiquetas de otros productos
    const ALL_PRODUCT_TAGS = ['producto-artritis', 'producto-diabetes', 'producto-prostata', 'producto-potencia', 'producto-colageno', 'producto-vision', 'producto-gastro'];
    const activeProductTag = targetTratamiento ? `producto-${targetTratamiento.toLowerCase()}` : null;
    if (activeProductTag) {
      for (const pTag of ALL_PRODUCT_TAGS) {
        if (pTag !== activeProductTag && !nlpAnalysis.productTags.includes(pTag)) {
          newTagsSet.delete(pTag);
        }
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

    // 📝 F. PREPARAR CUSTOM FIELDS (FULL DATA STACK)
    const customFieldsToUpdate = [];
    if (targetAdId) {
      customFieldsToUpdate.push({ id: ID_ANUNCIO_FIELD, key: 'contact.id_de_anuncio', field_value: String(targetAdId) });
      customFieldsToUpdate.push({ id: AD_ID_ALT_FIELD, key: 'contact.ad_id', field_value: String(targetAdId) });
    }
    if (targetTratamiento && targetTratamiento !== 'General') {
      customFieldsToUpdate.push({ id: TRATAMIENTO_FIELD, key: 'contact.tratamiento_comprado', field_value: targetTratamiento });
    }
    if (targetVtigerNota) customFieldsToUpdate.push({ id: VTIGER_NOTAS_FIELD, key: 'contact.vtiger_historial_completo', field_value: targetVtigerNota });
    
    // UTMs
    customFieldsToUpdate.push({ id: UTM_SOURCE_FIELD, key: 'contact.utm_source', field_value: 'facebook' });
    customFieldsToUpdate.push({ id: UTM_MEDIUM_FIELD, key: 'contact.utm_medium', field_value: isPaidAd ? 'cpc' : 'messenger' });
    if (latestCampaign) customFieldsToUpdate.push({ id: UTM_CAMPAIGN_FIELD, key: 'contact.utm_campaign', field_value: latestCampaign });

    // 🏢 G. SINCRONIZACIÓN COMERCIAL CON VTIGER Y PURGA DE COMPRAS FALSAS (EN VIVO - DOMINIO AISLADO)
    let isCustomerWon = false;
    try {
      const truth = evaluateCommercialTruth(contact, vContact);
      isCustomerWon = truth.isWon;
      const sanitizedCommercialFields = buildSanitizedCommercialFields(contact, vContact);
      customFieldsToUpdate.push(...sanitizedCommercialFields);
    } catch (commErr) {
      console.warn(`[Agente 3] ⚠️ No se pudo evaluar estado comercial en vivo para ${contactId}:`, commErr.message);
    }

    // 🚀 SINCRONIZACIÓN DE PIPELINE (Orquestación LOA)
    try {
      await syncUnifiedPipelineOpportunity(contactId, fullName, isCustomerWon);
    } catch (oppErr) {
      console.error(`[Agente 3] Error sincronizando pipeline para ${contactId}:`, oppErr.message);
    }

    // 📦 G. CONSTRUIR PAYLOAD ATÓMICO (1 SOLO PUT)
    const updatePayload = {
      assignedTo: targetAdvisorId, // Regla de Oro: Sede actual
      source: vtigerSource,        // Fuente de contacto estilo vTiger
      tags: Array.from(newTagsSet),
      customFields: customFieldsToUpdate
    };

    // 🌍 INYECCIÓN AUTOMÁTICA DE "GENERAL INFO" (ESTRICTO USA)
    // 1. Teléfono
    if (!contact.phone && shippingData.hasPhone) {
      updatePayload.phone = shippingData.phone;
    }

    // 2. País (Siempre United States / US)
    if (!contact.country || contact.country === '--') {
      updatePayload.country = 'United States';
    }

    // 3. Dirección Postal (address1)
    if (!contact.address1 && shippingData.address1) {
      updatePayload.address1 = shippingData.address1;
    }

    // 4. Ciudad (city)
    if (!contact.city && shippingData.city) {
      updatePayload.city = shippingData.city;
    }

    // 5. Región / Estado (state: e.g. TX, FL, CA, NY)
    if ((!contact.state || contact.state === '--') && shippingData.state) {
      updatePayload.state = shippingData.state;
    }

    // 6. Código Postal (postalCode: e.g. 33135, 77002)
    if (!contact.postalCode && shippingData.postalCode) {
      updatePayload.postalCode = shippingData.postalCode;
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
    const CRITICAL_CF_IDS = [
      ID_ANUNCIO_FIELD, AD_ID_ALT_FIELD, TRATAMIENTO_FIELD, VTIGER_NOTAS_FIELD,
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
      console.log(`[Agente 3] ⚡ Contacto ${contactId} ya está 100% sincronizado. Omitiendo PUT para evitar parpadeos en pantalla.`);
      return;
    }

    const updateRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify(updatePayload)
    });

    if (updateRes.status === 200) {
      if (global.pushLiveLog) {
        global.pushLiveLog(`⚡ Agente 3: ${contact.name || 'Lead'} -> ${targetAdvisorName} | Src: ${vtigerSource}`);
      }
      console.log(`[Agente 3] ✅ ÉXITO: ${contact.firstName || ''} ${contact.lastName || ''} (${contactId}) | Ad ID: ${targetAdId || 'N/A'} | Fuente: ${vtigerSource} | Estado: ${updatePayload.state || contact.state || '--'} | Actualizado OK.`);

      // 📌 H. SAVE PROCESS: INYECTAR NOTA HISTÓRICA EN GHL SIEMPRE QUE HAYA UN RUTEO EFECTIVO
      const shouldSaveNote = true; // El usuario pidió visibilidad inmediata del trabajo del motor en la sección de Notas

      if (shouldSaveNote) {
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
    } else {
      console.error(`[Agente 3] Falló actualización atómica de ${contactId}. Status: ${updateRes.status}`);
    }

  } catch (error) {
    console.error(`[Agente 3] Error crítico en routeChatByContact:`, error.message);
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
