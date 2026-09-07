import { GHL_CONFIG, FB_PAGE_ID_MAP, PALACIOS_USERS } from '../config/index.js';
import { analyzeSymptoms, extractShippingData, buildVtigerSource } from './nlp_symptom_engine.js';
import { isContextualDuplicate } from './fuzzy_matcher.js';

const { apiKey, locationId } = GHL_CONFIG;

/**
 * 📌 Save Process: Inyecta una Nota Histórica en el perfil de GHL ante un nuevo toque o cambio de pauta
 */
export async function saveAdHistoryNote(contactId, { newAdId, oldAdId, campaign, pageName, clickCount }) {
  const dateStr = new Date().toLocaleString('es-PE', { timeZone: 'America/New_York' });
  const noteBody = `📌 [SAVE PROCESS: HISTORIAL DE REINGRESO PUBLICITARIO]
• Fecha: ${dateStr} (EST)
• Nuevo Ad ID: ${newAdId || 'Orgánico / Sin Ad'}
• Anuncio / Campaña Previa: ${oldAdId || 'Ninguna previa'}
• Fanpage de Entrada: ${pageName || 'N/A'}
• Campaña Detectada: ${campaign || 'N/A'}
• Interacción: Clic #${clickCount || 1}`;

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

    // 4. REGLA ANTI-VIVAZOS (Cooldown de 24 horas)
    // Buscar si hay algún mensaje reciente hacia OTRA página
    let blockingMsg = null;
    if (newestMsg && fbMessages.length > 1) {
      for (const msg of fbMessages) {
        if (msg.pageId !== targetPageId) {
          const timeDiffHours = (newestMsg.timestamp - msg.timestamp) / (1000 * 60 * 60);
          if (timeDiffHours >= 0 && timeDiffHours < 24) {
            blockingMsg = msg;
            break; // Encontramos un mensaje de otra página hace menos de 24h
          }
        }
      }
    }

    if (blockingMsg) {
      const blockingPageName = FB_PAGE_ID_MAP[blockingMsg.pageId] || blockingMsg.pageId;
      console.log(`[Agente 3] 🛡️ REGLA ANTI-VIVAZOS ACTIVADA para ${contactId}.`);
      console.log(`El contacto acaba de escribir a [${targetPageName}], pero hace menos de 24h le escribió a [${blockingPageName}].`);
      console.log(`-> Se aborta la reasignación para mantener el orden interno.`);
      return;
    }

    // 5. Cargar contacto de GHL para reasignación e inyección inteligente
    const contactRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: HEADERS });
    if (contactRes.status !== 200) return;

    const contactData = await contactRes.json();
    const contact = contactData.contact || contactData;

    // 🛡️ CANDADO DE INTERACCIÓN ACTIVA (15 MINUTOS):
    // Si el contacto ya tiene un asesor asignado en GHL y hubo cualquier actividad
    // (mensaje entrante del cliente o saliente del asesor) en los últimos 15 minutos,
    // CONGELAMOS la asignación en contact.assignedTo.
    // Esto garantiza que el chat NUNCA desaparezca ni salte de la pantalla del asesor mientras atiende.
    if (contact.assignedTo) {
      let newestTimestamp = 0;
      for (const m of allMessages) {
        const t = new Date(m.dateAdded).getTime();
        if (t > newestTimestamp) newestTimestamp = t;
      }
      if (newestTimestamp === 0 && newestMsg) {
        newestTimestamp = newestMsg.timestamp;
      }

      const minutesSinceLastMsg = newestTimestamp > 0 ? (Date.now() - newestTimestamp) / (1000 * 60) : 999;
      if (minutesSinceLastMsg < 15) {
        if (contact.assignedTo !== targetAdvisorId) {
          console.log(`[Agente 3] ⏸️ CANDADO DE INTERACCIÓN ACTIVO para ${contactId}: Actividad reciente hace ${minutesSinceLastMsg.toFixed(1)}m. Se congela asignación en asesor actual (${contact.assignedTo}) para no interrumpir el chat.`);
        }
        targetAdvisorId = contact.assignedTo;
        const currentAdvisor = Object.values(PALACIOS_USERS).find(u => u.id === contact.assignedTo);
        if (currentAdvisor) targetAdvisorName = currentAdvisor.name;
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

    // 🧠 A. ANÁLISIS NLP INTELIGENTE DE SÍNTOMAS Y DATOS DE ENVÍO
    const combinedText = allMessages.map(m => m.body || '').join(' \n ');
    const nlpAnalysis = analyzeSymptoms(combinedText);
    const shippingData = extractShippingData(combinedText);

    // 🎯 B. FRESHNESS FIRST: DETECCIÓN DEL AD ID MÁS RECIENTE
    let latestAdId = null;
    let latestCampaign = null;

    // 1. Mensajes de Facebook más recientes (prioridad máxima)
    for (const m of allMessages) {
      const fbMeta = m.meta?.fb || {};
      if (fbMeta.adId && fbMeta.adId !== 'N/A') {
        latestAdId = String(fbMeta.adId);
        break;
      }
    }

    // 2. Última Atribución registrada en GHL (isLast: true)
    if (!latestAdId && contact.attributions && contact.attributions.length > 0) {
      const lastAttr = contact.attributions.find(a => a.isLast) || contact.attributions[contact.attributions.length - 1];
      if (lastAttr) {
        if (lastAttr.utmAdId || lastAttr.adId) latestAdId = String(lastAttr.utmAdId || lastAttr.adId);
        if (lastAttr.utmCampaign) latestCampaign = lastAttr.utmCampaign;
      }
    }

    // 3. Fallback a lastAttributionSource nativo
    if (!latestAdId && contact.lastAttributionSource?.adId) {
      latestAdId = String(contact.lastAttributionSource.adId);
    }

    let targetAdId = latestAdId || currentAdId || null;
    let targetTratamiento = nlpAnalysis.primaryTreatment || currentTratamiento || null;
    let targetVtigerNota = currentVtigerNota || null;
    let duplicateCount = 1;

    // 🔍 C. FUZZY MATCHING FORENSE (Deduplicación Contextual de Historial)
    const fullName = `${contact.firstName || ''} ${contact.lastName || ''}`.trim();
    if ((!targetVtigerNota || !targetAdId || !targetTratamiento) && fullName.length >= 3) {
      try {
        const searchRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&query=${encodeURIComponent(fullName)}`, { headers: HEADERS });
        if (searchRes.status === 200) {
          const sData = await searchRes.json();
          const matches = (sData.contacts || []).filter(c => c.id !== contact.id);

          for (const m of matches) {
            if (isContextualDuplicate(contact, m, 0.90)) {
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
      } catch (err) {
        console.error(`[Agente 3 Fuzzy Error] ${fullName}:`, err.message);
      }
    }

    // 🏷️ D. PREPARACIÓN DE FUENTE ESTILO VTIGER: [SEDE]-[PROVEEDOR]-[CANAL]-[TRATAMIENTO]
    const vtigerSource = buildVtigerSource({
      sedeName: targetPageName,
      provider: targetAdId ? 'CLICK2RING' : 'IN_HOUSE',
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

    // Añadir todas las etiquetas de productos detectadas por NLP
    nlpAnalysis.productTags.forEach(t => newTagsSet.add(t));
    if (targetTratamiento && !nlpAnalysis.productTags.includes(`producto-${targetTratamiento.toLowerCase()}`)) {
      newTagsSet.add(`producto-${targetTratamiento.toLowerCase()}`);
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
    if (targetAdId) customFieldsToUpdate.push({ id: ID_ANUNCIO_FIELD, field_value: String(targetAdId) });
    if (targetTratamiento) customFieldsToUpdate.push({ id: TRATAMIENTO_FIELD, field_value: targetTratamiento });
    if (targetVtigerNota) customFieldsToUpdate.push({ id: VTIGER_NOTAS_FIELD, field_value: targetVtigerNota });
    
    // UTMs
    customFieldsToUpdate.push({ id: UTM_SOURCE_FIELD, field_value: 'facebook' });
    customFieldsToUpdate.push({ id: UTM_MEDIUM_FIELD, field_value: targetAdId ? 'cpc' : 'messenger' });
    if (latestCampaign) customFieldsToUpdate.push({ id: UTM_CAMPAIGN_FIELD, field_value: latestCampaign });

    // 📦 G. CONSTRUIR PAYLOAD ATÓMICO (1 SOLO PUT)
    const updatePayload = {
      assignedTo: targetAdvisorId, // Regla de Oro: Sede actual
      source: vtigerSource,        // Fuente de contacto estilo vTiger
      tags: Array.from(newTagsSet),
      customFields: customFieldsToUpdate
    };

    // Inyectar teléfono si el contacto no lo tenía y fue detectado en chat
    if (!contact.phone && shippingData.hasPhone) {
      updatePayload.phone = shippingData.phone;
    }
    // Inyectar dirección si el contacto no la tenía y fue detectada en chat
    if (!contact.address1 && shippingData.hasAddress) {
      updatePayload.address1 = shippingData.address;
    }

    // 🔍 Filtro Silencioso: Comprobar si realmente hay cambios antes de hacer PUT
    const isSameAdvisor = contact.assignedTo === targetAdvisorId;
    const isSameSource = contact.source === vtigerSource;
    const currentTags = (contact.tags || []).map(t => String(t).trim());
    const hasNewTags = Array.from(newTagsSet).some(t => !currentTags.includes(t));
    const currentCFs = contact.customFields || [];
    const hasCFChanges = customFieldsToUpdate.some(cf => {
      const existing = currentCFs.find(f => f.id === cf.id);
      return !existing || existing.value !== cf.field_value;
    });
    const hasPhoneUpdate = !contact.phone && shippingData.hasPhone;
    const hasAddressUpdate = !contact.address1 && shippingData.hasAddress;

    const hasChanges = !isSameAdvisor || !isSameSource || hasNewTags || hasCFChanges || hasPhoneUpdate || hasAddressUpdate;

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
      console.log(`[Agente 3] ✅ ÉXITO: Contacto ${contactId} actualizado al 100% (Asesor: ${targetAdvisorName} | Source: ${vtigerSource}).`);

      // 📌 H. SAVE PROCESS: INYECTAR NOTA HISTÓRICA EN GHL SI HUBO CAMBIO DE AD ID O REINGRESO
      const shouldSaveNote = (latestAdId && currentAdId && latestAdId !== currentAdId) || 
                             (duplicateCount > 1) || 
                             (latestAdId && !currentAdId);

      if (shouldSaveNote) {
        await saveAdHistoryNote(contactId, {
          newAdId: latestAdId,
          oldAdId: currentAdId || 'Ninguna previa',
          campaign: latestCampaign || 'Pauta Reciente',
          pageName: targetPageName,
          clickCount: duplicateCount
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
