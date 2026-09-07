import { GHL_CONFIG, PAGE_TAG_MAP, PALACIOS_USERS } from '../config/index.js';
import fs from 'fs';
import path from 'path';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS_CONTACTS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    if (global.apiCounters) global.apiCounters.ghl++;
    const res = await fetch(url, options);
    if (res.status === 429) {
      await sleep(1500 * attempt);
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

export const auditorStats = {
  audited: 0,
  notesInjected: 0,
  discrepanciesFound: 0
};

/**
 * Agente 5: El Auditor (Supervisor de Agentes)
 * Se encarga de revisar los contactos y verificar que el trabajo de los agentes 1, 2, 3 y 4 esté bien hecho.
 * Si detecta anomalías, inyecta una nota roja en GHL.
 */
export async function runSupervisorAuditor() {
  try {
    // Traer contactos modificados recientemente
    const url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=50&sortBy=dateUpdated&order=desc`;
    const res = await fetchWithRetry(url, { headers: HEADERS_CONTACTS });
    if (res.status !== 200) return;

    const data = await res.json();
    const contacts = data.contacts || [];

    for (const contact of contacts) {
      auditorStats.audited++;
      const warnings = [];

      // 1. Auditoría de Datos de Contacto (El Agente 1 inyectó leads sin teléfono?)
      if (!contact.phone) {
        warnings.push("❌ [Agente 1] Falla: Lead ingresado sin número de teléfono. Comercialmente inútil o proveniente de vTiger incompleto.");
      }
      
      const emailStr = String(contact.email || '');
      if (!emailStr || emailStr.includes('vtigermigrated.com')) {
         if (!contact.phone) {
           warnings.push("❌ [Agente 1] Falla: Lead fantasma. No tiene Teléfono ni Correo electrónico real.");
         }
      }

      // 2. Auditoría de Asignación (El Agente 3 hizo su trabajo?)
      if (!contact.assignedTo) {
         warnings.push("❌ [Agente 3] Falla: El lead no tiene un asesor asignado. El enrutador falló o no detectó la sede.");
      }

      // 3. Auditoría de Etiquetas
      const tags = contact.tags || [];
      if (tags.length === 0) {
         warnings.push("❌ [Agente 1/3] Falla: El lead no tiene ninguna etiqueta. No pasó por el embudo de ruteo.");
      } else {
         const hasPageTag = tags.some(t => t.includes('redes') || t.includes('palacios') || t.includes('bio'));
         if (!hasPageTag) {
            warnings.push("⚠️ [Agente 3] Alerta: No se detectó una etiqueta de sede o página clara (Ej: redes-benavides).");
         }
      }

      // 4. Auditoría de Meta Webhook (El Agente 4 inyectó el Ad ID?)
      // Revisamos custom fields
      let hasAdId = false;
      let hasUtmSource = false;
      
      if (contact.customFields) {
         for (const cf of contact.customFields) {
            if (['6w3yMjLgIw6npUKWIosr', 'ujLG5Ogp94WfynVubapT'].includes(cf.id) && cf.value && cf.value !== 'N/A') {
               hasAdId = true;
            }
            if (cf.id === 'L3eEulpe8II7q0UAJnKZ' && cf.value) {
               hasUtmSource = true;
            }
         }
      }

      const isMetaSource = tags.includes('meta-ads') || tags.includes('facebook-messenger');
      if (isMetaSource && !hasAdId) {
         warnings.push("⚠️ [Agente 4] Alerta: Lead marcado como Meta Ads/Facebook pero NO se inyectó el Ad ID. El webhook falló o fue contacto orgánico sin clasificar.");
      }

      // Si hay advertencias, buscar si ya inyectamos esta nota de auditoría para no duplicar
      if (warnings.length > 0) {
        auditorStats.discrepanciesFound++;
        const notesUrl = `https://services.leadconnectorhq.com/contacts/${contact.id}/notes`;
        const notesRes = await fetchWithRetry(notesUrl, { headers: HEADERS_CONTACTS });
        if (notesRes.status === 200) {
           const notesData = await notesRes.json();
           const existingNotes = notesData.notes || [];
           
           const hasSupervisorNote = existingNotes.some(n => n.body && n.body.includes('🕵️ SUPERVISOR / AGENTE 5'));
           
           if (!hasSupervisorNote) {
              const noteBody = `🕵️ SUPERVISOR / AGENTE 5 (Reporte de Salud de Lead)\n===================================\nSe han detectado las siguientes discrepancias en el procesamiento de este Lead:\n\n` + warnings.join('\n\n') + `\n\nPor favor, corregir manualmente si es necesario.`;
              
              await fetchWithRetry(notesUrl, {
                 method: 'POST',
                 headers: HEADERS_CONTACTS,
                 body: JSON.stringify({ body: noteBody })
              });
              auditorStats.notesInjected++;
              if (global.pushLiveLog) global.pushLiveLog(`🕵️ Agente 5: Anomalías reportadas para ${contact.name || 'Lead'}`);
           }
        }
      }
      
      await sleep(100);
    }
  } catch (err) {
    console.error("[Auditor Agent Error]:", err.message);
  }
}
