import { GHL_CONFIG, PAGE_TAG_MAP, PALACIOS_USERS, FB_PAGE_ID_MAP } from '../config/index.js';
import { excludeLeadFromMetaAds, sendMetaConversionEvent, getMetaAdDetails } from '../services/meta_api_service.js';
import fs from 'fs';
import path from 'path';

// Cache local en memoria para no exceder los límites de la API de Meta
const metaAdCache = new Map();

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS_CONTACTS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

const HEADERS_CONV = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-04-15',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

// Pipelines & Stages IDs
const MASTER_PIPELINE_ID = 'yDWAU0AGW3QiivEz4VJg';
const MASTER_STAGE_PRECALIFICADO_ID = '29293e88-d26e-4095-bde9-d40aa0cf1024';
const MASTER_STAGE_CALIFICADO_ID = '5e7d5fb0-0a71-46df-aa42-912fe0b487f1';

let AUDIT_PIPELINE_ID = 'UuLt1X7copaVFO50wIfU';
let STAGE_INTAKE_ID = 'd53708d8-3f95-486c-9f2f-a1425ce67874';
let STAGE_X1_ID = '1508276b-2f3b-4827-956a-a9f646baba97';
let STAGE_X2_ID = '1ef02601-a1f4-4125-8a3b-69fb2daf93bb';
let STAGE_X3_ID = 'ca77226a-08c2-4e01-86c8-d71771a843f8';
let STAGE_X4_ID = '9b617a07-a418-4770-bede-81f8ec732b03';

const PIPELINES_CACHE_FILE = path.join(process.cwd(), 'src', 'config', 'pipelines_cache.json');
try {
  if (fs.existsSync(PIPELINES_CACHE_FILE)) {
    const cache = JSON.parse(fs.readFileSync(PIPELINES_CACHE_FILE, 'utf-8'));
    if (cache.audit) {
      AUDIT_PIPELINE_ID = cache.audit.pipelineId || AUDIT_PIPELINE_ID;
      STAGE_INTAKE_ID = cache.audit.stageIntakeId || STAGE_INTAKE_ID;
      STAGE_X1_ID = cache.audit.stageX1Id || STAGE_X1_ID;
      STAGE_X2_ID = cache.audit.stageX2Id || STAGE_X2_ID;
      STAGE_X3_ID = cache.audit.stageX3Id || STAGE_X3_ID;
      STAGE_X4_ID = cache.audit.stageX4Id || STAGE_X4_ID;
    }
  }
} catch (e) {}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(text) {
  return (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/gi, '').trim();
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    if (global.apiCounters) global.apiCounters.ghl++;
    const res = await fetch(url, options);
    if (res.status === 429) {
      const waitTime = 1500 * attempt;
      await sleep(waitTime);
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 5) {
      await sleep(1500);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

const KNOWN_TRIGGER_KEYWORDS = [
  'muestra gratis', 'azucar alta', 'hormigueo', 'diabetes', 'glucosa', 'potencia', 'dolor intenso', 'prostata', 'colageno', 'mala circulacion', 'vision borrosa'
];

/**
 * Motor Maestro Forense Anclado a ADID y Saludos/Gatillos Iniciales
 */
export async function processMasterContact(contactInput, options = {}) {
  const isSilent = options.silent !== false;
  let contact = contactInput;

  try {
    if (typeof contactInput === 'string' || !contactInput.tags || !contactInput.firstName) {
      const contactId = typeof contactInput === 'string' ? contactInput : contactInput.id;
      const cRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
        headers: HEADERS_CONTACTS
      });
      if (cRes.status !== 200) {
        throw new Error(`No se pudo obtener contacto ${contactId} (Status: ${cRes.status})`);
      }
      const cData = await cRes.json();
      contact = cData.contact || cData;
    }

    const contactId = contact.id;
    const fullName = `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || 'Sin Nombre';
    const hasPhone = Boolean(contact.phone && contact.phone.trim().length > 0);
    const existingTags = (contact.tags || []).map(t => typeof t === 'string' ? t.toLowerCase().trim() : '');

    // 1. Obtener Conversaciones y Mensajes de Facebook
    // OPTIMIZACIÓN: Solo buscaremos conversaciones si el contacto indica explícitamente venir de FB o Meta.
    const isMetaSource = existingTags.includes('facebook-messenger') || 
                         existingTags.includes('meta-ads') || 
                         existingTags.includes('canal-fb-msgr') ||
                         existingTags.some(t => String(t).toLowerCase().includes('fb-')) ||
                         (contact.source || '').toLowerCase().includes('facebook') ||
                         (contact.source || '').toLowerCase().includes('meta');
    
    const conversations = [];
    if (isMetaSource) {
      const convSearchUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&contactId=${contactId}`;
      const convRes = await fetchWithRetry(convSearchUrl, { headers: HEADERS_CONV });
      if (convRes.status === 200) {
        const convData = await convRes.json();
        conversations.push(...(convData.conversations || []));
      }
    }

    const rawMessagesList = [];
    const seenMessageIds = new Set();
    let detectedPageName = null;
    const explicitAdTouches = []; 

    for (const t of existingTags) {
      const match = String(t).match(/^ad_id\.(\d+)/i);
      if (match) {
        explicitAdTouches.push({
          date: new Date(),
          adId: match[1],
          source: 'tag'
        });
      }
    }

    if (conversations.length > 0) {
      for (const conv of conversations) {
        let nextUrl = `https://services.leadconnectorhq.com/conversations/${conv.id}/messages?locationId=${locationId}&limit=100`;
        
        while (nextUrl) {
          const msgRes = await fetchWithRetry(nextUrl, { headers: HEADERS_CONV });
          if (msgRes.status !== 200) break;
          const msgData = await msgRes.json();
          const messages = msgData.messages?.messages || [];

          for (const m of messages) {
            if (!m.id || seenMessageIds.has(m.id) || (m.body && m.body.includes('Opportunity '))) continue;
            seenMessageIds.add(m.id);

            const fbMeta = m.meta?.fb || {};
            // PRIORIDAD 1: Detectar por Facebook Page ID (Infalible)
            if (fbMeta.fromPageId && FB_PAGE_ID_MAP[String(fbMeta.fromPageId)]) {
              detectedPageName = FB_PAGE_ID_MAP[String(fbMeta.fromPageId)];
            } else if (fbMeta.pageId && FB_PAGE_ID_MAP[String(fbMeta.pageId)]) {
              detectedPageName = FB_PAGE_ID_MAP[String(fbMeta.pageId)];
            }
            // PRIORIDAD 2: Detectar por nombre de página (fallback)
            if (!detectedPageName && fbMeta.pageName) detectedPageName = fbMeta.pageName;
            if (fbMeta.adId && fbMeta.adId !== 'N/A') {
               explicitAdTouches.push({
                 date: new Date(m.dateAdded),
                 adId: String(fbMeta.adId),
                 source: 'conversation'
               });
            }

            rawMessagesList.push(m);
          }
          nextUrl = msgData.meta?.nextPageUrl || null;
        }
      }
    }

    // 2. Detección de Sede / Fanpage
    if (!detectedPageName) {
      const attributions = contact.attributions || [];
      for (const attr of attributions) {
        const camp = (attr.utmCampaign || '').toUpperCase();
        if (camp.includes('BENAVIDES') || camp.includes('CESAR')) detectedPageName = 'Naturales Bio Corp';
        else if (camp.includes('PALACIOS') || camp.includes('ERNESTO')) detectedPageName = 'Naturales BioNatural';
        else if (camp.includes('ULTRA')) detectedPageName = 'BioNatural - Ultra';
        else if (camp.includes('ROOSEVELT')) detectedPageName = 'Bio Naturales';
        else if (camp.includes('PIURA')) detectedPageName = 'BioNatural';
        if (detectedPageName) break;
      }
    }

    if (!detectedPageName && contact.customFields) {
      for (const cf of contact.customFields) {
        const val = String(cf.value || '').toUpperCase();
        if (val.includes('BENAVIDES')) detectedPageName = 'Naturales Bio Corp';
        else if (val.includes('PALACIOS')) detectedPageName = 'Naturales BioNatural';
        else if (val.includes('ULTRA')) detectedPageName = 'BioNatural - Ultra';
        else if (val.includes('ROOSEVELT')) detectedPageName = 'Bio Naturales';
        else if (val.includes('PIURA')) detectedPageName = 'BioNatural';
        if (detectedPageName) break;
      }
    }

    if (!detectedPageName) {
      for (const [pageName, tag] of Object.entries(PAGE_TAG_MAP)) {
        if (existingTags.includes(tag)) {
          detectedPageName = pageName;
          break;
        }
      }
    }

    const pageTag = detectedPageName ? PAGE_TAG_MAP[detectedPageName] || detectedPageName.toLowerCase().replace(/[^a-z0-9]/g, ' ') : null;

    // 3. Determinar Asesor Asignado
    let targetAdvisorId = contact.assignedTo || null;
    let targetAdvisorName = null;

    if (detectedPageName === 'Naturales BioNatural' || detectedPageName === 'Laboratorios Naturales BIO' || detectedPageName === 'BIO Naturales Laboratorio') {
      targetAdvisorId = PALACIOS_USERS['naturales bionatural'].id;
      targetAdvisorName = PALACIOS_USERS['naturales bionatural'].name;
    } else if (detectedPageName === 'BioNatural - Ultra') {
      targetAdvisorId = PALACIOS_USERS['bionatural ultra'].id;
      targetAdvisorName = PALACIOS_USERS['bionatural ultra'].name;
    } else if (detectedPageName === 'Naturales Bio Corp') {
      targetAdvisorId = PALACIOS_USERS['redes benavides 1'].id;
      targetAdvisorName = PALACIOS_USERS['redes benavides 1'].name;
    } else if (detectedPageName === 'Bio Natural' || detectedPageName === 'BioNatural Fuerza') {
      targetAdvisorId = PALACIOS_USERS['redes benavides 2'].id;
      targetAdvisorName = PALACIOS_USERS['redes benavides 2'].name;
    } else if (detectedPageName === 'Bio Naturales' || detectedPageName === 'BioNatural Plus') {
      targetAdvisorId = PALACIOS_USERS['redes roosevelt'].id;
      targetAdvisorName = PALACIOS_USERS['redes roosevelt'].name;
    } else if (detectedPageName === 'BioNatural' || detectedPageName === 'Natural Bio') {
      targetAdvisorId = PALACIOS_USERS['redes piura'].id;
      targetAdvisorName = PALACIOS_USERS['redes piura'].name;
    }

    // --- 3.5 REGLA DE COOLDOWN (BLINDAJE DE 48 HORAS) ---
    let cooldownBlocked = false;
    let cooldownNote = null;

    if (targetAdvisorId && contact.assignedTo && targetAdvisorId !== contact.assignedTo) {
      // Ordenamos mensajes cronológicamente para evaluar la última interacción
      rawMessagesList.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
      
      let lastOldInteractionDate = null;
      const now = new Date();
      
      // Buscar la última interacción que tenga más de 2 horas (para descartar la ráfaga actual)
      for (let i = rawMessagesList.length - 1; i >= 0; i--) {
        const msgDate = new Date(rawMessagesList[i].dateAdded);
        const diffHours = (now - msgDate) / (1000 * 60 * 60);
        if (diffHours > 2) {
          lastOldInteractionDate = msgDate;
          break;
        }
      }
      
      if (!lastOldInteractionDate && contact.dateAdded) {
        // CORRECCIÓN: Si el contacto fue migrado de vTiger recientemente, su 'dateAdded' en GHL dirá que es de hoy o ayer,
        // pero en realidad es un contacto muy antiguo. Verificamos si tiene etiquetas históricas de vTiger.
        const isOldVtiger = existingTags.some(t => String(t).startsWith('vtiger-202'));
        if (isOldVtiger) {
           lastOldInteractionDate = new Date('2020-01-01'); // Forzamos una fecha antigua para saltar el Cooldown
        } else {
           lastOldInteractionDate = new Date(contact.dateAdded);
        }
      }
      
      if (lastOldInteractionDate) {
         const hoursSinceLastInteraction = (now - lastOldInteractionDate) / (1000 * 60 * 60);
         
         if (hoursSinceLastInteraction <= 48) {
            cooldownBlocked = true;
            cooldownNote = `[🛡️ REGLA COOLDOWN] Intento de reasignación a ${detectedPageName} bloqueado. El lead interactuó con su asesor original hace ${Math.round(hoursSinceLastInteraction)} horas (Blindaje activo de 48h).`;
            
            // Revertir targetAdvisorId para NO robar el lead
            targetAdvisorId = contact.assignedTo; 
            targetAdvisorName = 'Asesor Original (Protegido por Cooldown)';
         }
      }
    }

    // 4. ANÁLISIS FORENSE ANCLADO A ADID Y GATILLOS/SALUDOS INICIALES
    // (rawMessagesList ya está ordenado)

    const adTriggers = [];
    for (const m of rawMessagesList) {
      const rawText = (m.body || '').trim();
      const cleaned = cleanText(rawText);
      const fbMeta = m.meta?.fb || {};

      const hasAdId = Boolean(fbMeta.adId && fbMeta.adId !== 'N/A');
      const adIdFromText = rawText.match(/ad_id[:\s]*(\d+)/i);
      const finalAdId = (hasAdId ? fbMeta.adId : (adIdFromText ? adIdFromText[1] : null));

      const isSystemAd = cleaned.includes('respondio un anuncio') || cleaned.includes('respondio a tu anuncio');
      const isTriggerBtn = m.direction === 'inbound' && KNOWN_TRIGGER_KEYWORDS.some(kw => cleaned.includes(kw));

      if (finalAdId || isSystemAd || isTriggerBtn) {
        let campaignNameTag = null;
        if (finalAdId && String(finalAdId) !== 'N/A') {
           // Pre-fetch the ad details here to convert Campaign Name to a Tag
           const metaData = await getMetaAdDetails(finalAdId);
           if (metaData && metaData.campaignName && metaData.campaignName !== 'Desconocida') {
              // Convert campaign name to slug tag: "Campaña Artritis" -> "campaña-artritis"
              campaignNameTag = cleanText(metaData.campaignName).replace(/\s+/g, '-').substring(0, 30);
           }
        }

        adTriggers.push({
          id: m.id,
          date: new Date(m.dateAdded),
          text: rawText,
          cleaned: cleaned,
          isSystemAd,
          isTriggerBtn,
          adId: finalAdId,
          adTitle: fbMeta.adTitle || 'Anuncio Meta',
          pageName: fbMeta.pageName || detectedPageName || 'Sede Meta',
          campaignTag: campaignNameTag
        });
      }
    }

    const distinctAdTouches = [];
    for (let i = 0; i < adTriggers.length; i++) {
      const t = adTriggers[i];
      if (distinctAdTouches.length === 0) {
        distinctAdTouches.push(t);
      } else {
        const last = distinctAdTouches[distinctAdTouches.length - 1];
        const diffSec = (t.date - last.date) / 1000;
        
        if (diffSec <= 10 && (t.cleaned === last.cleaned || t.isSystemAd)) {
          distinctAdTouches.push(t);
        } 
        else if (diffSec > 600 || t.isSystemAd || (t.adId && t.adId !== last.adId)) {
          distinctAdTouches.push(t);
        }
      }
    }

    const filteredExplicitTouches = [];
    explicitAdTouches.sort((a, b) => a.date - b.date);
    for (const t of explicitAdTouches) {
      if (filteredExplicitTouches.length === 0) {
        filteredExplicitTouches.push(t);
      } else {
        const last = filteredExplicitTouches[filteredExplicitTouches.length - 1];
        const diffSec = (t.date - last.date) / 1000;
        if (diffSec > 600 || t.adId !== last.adId || (t.source !== last.source)) {
          filteredExplicitTouches.push(t);
        }
      }
    }

    let totalAdClicks = Math.max(distinctAdTouches.length, filteredExplicitTouches.length);
    if (totalAdClicks === 0 && existingTags.includes('meta-ads')) {
      totalAdClicks = 1;
    }

    const isMultipleClick = totalAdClicks > 1;
    const clicksToDiscount = Math.max(0, totalAdClicks - 1);

    // CLASIFICACIÓN
    let touchTag = totalAdClicks > 0 ? 'pauta-clic-x1' : null;
    let auditStageId = STAGE_INTAKE_ID;
    let classificationLabel = 'Base General (Intake)';

    if (totalAdClicks === 0) {
      touchTag = null;
      auditStageId = STAGE_INTAKE_ID;
      classificationLabel = 'Base General (Intake)';
    } else if (totalAdClicks === 1) {
      touchTag = 'pauta-clic-x1';
      auditStageId = STAGE_X1_ID;
      classificationLabel = 'Lead Nuevo X1';
    } else if (totalAdClicks === 2) {
      touchTag = 'pauta-reingreso-x2';
      auditStageId = STAGE_X2_ID;
      classificationLabel = 'REINGRESO X2 (Desc. 1 Lead)';
    } else if (totalAdClicks === 3) {
      touchTag = 'pauta-reingreso-x3';
      auditStageId = STAGE_X3_ID;
      classificationLabel = 'REINGRESO X3 (Desc. 2 Leads)';
    } else if (totalAdClicks >= 4) {
      touchTag = `pauta-reingreso-x${totalAdClicks}`;
      auditStageId = STAGE_X4_ID;
      classificationLabel = `SATURACIÓN X${totalAdClicks} (Desc. ${clicksToDiscount} Leads)`;
    }

    // 5. Consolidación de Etiquetas
    const requiredTags = new Set(existingTags);
    if (totalAdClicks > 0) {
      requiredTags.add('meta-ads');
      requiredTags.add('facebook-messenger');
    }
    if (pageTag) requiredTags.add(pageTag);
    if (touchTag) requiredTags.add(touchTag);
    if (isMultipleClick) requiredTags.add('alerta-reingreso-pauta');
    if (totalAdClicks >= 4) requiredTags.add('alerta-bloqueo-pauta');

    requiredTags.delete('alerta-clic-spam');
    if (totalAdClicks < 4) requiredTags.delete('alerta-bloqueo-pauta');
    if (totalAdClicks <= 1) requiredTags.delete('alerta-reingreso-pauta');

    for (const t of Array.from(requiredTags)) {
      if ((t.startsWith('pauta-reingreso-x') || t === 'pauta-clic-x1') && t !== touchTag) {
        requiredTags.delete(t);
      }
    }

    // Inyectar las etiquetas de campaña extraídas del Meta API
    for (const touch of distinctAdTouches) {
      if (touch.campaignTag) requiredTags.add(touch.campaignTag);
    }
    for (const touch of filteredExplicitTouches) {
      if (touch.campaignTag) requiredTags.add(touch.campaignTag);
    }

    const finalTagsList = Array.from(requiredTags);

    // 6. Actualización en GHL
    const updatePayload = { tags: finalTagsList };
    if (targetAdvisorId && contact.assignedTo !== targetAdvisorId) {
      updatePayload.assignedTo = targetAdvisorId;
    }
    if (contactInput.customFields && contactInput.customFields.length > 0) {
      updatePayload.customFields = contactInput.customFields;
    }

    const tagsChanged = finalTagsList.length !== existingTags.length || finalTagsList.some(t => !existingTags.includes(t));
    const advisorChanged = targetAdvisorId && contact.assignedTo !== targetAdvisorId;
    const customFieldsPresent = contactInput.customFields && contactInput.customFields.length > 0;

    if (tagsChanged || advisorChanged || customFieldsPresent) {
      await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
        method: 'PUT',
        headers: HEADERS_CONTACTS,
        body: JSON.stringify(updatePayload)
      });
    }

    // 7. Pipeline Maestro Comercial
    let monetaryValue = 0;
    
    // Buscar en el contacto de GHL (API)
    if (contact.customFields) {
      for (const cf of contact.customFields) {
        if (['5js0Lfbh5XDLq87SDgdT', 'OnhkGCi6yQkLnoSE1dnP', 'cqmj8bfaRB2Gxug0U5Ql'].includes(cf.id)) {
          const val = parseFloat(cf.value || 0);
          if (val > monetaryValue) monetaryValue = val;
        }
      }
    }
    
    // Override si viene en el input de vTiger (contactInput)
    if (contactInput.customFields) {
      for (const cf of contactInput.customFields) {
        if (['5js0Lfbh5XDLq87SDgdT', 'OnhkGCi6yQkLnoSE1dnP', 'cqmj8bfaRB2Gxug0U5Ql'].includes(cf.id)) {
          const val = parseFloat(cf.value || cf.field_value || 0);
          if (val > monetaryValue) monetaryValue = val;
        }
      }
    }

    const pageLabel = detectedPageName || 'General';
    let masterStageId = hasPhone ? MASTER_STAGE_CALIFICADO_ID : MASTER_STAGE_PRECALIFICADO_ID;
    
    if (monetaryValue > 0) {
      masterStageId = 'b7b26459-ae47-4249-a45f-0a0c5506e30e'; // Ganado
    } else {
      const isVtiger = existingTags.includes('vtiger') || (contactInput.tags && contactInput.tags.includes('vtiger'));
      if (isVtiger) {
        masterStageId = '41af4766-3534-49c4-8b62-6161de562a33'; // Remarketing
      } else if (existingTags.includes('negociacion') || existingTags.includes('remarketing') || existingTags.includes('reingreso')) {
        masterStageId = '41af4766-3534-49c4-8b62-6161de562a33'; // Remarketing
      } else {
        masterStageId = '3034da46-ce9c-486f-a8eb-84384d5dfce1'; // Precalificado
      }
    }

    const masterOppName = `${fullName} [${pageLabel}]`;

    const oppSearchUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&contact_id=${contactId}`;
    const oppRes = await fetchWithRetry(oppSearchUrl, { headers: HEADERS_CONTACTS });
    const oppData = await oppRes.json();
    const existingOpps = oppData.opportunities || [];

    const masterOpp = existingOpps.find(o => o.pipelineId === MASTER_PIPELINE_ID);
    if (masterOpp) {
      if (masterOpp.pipelineStageId !== masterStageId || masterOpp.name !== masterOppName || (targetAdvisorId && masterOpp.assignedTo !== targetAdvisorId) || (monetaryValue > 0 && masterOpp.monetaryValue !== monetaryValue)) {
        await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${masterOpp.id}`, {
          method: 'PUT',
          headers: HEADERS_CONTACTS,
          body: JSON.stringify({
            pipelineStageId: masterStageId,
            name: masterOppName,
            assignedTo: targetAdvisorId || masterOpp.assignedTo || undefined,
            monetaryValue: monetaryValue > 0 ? monetaryValue : undefined
          })
        });
      }
    } else {
      const createMasterPayload = {
        pipelineId: MASTER_PIPELINE_ID,
        locationId,
        name: masterOppName,
        pipelineStageId: masterStageId,
        status: masterStageId === 'b7b26459-ae47-4249-a45f-0a0c5506e30e' ? 'won' : 'open',
        contactId
      };
      if (targetAdvisorId) createMasterPayload.assignedTo = targetAdvisorId;
      if (monetaryValue > 0) createMasterPayload.monetaryValue = monetaryValue;

      await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/`, {
        method: 'POST',
        headers: HEADERS_CONTACTS,
        body: JSON.stringify(createMasterPayload)
      });
    }

    // 8. Pipeline Radar de Auditoría
    const auditOppName = `${fullName} [${pageLabel} | ${classificationLabel}]`;
    const auditOpp = existingOpps.find(o => o.pipelineId === AUDIT_PIPELINE_ID);

    if (auditOpp) {
      if (auditOpp.pipelineStageId !== auditStageId || auditOpp.name !== auditOppName || (targetAdvisorId && auditOpp.assignedTo !== targetAdvisorId)) {
        await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${auditOpp.id}`, {
          method: 'PUT',
          headers: HEADERS_CONTACTS,
          body: JSON.stringify({
            pipelineStageId: auditStageId,
            name: auditOppName,
            assignedTo: targetAdvisorId || auditOpp.assignedTo || undefined
          })
        });
      }
    } else {
      const createAuditPayload = {
        pipelineId: AUDIT_PIPELINE_ID,
        locationId,
        name: auditOppName,
        pipelineStageId: auditStageId,
        status: 'open',
        contactId
      };
      if (targetAdvisorId) createAuditPayload.assignedTo = targetAdvisorId;
      await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/`, {
        method: 'POST',
        headers: HEADERS_CONTACTS,
        body: JSON.stringify(createAuditPayload)
      });
    }

    // 9. Nota Forense Financiera y Notas de vTiger
    const touchpointsToAudit = filteredExplicitTouches.length > 0 ? filteredExplicitTouches : distinctAdTouches;
    if (touchpointsToAudit.length > 0 || contactInput.notes || cooldownNote) {
      await injectAuditNoteOnce(contactId, fullName, totalAdClicks, clicksToDiscount, touchpointsToAudit, contactInput.notes, cooldownNote);
    }

    // 10. Meta CAPI & Exclusión
    (async () => {
      try {
        if (contact.phone || contact.email) {
          await excludeLeadFromMetaAds({ phone: contact.phone, email: contact.email });
        }
        if (hasPhone) {
          await sendMetaConversionEvent('QualifiedLead', contact, { pageName: pageLabel });
        } else if (totalAdClicks > 0) {
          await sendMetaConversionEvent('Lead', contact, { pageName: pageLabel });
        }
      } catch (err) {}
    })();

    if (!isSilent) {
      console.log(`[✔ Master Processed] ${fullName} | Sede: ${pageLabel} | Asesor: ${targetAdvisorName || 'No asignado'} | Clics: ${totalAdClicks} (${classificationLabel}) | Tel: ${hasPhone ? 'SÍ' : 'NO'}`);
    }
    
    if (global.pushLiveLog) {
      const stageName = masterStageId === '29293e88-d26e-4095-bde9-d40aa0cf1024' ? 'Precalificado' :
                        masterStageId === '5e7d5fb0-0a71-46df-aa42-912fe0b487f1' ? 'Para Contactar' :
                        masterStageId === '41af4766-3534-49c4-8b62-6161de562a33' ? 'Remarketing' : 'Ganado';
      global.pushLiveLog(`Procesado: ${fullName} ➔ ${stageName}`);
    }

    return {
      success: true,
      contactId,
      fullName,
      pageLabel,
      pageTag,
      advisorName: targetAdvisorName,
      advisorId: targetAdvisorId,
      hasPhone,
      totalAdClicks,
      clicksToDiscount,
      isMultipleClick,
      classificationLabel,
      touchTag,
      tagsApplied: finalTagsList,
      masterStageId
    };

  } catch (error) {
    console.error(`❌ [Master Processor Error] Contacto ${contactInput?.id || contactInput}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function injectAuditNoteOnce(contactId, fullName, totalClicks, discountLeads, touchpoints, vTigerNotes, cooldownNote) {
  try {
    const notesUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;
    const notesRes = await fetchWithRetry(notesUrl, { headers: HEADERS_CONTACTS });
    const notesData = await notesRes.json();
    const existingNotes = notesData.notes || [];

    const existingAuditNote = existingNotes.find(n => n.body && n.body.includes('AUDITORÍA MULTI-TOUCH'));

    let breakdownText = '';
    
    for (let idx = 0; idx < touchpoints.length; idx++) {
       const t = touchpoints[idx];
       const timeStr = `${t.date.toLocaleDateString('es-ES')} ${t.date.toLocaleTimeString('es-ES')}`;
       const deltaStr = idx > 0 ? ' (Reingreso / Doble Acción)' : ' (Inicio)';
       
       if (t.adId && String(t.adId) !== 'N/A') {
          // Ya no necesitamos hacer getMetaAdDetails aquí porque lo hicimos en el paso 4 y lo pasamos como campaignTag
          // Sin embargo, para no romper el formato, usaremos el campaignTag que guardamos o volveremos a consultar si falta.
          let metaData = { campaignName: t.campaignTag || 'Desconocida', adName: 'Ad (Referencia GHL)' };
          breakdownText += `  • Clic #${idx + 1}: ${timeStr}${deltaStr} | Campaña: "${metaData.campaignName}" | Anuncio: "${metaData.adName}" [ADID: ${t.adId}]\n`;
       } else {
          // Fallback para cuando no hay AdID explícito (mensajes antiguos o saludos directos)
          const triggerLabel = t.text ? t.text.substring(0, 50) : (t.adTitle || 'Anuncio Meta');
          breakdownText += `  • Toque #${idx + 1}: ${timeStr}${deltaStr} | Sede: ${t.pageName || 'N/A'} | Disparador: ${triggerLabel} | MsgID: ${t.id || 'N/A'}\n`;
       }
    }

    let noteContent = `📊 AUDITORÍA MULTI-TOUCH & FINANCIERA (Total clics: ${totalClicks})
==================================================
👤 Cliente: ${fullName}
🔢 Total de Clics Registrados: ${totalClicks}
💰 DESCUENTO APLICABLE A LA AGENCIA: ${discountLeads} LEAD(S) REPETIDO(S)

Línea de Timeline Forense (Gatillos de Anuncio & Meta ADIDs):
${breakdownText}

👉 Dictamen: 1 Lead Real Pagable. ${discountLeads} Clic(s) duplicados descontados automáticamente de la facturación.`;

    if (cooldownNote) {
      noteContent += `\n\n${cooldownNote}`;
    }

    if (vTigerNotes) {
      noteContent += `\n\n📝 Notas Históricas (vTiger):\n${vTigerNotes}`;
    }

    if (existingAuditNote) {
      if (existingAuditNote.body !== noteContent) {
        await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}/notes/${existingAuditNote.id}`, {
          method: 'PUT',
          headers: HEADERS_CONTACTS,
          body: JSON.stringify({ body: noteContent })
        });
      }
    } else {
      await fetchWithRetry(notesUrl, {
        method: 'POST',
        headers: HEADERS_CONTACTS,
        body: JSON.stringify({ body: noteContent })
      });
    }
  } catch (e) {}
}
