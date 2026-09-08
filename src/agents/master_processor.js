import { GHL_CONFIG, PAGE_TAG_MAP, PALACIOS_USERS, FB_PAGE_ID_MAP } from '../config/index.js';
import { excludeLeadFromMetaAds, sendMetaConversionEvent, getMetaAdDetails } from '../services/meta_api_service.js';
import { inferTreatmentFromCampaignOrUtm, analyzeSymptoms } from './nlp_symptom_engine.js';
import { findVTigerContact } from '../services/vtiger_api_service.js';
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
    const isMetaSource = options.forceFetchConversations ||
                         options.historicalSweep ||
                         existingTags.includes('facebook-messenger') || 
                         existingTags.includes('meta-ads') || 
                         existingTags.includes('pauta-doble-ingreso') ||
                         existingTags.includes('pauta-clic-x1') ||
                         existingTags.some(t => String(t).startsWith('pauta-reingreso-x')) ||
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

    // --- 3.4 CONSULTA DE ESTADO COMERCIAL EN VTIGER CRM ---
    let vContact = null;
    try {
      vContact = await findVTigerContact(contact);
    } catch (e) {}

    const numCompras = parseInt(vContact?.spl_num_compras || '0', 10);
    const montoTotalVtiger = parseFloat(vContact?.cf_3392 || vContact?.cf_3238 || '0');
    const isVtigerWon = vContact && (vContact.cf_1876 === 'CONVERTIDO' || numCompras > 0 || montoTotalVtiger > 0);
    const isGhlWon = existingTags.includes('cliente-comprador') || existingTags.includes('venta-cerrada');
    const isWon = Boolean(isVtigerWon || isGhlWon);

    // --- 3.5 REGLA DE COOLDOWN Y MUDANZA (TIEMPO DE GRACIA DE 4 DÍAS / 96 HORAS) ---
    let cooldownBlocked = false;
    let cooldownNote = null;
    const GRACE_PERIOD_HOURS = 96; // 4 días

    if (targetAdvisorId && contact.assignedTo && targetAdvisorId !== contact.assignedTo) {
      if (isWon) {
        // CASO 1: CLIENTE CON VENTA (CONVERTIDO) ➔ RESERVADO PERMANENTEMENTE PARA SU OFICINA DE VENTA
        cooldownBlocked = true;
        cooldownNote = `[🛡️ RESERVADO OFICINA VENTA] Intento de reasignación a ${detectedPageName} bloqueado. Este cliente tiene venta confirmada (CONVERTIDO) y pertenece exclusivamente a su oficina de venta.`;
        targetAdvisorId = contact.assignedTo;
        targetAdvisorName = 'Oficina de Venta (Cliente Reservado)';
      } else {
        // CASO 2: PROSPECTO SIN VENTA ➔ EVALUAR TIEMPO DE GRACIA DE 4 DÍAS
        rawMessagesList.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
        
        let lastOldInteractionDate = null;
        const now = new Date();
        
        for (let i = rawMessagesList.length - 1; i >= 0; i--) {
          const msgDate = new Date(rawMessagesList[i].dateAdded);
          const diffHours = (now - msgDate) / (1000 * 60 * 60);
          if (diffHours > 2) {
            lastOldInteractionDate = msgDate;
            break;
          }
        }
        
        if (!lastOldInteractionDate && contact.dateAdded) {
          const isOldVtiger = existingTags.some(t => String(t).startsWith('vtiger-202'));
          if (isOldVtiger) {
            lastOldInteractionDate = new Date('2020-01-01');
          } else {
            lastOldInteractionDate = new Date(contact.dateAdded);
          }
        }
        
        if (lastOldInteractionDate) {
          const hoursSinceLastInteraction = (now - lastOldInteractionDate) / (1000 * 60 * 60);
          
          if (hoursSinceLastInteraction <= GRACE_PERIOD_HOURS) {
            // Menor o igual a 4 días (96h): Bloquear mudanza para proteger la exclusividad de la sede actual
            cooldownBlocked = true;
            cooldownNote = `[🛡️ TIEMPO DE GRACIA 4 DÍAS] Intento de reasignación a ${detectedPageName} bloqueado. El lead está en gestión exclusiva de su sede actual (${Math.round(hoursSinceLastInteraction)}h transcurridas de 96h).`;
            targetAdvisorId = contact.assignedTo;
            targetAdvisorName = 'Asesor Actual (Protegido por Gracia 4 Días)';
          } else {
            // Mayor a 4 días (96h) sin venta: MUDANZA LEGÍTIMA AL NUEVO ENCARGADO
            cooldownBlocked = false;
            cooldownNote = `[🔄 MUDANZA LEGÍTIMA] Transferido a ${detectedPageName} tras expirar los 4 días de gracia (${Math.round(hoursSinceLastInteraction)}h) sin venta en la sede anterior.`;
            // targetAdvisorId se mantiene como el nuevo asesor
          }
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

    const existingTratamiento = (contact.customFields || []).find(f => f.id === 'WcrrCIL4A2203kIbeFsJ' && f.value)?.value;
    const targetTratamiento = existingTratamiento || inferTreatmentFromCampaignOrUtm(contact.attributionSource?.utmCampaign) || inferTreatmentFromCampaignOrUtm(contact.attributionSource?.campaign) || 'General';

    const distinctAdTouches = [];
    for (let i = 0; i < adTriggers.length; i++) {
      const t = adTriggers[i];
      t.treatment = inferTreatmentFromCampaignOrUtm(t.text) || 
                    inferTreatmentFromCampaignOrUtm(t.campaignTag) || 
                    inferTreatmentFromCampaignOrUtm(t.adTitle) || 
                    targetTratamiento || 'General';

      if (distinctAdTouches.length === 0) {
        t.isDoubleEntry = false;
        t.entryType = 'FIRST_ENTRY';
        t.reason = '1er Ingreso';
        distinctAdTouches.push(t);
      } else {
        const last = distinctAdTouches[distinctAdTouches.length - 1];
        const diffSec = (t.date - last.date) / 1000;
        const diffMinutes = diffSec / 60;
        const diffDays = diffMinutes / (60 * 24);

        // 🛡️ Filtro de Ráfaga Técnica: Si llegan con menos de 15 minutos en la misma sede/anuncio, es la misma interacción
        if (diffMinutes < 15 && t.pageName === last.pageName && (t.adId === last.adId || (!t.adId && !last.adId))) {
          continue; // Omitir ráfagas instantáneas (ej. doble webhook de 2 seg como Rosa Grijalva)
        }

        // Criterio A: Multiproducto / Anuncio Diferente
        const isDifferentProduct = (t.treatment !== 'General' && last.treatment !== 'General' && t.treatment !== last.treatment) ||
                                  (t.adId && last.adId && String(t.adId) !== String(last.adId));

        // Criterio B: Multisede Hermética
        const isDifferentOffice = t.pageName && last.pageName && t.pageName !== last.pageName;

        // Criterio C: Reactivación tras Tiempo Prolongado (7+ días)
        const isTimeReactivation = diffDays >= 7;

        if (isDifferentProduct) {
          t.isDoubleEntry = true;
          t.entryType = 'DOUBLE_PRODUCT';
          t.reason = `Multiproducto / Diferente Anuncio (${t.treatment})`;
          distinctAdTouches.push(t);
        } else if (isDifferentOffice) {
          t.isDoubleEntry = true;
          t.entryType = 'DOUBLE_OFFICE';
          t.reason = `Multisede Independiente (${t.pageName})`;
          distinctAdTouches.push(t);
        } else if (isTimeReactivation) {
          t.isDoubleEntry = true;
          t.entryType = 'DOUBLE_TIME';
          t.reason = `Reactivación tras ${Math.round(diffDays)} días`;
          distinctAdTouches.push(t);
        } else if (diffMinutes >= 15) {
          // Reingreso del mismo producto en corto plazo (< 7 días)
          t.isDoubleEntry = false;
          t.entryType = 'REENTRY';
          t.reason = 'Reingreso Mismo Producto';
          distinctAdTouches.push(t);
        }
      }
    }

    const doubleEntriesCount = distinctAdTouches.filter(t => t.isDoubleEntry).length;
    const reentriesCount = distinctAdTouches.filter(t => t.entryType === 'REENTRY').length;
    const totalAdClicks = Math.max(1, distinctAdTouches.length);
    const hasDoubleEntry = doubleEntriesCount > 0;
    const isMultipleClick = totalAdClicks > 1;
    const clicksToDiscount = reentriesCount;

    // 🏢 Detección del Estatus Comercial (vTiger CRM + GHL)
    let commercialStatus = '💬 SIN VENTA (En chat preliminar / Sin teléfono ni compra)';
    if (isWon) {
      commercialStatus = `🛍️ CONVERTIDO (${numCompras || 1} compra(s) en vTiger / $${montoTotalVtiger || 0})`;
    } else if (contact.phone || hasPhone) {
      commercialStatus = `📞 SIN VENTA (Prospecto Calificado con Teléfono / Sin compra)`;
    }

    // 🧬 Radiografía de Intereses Clínicos Acumulados (Multiconsulta)
    const treatmentSet = new Set();
    if (targetTratamiento && targetTratamiento !== 'General') treatmentSet.add(targetTratamiento);

    for (const m of rawMessagesList) {
      const text = m.body || '';
      const tRes = inferTreatmentFromCampaignOrUtm(text);
      if (tRes) treatmentSet.add(tRes);
    }
    for (const tag of existingTags) {
      const tLower = String(tag).toLowerCase();
      if (tLower.startsWith('producto-')) {
        const prod = tLower.replace('producto-', '');
        treatmentSet.add(prod.charAt(0).toUpperCase() + prod.slice(1));
      }
    }
    for (const t of distinctAdTouches) {
      if (t.treatment && t.treatment !== 'General') treatmentSet.add(t.treatment);
    }

    const allTreatmentsList = Array.from(treatmentSet);
    let treatmentsLabel = targetTratamiento || 'General';
    if (allTreatmentsList.length === 1) {
      treatmentsLabel = allTreatmentsList[0];
    } else if (allTreatmentsList.length === 2) {
      treatmentsLabel = `${allTreatmentsList[0]} + ${allTreatmentsList[1]} (Interés en 2 tratamientos)`;
    } else if (allTreatmentsList.length >= 3) {
      treatmentsLabel = `⚠️ MULTICONSULTA: ${allTreatmentsList.join(', ')} (${allTreatmentsList.length} tratamientos)`;
    }

    // CLASIFICACIÓN Y RADAR
    let touchTag = 'pauta-clic-x1';
    let auditStageId = STAGE_X1_ID;
    let classificationLabel = 'Lead Nuevo X1';

    if (hasDoubleEntry) {
      touchTag = 'pauta-doble-ingreso';
      auditStageId = STAGE_X2_ID;
      classificationLabel = `⭐ DOBLE INGRESO VÁLIDO (${doubleEntriesCount} nuevo/s)`;
    } else if (reentriesCount > 0) {
      touchTag = `pauta-reingreso-x${totalAdClicks}`;
      auditStageId = STAGE_X2_ID;
      classificationLabel = `REINGRESO (Mismo Producto)`;
    } else {
      touchTag = 'pauta-clic-x1';
      auditStageId = STAGE_X1_ID;
      classificationLabel = 'Lead Nuevo X1';
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

    // 6. Actualización en GHL con Mapeo Riguroso de Estado y Fechas
    const finalCustomFields = [
      { id: '8EQtKkiW7Z022bcN0vhS', value: isWon ? 'CONVERTIDO' : 'SIN VENTA' },
      { id: '5TY5AIOpu1c8f6WosyF2', value: vContact?.cf_994 || (isWon ? 'VENDIDO' : (hasPhone ? 'SIN TRABAJAR' : 'A DESCANZAR')) }
    ];

    if (!isWon) {
      // PROSPECTO SIN VENTA: Registrar Fecha Última Asignación y PURGAR fechas de compra falsas
      finalCustomFields.push({ id: 'RLxFOTXkICXLWShjaLaB', value: new Date().toISOString().split('T')[0] });
      finalCustomFields.push({ id: 'GZKRu2z1Z156lRUfyrpo', value: '' });
      finalCustomFields.push({ id: 'OJYOXVqKp33A6T5HZK5I', value: '' });
      finalCustomFields.push({ id: 'cyn0Ar7GMvmzYBKw0SJu', value: '' });
      finalCustomFields.push({ id: '1U0XzfuI9HUQDqQVMeSV', value: '' });
      finalCustomFields.push({ id: '5js0Lfbh5XDLq87SDgdT', value: '' });
    } else {
      // CLIENTE CON VENTA: Registrar compras reales
      if (vContact?.spl_fecha_primera_compra) {
        finalCustomFields.push({ id: 'OJYOXVqKp33A6T5HZK5I', value: vContact.spl_fecha_primera_compra });
        finalCustomFields.push({ id: 'GZKRu2z1Z156lRUfyrpo', value: vContact.spl_fecha_primera_compra });
      }
      if (vContact?.spl_fecha_ultima_compra) {
        finalCustomFields.push({ id: 'cyn0Ar7GMvmzYBKw0SJu', value: vContact.spl_fecha_ultima_compra });
        finalCustomFields.push({ id: '1U0XzfuI9HUQDqQVMeSV', value: vContact.spl_fecha_ultima_compra });
      }
      if (numCompras > 0) {
        finalCustomFields.push({ id: '3L8KHJEp8fw8ELr081Kl', value: numCompras });
      }
      if (montoTotalVtiger > 0) {
        finalCustomFields.push({ id: 'OnhkGCi6yQkLnoSE1dnP', value: montoTotalVtiger });
        finalCustomFields.push({ id: 'cqmj8bfaRB2Gxug0U5Ql', value: montoTotalVtiger });
        finalCustomFields.push({ id: '5js0Lfbh5XDLq87SDgdT', value: String(montoTotalVtiger.toFixed(2)) });
      }
    }

    if (contactInput.customFields && contactInput.customFields.length > 0) {
      for (const cf of contactInput.customFields) {
        if (!finalCustomFields.some(f => f.id === cf.id)) {
          finalCustomFields.push(cf);
        }
      }
    }

    const updatePayload = {
      tags: finalTagsList,
      customFields: finalCustomFields
    };
    if (targetAdvisorId && contact.assignedTo !== targetAdvisorId) {
      updatePayload.assignedTo = targetAdvisorId;
    }

    await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: HEADERS_CONTACTS,
      body: JSON.stringify(updatePayload)
    });

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

    // 9. Ficha Limpia de Ingreso y Notas de vTiger
    await injectAuditNoteOnce(contactId, fullName, {
      touchpoints: distinctAdTouches,
      commercialStatus: commercialStatus || (monetaryValue > 0 ? '🛍️ CLIENTE COMPRADOR' : '💬 PROSPECTO'),
      currentTreatment: targetTratamiento,
      treatmentsLabel,
      currentSede: pageLabel,
      currentCampaign: (distinctAdTouches[distinctAdTouches.length - 1]?.campaignTag || contact.attributionSource?.utmCampaign || 'Directa / Chat'),
      currentAdId: targetAdId,
      vTigerNotes: contactInput.notes,
      cooldownNote
    });

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

async function injectAuditNoteOnce(contactId, fullName, { touchpoints, commercialStatus, currentTreatment, treatmentsLabel, currentSede, currentCampaign, currentAdId, vTigerNotes, cooldownNote } = {}) {
  try {
    const notesUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;
    const notesRes = await fetchWithRetry(notesUrl, { headers: HEADERS_CONTACTS });
    const notesData = await notesRes.json();
    const existingNotes = notesData.notes || [];

    const existingAuditNote = existingNotes.find(n => n.body && (n.body.includes('FICHA DE INGRESO') || n.body.includes('AUDITORÍA MULTI-TOUCH')));

    const historyLines = (touchpoints && touchpoints.length > 0) ? touchpoints.map((t, idx) => {
      const timeStr = `${t.date.toLocaleDateString('es-PE')} ${t.date.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}`;
      const tagLabel = t.reason || (idx === 0 ? '1er Ingreso' : 'Reingreso');
      return `  • ${idx + 1}º Ingreso: ${timeStr} ➔ ${t.treatment || 'General'} [${t.pageName || 'Sede'}] (${tagLabel})`;
    }).join('\n') : '  • 1º Ingreso: Registrado en sistema.';

    const doubleEntries = (touchpoints || []).filter(t => t.isDoubleEntry);
    let statusSummary = '';
    if (doubleEntries.length > 0) {
      statusSummary = `⭐ DOBLE INGRESO VÁLIDO: Cliente con ${touchpoints.length} interacciones legítimas en campañas/sedes independientes. Todos los ingresos son válidos.`;
    } else if (touchpoints && touchpoints.length > 1) {
      statusSummary = `🟡 REINGRESO (Mismo Producto): El asesor continúa el seguimiento del caso original.`;
    } else {
      statusSummary = `🟢 LEAD NUEVO: Primer contacto directo desde anuncio publicitario. Sin ingresos previos.`;
    }

    let noteContent = `📌 FICHA DE INGRESO Y PERFIL DEL CLIENTE
--------------------------------------------------
👤 Cliente: ${fullName}
📍 Sede Actual: ${currentSede || 'Sede Central'}
💰 Estatus Comercial: ${commercialStatus || 'Sin compras previas'}
🩺 Tratamiento Actual: ${currentTreatment || 'General'}
🧬 Intereses Clínicos: ${treatmentsLabel || 'General'}
📣 Campaña Actual: ${currentCampaign || 'Directa / Chat'} ${currentAdId ? `(Ad ID: ${currentAdId})` : ''}

🔄 HISTORIAL DE INGRESOS:
${historyLines}

💡 ESTADO COMERCIAL:
${statusSummary}`;

    if (cooldownNote) {
      noteContent += `\n\n🛡️ Blindaje de Sede:\n${cooldownNote}`;
    }

    if (vTigerNotes) {
      noteContent += `\n\n📝 Historial vTiger CRM:\n${vTigerNotes}`;
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
  } catch (e) {
    console.error(`[Note Injection Error] ${contactId}:`, e.message);
  }
}
