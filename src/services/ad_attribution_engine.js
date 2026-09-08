import { GHL_CONFIG, PAGE_TAG_MAP } from '../config/index.js';
import { inferTreatmentFromCampaignOrUtm } from '../agents/nlp_symptom_engine.js';
import { findVTigerContact } from './vtiger_api_service.js';
import fs from 'fs';
import path from 'path';

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

const PIPELINES_CACHE_FILE = path.join(process.cwd(), 'src', 'config', 'pipelines_cache.json');

// Cargar IDs de pipeline cacheados o usar constantes seguras
let AUDIT_PIPELINE_ID = 'UuLt1X7copaVFO50wIfU';
let STAGE_X1_ID = '1508276b-2f3b-4827-956a-a9f646baba97';
let STAGE_X2_ID = '1ef02601-a1f4-4125-8a3b-69fb2daf93bb';
let STAGE_X3_ID = 'ca77226a-08c2-4e01-86c8-d71771a843f8';
let STAGE_X4_ID = '9b617a07-a418-4770-bede-81f8ec732b03';
let STAGE_SPAM_ID = '6a901cbc-92af-4cb6-a590-626b9f72e7b0';

try {
  if (fs.existsSync(PIPELINES_CACHE_FILE)) {
    const cache = JSON.parse(fs.readFileSync(PIPELINES_CACHE_FILE, 'utf-8'));
    if (cache.audit) {
      AUDIT_PIPELINE_ID = cache.audit.pipelineId || AUDIT_PIPELINE_ID;
      STAGE_X1_ID = cache.audit.stageX1Id || STAGE_X1_ID;
      STAGE_X2_ID = cache.audit.stageX2Id || STAGE_X2_ID;
      STAGE_X3_ID = cache.audit.stageX3Id || STAGE_X3_ID;
      STAGE_X4_ID = cache.audit.stageX4Id || STAGE_X4_ID;
      STAGE_SPAM_ID = cache.audit.stageSpamId || STAGE_SPAM_ID;
    }
  }
} catch (e) {}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      await sleep(2000 * attempt);
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < 5) {
      await sleep(2000);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw e;
  }
}

/**
 * Motor Forense de Atribución Multi-Touch (X1, X2, X3, X4+)
 * 
 * 1. Extrae todos los mensajes de chat y metadatos de pauta (Meta Ads / Messenger).
 * 2. Construye la línea de tiempo forense con Message IDs únicos y sellos de tiempo.
 * 3. Clasifica la interacción: Toque 1 (Lead Nuevo), Toque 2 (Reingreso), Toque 3, Toque 4+ o Spam Rápido.
 * 4. Sincroniza la oportunidad en el Pipeline de Auditoría Multi-Touch asignada a su asesor.
 * 5. Inyecta etiquetas limpias y notas de descuento financiero irrefutables.
 * 
 * @param {string} contactId - ID del contacto en GoHighLevel
 * @param {object} options - Opciones ({ silent: boolean })
 * @returns {Promise<object>} Resultado de la auditoría
 */
export async function auditAdAttribution(contactId, options = {}) {
  const isSilent = options.silent || false;
  if (!isSilent) console.log(`\n🔍 [Ad Attribution Engine] Auditando pauta para contacto ID: ${contactId}...`);

  try {
    // 1. Obtener detalles del contacto
    const contactRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: HEADERS_CONTACTS
    });

    if (contactRes.status !== 200) {
      throw new Error(`No se pudo obtener el contacto (Status: ${contactRes.status})`);
    }

    const contactData = await contactRes.json();
    const contact = contactData.contact || contactData;
    const currentTags = (contact.tags || []).map(t => typeof t === 'string' ? t.toLowerCase() : '');
    const fullName = `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || 'Sin Nombre';

    // 2. Buscar conversaciones del contacto
    const convSearchUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&contactId=${contactId}`;
    const convRes = await fetchWithRetry(convSearchUrl, { headers: HEADERS_CONV });
    const convData = await convRes.json();

    const conversations = convData.conversations || [];
    if (conversations.length === 0) {
      if (!isSilent) console.log(`  ℹ️ El contacto ${fullName} no tiene conversaciones registradas.`);
      return { success: true, totalAdClicks: 0, reason: 'no_conversations' };
    }

    // 3. Extraer todos los mensajes con metadatos de pauta
    const rawAdInteractions = [];
    const seenMessageIds = new Set();

    for (const conv of conversations) {
      let nextUrl = `https://services.leadconnectorhq.com/conversations/${conv.id}/messages?locationId=${locationId}&limit=100`;
      
      while (nextUrl) {
        const msgRes = await fetchWithRetry(nextUrl, { headers: HEADERS_CONV });
        const msgData = await msgRes.json();
        const messages = msgData.messages?.messages || [];

        for (const m of messages) {
          if (!m.id || seenMessageIds.has(m.id)) continue;
          seenMessageIds.add(m.id);

          const fbMeta = m.meta?.fb || {};
          const messageText = m.body || '';

          // Detección de anuncio por metadatos o disparadores automáticos de bienvenida
          const isFromAd = Boolean(
            fbMeta.adId ||
            messageText.includes('respondió un anuncio') ||
            messageText.includes('Bienvenido/a a Bio Natural') ||
            messageText.includes('TE OBSEQUIAMOS UNA MUESTRA GRATIS') ||
            (m.direction === 'inbound' && fbMeta.pageName)
          );

          if (isFromAd) {
            const interactionDate = m.dateAdded ? new Date(m.dateAdded) : new Date();
            rawAdInteractions.push({
              messageId: m.id,
              date: interactionDate,
              pageName: fbMeta.pageName || 'Página Meta',
              adId: fbMeta.adId || 'N/A',
              adTitle: fbMeta.adTitle || 'Anuncio Directo',
              body: messageText.substring(0, 80)
            });
          }
        }
        nextUrl = msgData.meta?.nextPageUrl || null;
      }
    }

    // Si no hay clics de pauta en los chats
    if (rawAdInteractions.length === 0) {
      if (!isSilent) console.log(`  ℹ️ No se detectaron clics de pauta directa para ${fullName}.`);
      return { success: true, totalAdClicks: 0, isOrganic: true };
    }

    // Ordenar cronológicamente (del más antiguo al más reciente)
    rawAdInteractions.sort((a, b) => a.date - b.date);

    // Inferencia de tratamiento de base
    const existingTratamiento = (contact.customFields || []).find(f => f.id === 'WcrrCIL4A2203kIbeFsJ' && f.value)?.value;
    const targetTratamiento = existingTratamiento || inferTreatmentFromCampaignOrUtm(contact.attributionSource?.utmCampaign) || inferTreatmentFromCampaignOrUtm(contact.attributionSource?.campaign) || 'General';

    // 4. Construir Timeline Forense con Deduplicación de Ráfagas y Doble Ingreso
    const distinctAdTouches = [];
    for (let i = 0; i < rawAdInteractions.length; i++) {
      const t = rawAdInteractions[i];
      t.treatment = inferTreatmentFromCampaignOrUtm(t.body) || 
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
          continue; // Omitir ráfagas instantáneas (ej. doble webhook de 2 seg)
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

    const latestTouch = distinctAdTouches[distinctAdTouches.length - 1] || { pageName: 'Sede Meta', date: new Date(), adTitle: 'Anuncio Meta' };
    const doubleEntriesCount = distinctAdTouches.filter(t => t.isDoubleEntry).length;
    const reentriesCount = distinctAdTouches.filter(t => t.entryType === 'REENTRY').length;
    const totalAdClicks = Math.max(1, distinctAdTouches.length);
    const hasDoubleEntry = doubleEntriesCount > 0;
    const isMultipleClick = totalAdClicks > 1;
    const clicksToDiscount = reentriesCount;

    // 🏢 Detección del Estatus Comercial (vTiger CRM + GHL)
    let commercialStatus = '💬 CURIOSO (En chat preliminar / Sin teléfono ni compra)';
    try {
      const vContact = await findVTigerContact(contact);
      if (vContact) {
        const numCompras = parseInt(vContact.spl_num_compras || '0', 10);
        const montoTotal = parseFloat(vContact.cf_3392 || vContact.cf_3238 || '0');
        const isWon = vContact.cf_1876 === 'CONVERTIDO' || numCompras > 0 || montoTotal > 0;
        if (isWon) {
          commercialStatus = `🛍️ CLIENTE COMPRADOR (${numCompras || 1} compra(s) en vTiger / $${montoTotal || 0})`;
        } else if (contact.phone) {
          commercialStatus = `📞 PROSPECTO CALIFICADO (Datos para envío / Sin compra aún)`;
        }
      } else if (contact.phone) {
        commercialStatus = `📞 PROSPECTO CALIFICADO (Con teléfono)`;
      }
    } catch (e) {
      if (contact.phone) commercialStatus = `📞 PROSPECTO CALIFICADO (Con teléfono)`;
    }

    // 🧬 Intereses Clínicos Acumulados
    const treatmentSet = new Set();
    if (targetTratamiento && targetTratamiento !== 'General') treatmentSet.add(targetTratamiento);
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

    // 5. Determinar Clasificación y Etiquetas
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

    if (!isSilent) {
      console.log(`  📊 Contacto: ${fullName}`);
      console.log(`  🎯 Total Toques Detectados: ${totalAdClicks} (${classificationLabel})`);
      console.log(`  📅 Último Toque: ${latestTouch.date.toLocaleString('es-ES')} [${latestTouch.pageName}]`);
      console.log(`  💰 Descuento a Agencia: ${clicksToDiscount} Leads`);
    }

    // 6. Limpieza y Aplicación de Etiquetas
    const newTags = [];
    const tagsToRemove = currentTags.filter(tag => {
      const t = tag.toLowerCase();
      const isOldXTag = (t.startsWith('pauta-reingreso-x') || t === 'pauta-clic-x1' || t === 'pauta-doble-ingreso') && t !== touchTag;
      return isOldXTag;
    });

    if (tagsToRemove.length > 0) {
      await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
        method: 'DELETE',
        headers: HEADERS_CONTACTS,
        body: JSON.stringify({ tags: tagsToRemove })
      });
    }

    if (touchTag && !currentTags.includes(touchTag)) {
      newTags.push(touchTag);
    }
    if (!currentTags.includes('meta-ads')) {
      newTags.push('meta-ads');
    }
    if (hasDoubleEntry && !currentTags.includes('pauta-doble-ingreso')) {
      newTags.push('pauta-doble-ingreso');
    }
    if (reentriesCount > 0 && !currentTags.includes('alerta-reingreso-pauta')) {
      newTags.push('alerta-reingreso-pauta');
    }
    if (reentriesCount >= 3 && !currentTags.includes('alerta-bloqueo-pauta')) {
      newTags.push('alerta-bloqueo-pauta');
    }

    if (newTags.length > 0) {
      await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
        method: 'POST',
        headers: HEADERS_CONTACTS,
        body: JSON.stringify({ tags: newTags })
      });
    }

    // 7. Sincronización con el Pipeline de Auditoría Multi-Touch
    await syncAuditPipelineOpportunity(contact, {
      pipelineId: AUDIT_PIPELINE_ID,
      stageId: auditStageId,
      fullName,
      pageName: latestTouch.pageName,
      totalAdClicks,
      classificationLabel,
      assignedTo: contact.assignedTo || null
    });

    // 8. Inyección de Ficha Limpia de Ingreso y Perfil del Cliente
    await injectAuditFinancialNote(contactId, fullName, {
      touchpoints: distinctAdTouches,
      commercialStatus,
      treatment: targetTratamiento,
      treatmentsLabel,
      pageName: latestTouch.pageName,
      adTitle: latestTouch.adTitle,
      adId: latestTouch.adId
    });

    return {
      success: true,
      contactId,
      fullName,
      totalAdClicks,
      clicksToDiscount,
      isMultipleClick,
      hasDoubleEntry,
      classificationLabel,
      touchTag,
      latestPage: latestTouch.pageName,
      latestAd: latestTouch.adTitle,
      touchpoints: distinctAdTouches
    };

  } catch (error) {
    console.error(`  ❌ Error en auditoría de pauta para contacto ${contactId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Crea o mueve la oportunidad en el Pipeline de Auditoría Multi-Touch
 */
async function syncAuditPipelineOpportunity(contact, info) {
  try {
    const oppName = `${info.fullName} [${info.pageName} | ${info.classificationLabel}]`;
    const searchUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&contact_id=${contact.id}`;
    const searchRes = await fetchWithRetry(searchUrl, { headers: HEADERS_CONTACTS });
    const searchData = await searchRes.json();
    const existingOpps = searchData.opportunities || [];

    const auditOpp = existingOpps.find(o => o.pipelineId === info.pipelineId);

    if (auditOpp) {
      // Si la etapa o el nombre cambiaron, actualizar
      if (auditOpp.pipelineStageId !== info.stageId || auditOpp.name !== oppName) {
        const updateUrl = `https://services.leadconnectorhq.com/opportunities/${auditOpp.id}`;
        await fetchWithRetry(updateUrl, {
          method: 'PUT',
          headers: HEADERS_CONTACTS,
          body: JSON.stringify({
            pipelineStageId: info.stageId,
            name: oppName,
            assignedTo: info.assignedTo || auditOpp.assignedTo || undefined
          })
        });
      }
    } else {
      // Crear nueva oportunidad en el Pipeline de Auditoría
      const createPayload = {
        pipelineId: info.pipelineId,
        locationId: locationId,
        name: oppName,
        pipelineStageId: info.stageId,
        status: 'open',
        contactId: contact.id
      };
      if (info.assignedTo) {
        createPayload.assignedTo = info.assignedTo;
      }
      await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/`, {
        method: 'POST',
        headers: HEADERS_CONTACTS,
        body: JSON.stringify(createPayload)
      });
    }
  } catch (e) {
    console.error(`  [Audit Pipeline Sync Error] ${e.message}`);
  }
}

/**
 * Inyecta o actualiza la Ficha Limpia de Ingreso y Perfil del Cliente
 */
async function injectAuditFinancialNote(contactId, fullName, info = {}) {
  try {
    const notesUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;
    const notesRes = await fetchWithRetry(notesUrl, { headers: HEADERS_CONTACTS });
    const notesData = await notesRes.json();
    const existingNotes = notesData.notes || [];

    const existingAuditNote = existingNotes.find(n => n.body && (n.body.includes('FICHA DE INGRESO') || n.body.includes('AUDITORÍA MULTI-TOUCH')));

    const touchpoints = info.touchpoints || [];
    const historyLines = touchpoints.length > 0 ? touchpoints.map((t, idx) => {
      const timeStr = `${t.date.toLocaleDateString('es-PE')} ${t.date.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}`;
      const tagLabel = t.reason || (idx === 0 ? '1er Ingreso' : 'Reingreso');
      return `  • ${idx + 1}º Ingreso: ${timeStr} ➔ ${t.treatment || 'General'} [${t.pageName || 'Sede'}] (${tagLabel})`;
    }).join('\n') : '  • 1º Ingreso: Registrado en sistema.';

    const doubleEntries = touchpoints.filter(t => t.isDoubleEntry);
    let statusSummary = '';
    if (doubleEntries.length > 0) {
      statusSummary = `⭐ DOBLE INGRESO VÁLIDO: Cliente con ${touchpoints.length} interacciones legítimas en campañas/sedes independientes. Todos los ingresos son válidos.`;
    } else if (touchpoints.length > 1) {
      statusSummary = `🟡 REINGRESO (Mismo Producto): El asesor continúa el seguimiento del caso original.`;
    } else {
      statusSummary = `🟢 LEAD NUEVO: Primer contacto directo desde anuncio publicitario. Sin ingresos previos.`;
    }

    const noteContent = `📌 FICHA DE INGRESO Y PERFIL DEL CLIENTE
--------------------------------------------------
👤 Cliente: ${fullName}
📍 Sede Actual: ${info.pageName || 'Sede Central'}
💰 Estatus Comercial: ${info.commercialStatus || 'Sin compras previas'}
🩺 Tratamiento Actual: ${info.treatment || 'General'}
🧬 Intereses Clínicos: ${info.treatmentsLabel || 'General'}
📣 Campaña Actual: ${info.adTitle || 'Directa / Chat'} ${info.adId && info.adId !== 'N/A' ? `(Ad ID: ${info.adId})` : ''}

🔄 HISTORIAL DE INGRESOS:
${historyLines}

💡 ESTADO COMERCIAL:
${statusSummary}`;

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
    console.error(`  [Note Injection Error] ${e.message}`);
  }
}

// ==========================================
// PEINADOR HISTÓRICO MASIVO (Sweep Completo)
// ==========================================
export async function runHistoricalAdAttributionSweep() {
  console.log("\n=================================================");
  console.log("🎯 PEINADO HISTÓRICO DE AUDITORÍA MULTI-TOUCH (BATCH)");
  console.log("Sincronizando Tablero Kanban de Auditoría y Reportes");
  console.log("=================================================\n");

  const csvFilename = `reporte_descuentos_agencia_${new Date().toISOString().split('T')[0]}.csv`;
  const csvHeaders = "Fecha Auditoria,Nombre del Lead,ID GHL,Página/Sede,Total Toques,Leads Reales,Leads a Descontar,Clasificacion\n";
  fs.writeFileSync(csvFilename, csvHeaders);
  console.log(`📝 Creado archivo de reporte: ${csvFilename}\n`);

  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100`;
  const allContacts = [];

  console.log("📥 Extrayendo lista completa de contactos desde GHL...");
  while (url) {
    try {
      const res = await fetchWithRetry(url, { headers: HEADERS_CONTACTS });
      if (res.status === 429) {
        await sleep(5000);
        continue;
      }
      const data = await res.json();
      const contacts = data.contacts || [];
      if (contacts.length === 0) break;

      allContacts.push(...contacts);
      process.stdout.write(`\rDescargados: ${allContacts.length} contactos...`);
      url = data.meta?.nextPageUrl || null;
      await sleep(100);
    } catch (e) {
      console.error("\nError obteniendo contactos:", e.message);
      break;
    }
  }

  console.log(`\n\n📊 Total de contactos a auditar: ${allContacts.length}\n`);

  let totalAudited = 0;
  let singleClicks = 0;
  let multiClicks = 0;
  let totalClicksDiscountable = 0;

  const CONCURRENCY = 5;
  for (let i = 0; i < allContacts.length; i += CONCURRENCY) {
    const batch = allContacts.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (c) => {
      const res = await auditAdAttribution(c.id, { silent: true });
      if (res && res.success) {
        totalAudited++;
        if (res.isMultipleClick) {
          multiClicks++;
          totalClicksDiscountable += (res.clicksToDiscount || 0);
          
          const dateStr = new Date().toLocaleDateString('es-ES');
          const csvRow = `"${dateStr}","${res.fullName}","${res.contactId}","${res.latestPage}",${res.totalAdClicks},1,${res.clicksToDiscount},"${res.classificationLabel}"\n`;
          fs.appendFileSync(csvFilename, csvRow);
        } else {
          singleClicks++;
        }
      }
    }));

    const progress = Math.min(i + CONCURRENCY, allContacts.length);
    if (progress % 50 === 0 || progress === allContacts.length) {
      console.log(`[PROGRESO] ${progress}/${allContacts.length} auditados | 🟢 X1 Nuevos: ${singleClicks} | ⚠️ Reingresos (Descuentos): ${multiClicks} (Total a descontar: ${totalClicksDiscountable} leads)...`);
    }
    await sleep(200);
  }

  console.log(`\n=================================================`);
  console.log(`🎉 REPORTE FINAL DE AUDITORÍA MULTI-TOUCH:`);
  console.log(`=================================================`);
  console.log(`👥 Total Contactos Auditados: ${totalAudited}`);
  console.log(`🟢 Leads Nuevos Únicos (X1): ${singleClicks}`);
  console.log(`⚠️ Casos de Reingreso (X2, X3, X4+): ${multiClicks}`);
  console.log(`💰 TOTAL LEADS A DESCONTAR A AGENCIAS: ${totalClicksDiscountable} leads`);
  console.log(`📄 Archivo guardado como: ${csvFilename}`);
  console.log(`=================================================\n`);
}

// ==========================================
// MODO CLI DIRECTO
// ==========================================
if (process.argv[1] && process.argv[1].endsWith('ad_attribution_engine.js')) {
  const arg = process.argv[2];
  if (arg === '--all' || arg === '-a' || arg === 'all') {
    runHistoricalAdAttributionSweep();
  } else if (arg) {
    auditAdAttribution(arg);
  } else {
    console.log("Buscando contacto reciente para prueba rápida...");
    (async () => {
      try {
        const res = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=1`, {
          headers: HEADERS_CONTACTS
        });
        const data = await res.json();
        const contacts = data.contacts || [];
        if (contacts.length > 0) {
          await auditAdAttribution(contacts[0].id);
        }
      } catch (err) {
        console.error("Error en prueba:", err.message);
      }
    })();
  }
}
