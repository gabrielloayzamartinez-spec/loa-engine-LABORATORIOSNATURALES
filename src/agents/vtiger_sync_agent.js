import { queryVTiger } from '../services/vtiger_api_service.js';
import { GHL_CONFIG, SEDES_GATEWAY, getGhlHeaders, resolveSedeContext, getActiveSedes } from '../config/index.js';
import { normalizeTreatment, toProductTag, isProductTag, PRODUCT_TAGS } from '../domain/clinical_vocabulary.js';
import { ghlFetch, GHL_HEADERS } from '../utils/ghl_http_client.js';
import { acquireContactLock, releaseContactLock } from './chat_router_agent.js';
import { buildSanitizedCommercialFields, evaluateCommercialTruth } from '../domain/commercial_engine.js';
import { syncUnifiedPipelineOpportunity } from '../services/ghl_opportunity_service.js';
import { learningBrain } from '../services/learning_brain.js';
import { sedeClause, VTIGER_SEDES_VALIDAS } from '../services/vtigerClient.js';
import { sanitizeForVtigerQuery } from '../utils/sanitize.js';
import { recordAuditEvent } from '../services/audit_logger.js';
import { normalizeToE164, buildSanitizedGeoFields } from '../utils/geo_phone_sanitizer.js';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS = GHL_HEADERS;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let syncRateLimitBlockedUntil = 0;

// fetchWithRetry ahora es un wrapper delgado sobre ghlFetch (centralizado en ghl_http_client.js)
async function fetchWithRetry(url, options, attempt = 1) {
  return ghlFetch(url, options, attempt, 'Reverse Sync');
}

/**
 * Encuentra un contacto en GHL respetando la línea estricta de hermetismo de Sede.
 * Solo busca en la subcuenta correspondiente a la sede del contacto en vTiger (cf_3451).
 */
async function findGhlContact(vContact) {
  const cleanPhone = String(vContact.mobile || vContact.phone || vContact.homephone || '').replace(/\D/g, '');
  const email = vContact.email || '';
  const vSede = String(vContact.cf_3451 || '').toUpperCase().trim();

  // [HERMETISMO ESTRICTO]: Determinar subcuenta objetivo según la sede en vTiger
  let targetLocId = null;
  if (vSede === 'BENAVIDES') {
    targetLocId = SEDES_GATEWAY.BENAVIDES.ghl.locationId;
  } else if (vSede === 'PALACIOS') {
    targetLocId = SEDES_GATEWAY.PALACIOS.ghl.locationId;
  } else if (vSede === 'ROOSEVELT' && SEDES_GATEWAY.ROOSEVELT) {
    targetLocId = SEDES_GATEWAY.ROOSEVELT.ghl?.locationId;
  } else if (vSede === 'PIURA' && SEDES_GATEWAY.PIURA) {
    targetLocId = SEDES_GATEWAY.PIURA.ghl?.locationId;
  }

  // Si el registro no tiene sede válida reconocida, NO sincronizar para evitar filtraciones entre sedes
  if (!targetLocId) {
    return null;
  }

  // [SEDE GUARD]: nunca sincronizar hacia una subcuenta no registrada o sin credenciales.
  const sedeContext = resolveSedeContext({ locationId: targetLocId, sede: vSede });
  if (!sedeContext || sedeContext.isUnresolved || sedeContext.isConfigured === false) {
    return null;
  }

  const headers = getGhlHeaders({ locationId: targetLocId });

  if (cleanPhone.length >= 7) {
    const searchUrl = `https://services.leadconnectorhq.com/contacts/search?locationId=${targetLocId}&query=${cleanPhone}`;
    const res = await fetchWithRetry(searchUrl, { headers });
    if (res.status === 200) {
      const data = await res.json();
      const contacts = data.contacts || [];
      if (contacts.length > 0) return { ...contacts[0], locationId: targetLocId };
    }
  }

  if (email.includes('@')) {
    const searchUrl = `https://services.leadconnectorhq.com/contacts/search?locationId=${targetLocId}&query=${encodeURIComponent(email)}`;
    const res = await fetchWithRetry(searchUrl, { headers });
    if (res.status === 200) {
      const data = await res.json();
      const contacts = data.contacts || [];
      if (contacts.length > 0) return { ...contacts[0], locationId: targetLocId };
    }
  }

  return null;
}

/**
 * Contactos de vTiger modificados desde `modifiedTimeStr`, **por sede**.
 *
 * [SEDE-LOCK — CORRECCIÓN DE INCIDENTE]
 * ANTES esta consulta era `SELECT * FROM Contacts WHERE modifiedtime >= '...'`
 * SIN cláusula de sede. Al imponer el gate de aislamiento en el borde de la API
 * (`assertTenantIsolation`), el gate la empezó a RECHAZAR con
 * `SEDE_LOCK_VIOLATION`: el Reverse Sync llevaba ~871 ciclos fallando, es decir
 * ~44 h sin sincronizar vTiger -> GHL. Los cambios de vTiger (incluidas ventas
 * nuevas) no llegaban a GHL, y el contacto no aparecía en el chat.
 *
 * La consulta correcta es UNA por sede, cada una con su filtro `cf_3451`.
 */
async function fetchModifiedContactsBySede(modifiedTimeStr, limitPerSede = 50, sedes = null) {
  const sedesObjetivo = (sedes && sedes.length ? sedes : getActiveSedes().map(s => s.sedeId))
    .map(s => String(s).toUpperCase())
    .filter(s => VTIGER_SEDES_VALIDAS.includes(s));

  const acumulado = [];
  for (const sede of sedesObjetivo) {
    const safeTime = sanitizeForVtigerQuery(modifiedTimeStr, 25);
    const q = `SELECT * FROM Contacts WHERE modifiedtime >= '${safeTime}'${sedeClause(sede)} LIMIT ${Math.min(Math.max(parseInt(limitPerSede, 10) || 50, 1), 200)};`;
    try {
      const filas = await queryVTiger(q, sede);
      // [TRAZABILIDAD] El origen de cada registro queda marcado para el sync.
      for (const f of (filas || [])) acumulado.push({ ...f, __sedeOrigen: sede });
    } catch (err) {
      // El error ya quedó auditado dentro de `query()`. Aquí no se silencia:
      // se registra para que un fallo de sincronización sea VISIBLE.
      console.error(`[Reverse Sync] [ERROR] Consulta de modificados falló para la sede ${sede}: ${err.message}`);
      recordAuditEvent({
        type: 'REVERSE_SYNC_QUERY_FAILED',
        severity: 'error',
        sede,
        message: err.message
      });
    }
  }
  return acumulado;
}

/**
 * Demonio de Sincronización Inversa (Reverse Poller) 24/7.
 * Busca cambios en vTiger en los últimos X minutos y los refleja en GHL.
 * Aplica el DROP RULE: sin teléfono válido no se sincroniza y se audita.
 */
export async function runVTigerToGHLPoller(minutesLookback = 4) {
  try {
    // Calcular fecha en zona horaria UTC (vTiger suele trabajar en UTC o zona del servidor)
    // Para asegurar margen de error, restamos 4 minutos.
    const date = new Date(Date.now() - (minutesLookback * 60 * 1000));
    // Formato MySQL: YYYY-MM-DD HH:MM:SS
    const pad = n => n.toString().padStart(2, '0');
    const modifiedTimeStr = `${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

    // Consulta POR SEDE (Sede-Lock). Un fallo por sede no afecta a las demás.
    const modifiedContacts = await fetchModifiedContactsBySede(modifiedTimeStr, 50);

    if (!modifiedContacts || modifiedContacts.length === 0) return;
    
    console.log(`[Reverse Sync] [SYNC] ${modifiedContacts.length} contactos modificados en vTiger detectados en los últimos ${minutesLookback} mins. Sincronizando a GHL...`);

    let syncCount = 0;
    let descartadosSinTelefono = 0;
    let sinSede = 0;

    for (const vContact of modifiedContacts) {
      // [DROP RULE] El teléfono es el identificador único de sincronización.
      const phoneDigits = normalizeToE164(vContact.mobile || vContact.phone || vContact.homephone || vContact.otherphone || '');
      if (!phoneDigits) {
        descartadosSinTelefono++;
        recordAuditEvent({
          type: 'REVERSE_SYNC_DROPPED_NO_PHONE',
          severity: 'warn',
          vTigerId: vContact.id || null,
          nombre: `${vContact.firstname || ''} ${vContact.lastname || ''}`.trim().slice(0, 60),
          sedeRegistro: vContact.cf_3451 || null,
          reason: 'sin teléfono válido no se sincroniza (identificador único ausente)'
        });
        continue;
      }

      // 1. Encontrar su par en GHL
      const ghlContact = await findGhlContact(vContact);
      if (!ghlContact) {
        sinSede++;
        continue; // No existe en GHL (o el registro no tiene sede válida)
      }

      // Sede del REGISTRO de vTiger: define la subcuenta destino (hermetismo).
      const vSede = String(vContact.cf_3451 || vContact.__sedeOrigen || '').toUpperCase().trim();
      const targetLocId = ghlContact.locationId;

      // 2. Extraer "Ground Truth" para alimentar el Cerebro (Opcional, si cambió condición)
      // [VOCABULARIO CANÓNICO] Un único normalizador reemplaza la cadena de
      // `includes()` que antes devolvía 'Tetosterona' (nombre que el cerebro NO
      // reconoce) y omitía por completo Hongos y Gummies.
      const vCond = vContact.cf_2610 || '';
      const treatment = normalizeTreatment(vCond);

      if (treatment && ghlContact.tags && !ghlContact.tags.includes(`producto-${treatment.toLowerCase()}`)) {
         learningBrain.learnFromVtigerSale({ treatment, chatText: `Manual vTiger Sync: ${vCond}`, campaignName: 'vTiger Direct' });
      }

      // 3. Evaluar y Sanear Campos Comerciales (Regla de Oro: vTiger manda)
      // [SEDE-SHIELD] La sede activa se pasa a AMBAS funciones: el veredicto debe
      // usar exactamente la misma puerta de aislamiento que el saneado de campos.
      const sedeActivaSync = String(SEDES_GATEWAY[vSede]?.vtigerSedeName || vSede || '').toUpperCase();
      const truth = evaluateCommercialTruth(ghlContact, vContact, sedeActivaSync);
      const customFieldsToUpdate = buildSanitizedCommercialFields(ghlContact, vContact, targetLocId);
      // [GEO] Estado y ciudad saneados (el estado no debe viajar como ciudad).
      customFieldsToUpdate.push(...buildSanitizedGeoFields(vContact, targetLocId, ghlContact));

      const sedeContext = resolveSedeContext({ locationId: targetLocId });
      const customFieldsIds = sedeContext.customFields || {};

      const idAnuncioField = customFieldsIds.idAnuncio;
      const adIdAltField = customFieldsIds.adIdAlt;
      const utmCampaignField = customFieldsIds.utmCampaign;
      const utmSourceField = customFieldsIds.utmSource;
      const utmMediumField = customFieldsIds.utmMedium;
      const sedeAsignadaField = customFieldsIds.sedeAsignada;
      const origenLeadField = customFieldsIds.origenLead;
      const tieneTelefonoField = customFieldsIds.tieneTelefono;

      if (vContact.cf_2850) {
        customFieldsToUpdate.push({ id: idAnuncioField, key: 'contact.id_de_anuncio', field_value: String(vContact.cf_2850).trim() });
        customFieldsToUpdate.push({ id: adIdAltField, key: 'contact.ad_id', field_value: String(vContact.cf_2850).trim() });
      }
      if (vContact.cf_3472) {
        customFieldsToUpdate.push({ id: utmCampaignField, key: 'contact.utm_campaign', field_value: String(vContact.cf_3472).trim() });
      }
      customFieldsToUpdate.push({ id: utmSourceField, key: 'contact.utm_source', field_value: 'facebook' });
      customFieldsToUpdate.push({ id: utmMediumField, key: 'contact.utm_medium', field_value: 'cpc' });
      customFieldsToUpdate.push({ id: sedeAsignadaField, key: 'contact.sede_asignada', field_value: sedeContext.sedeId });
      const existingOrigenLead = (ghlContact.customFields || []).find(f => f.id === origenLeadField)?.value || ghlContact.source || '';
      const hasStructuredOrigen = /^[A-Z0-9_]+-[A-Z0-9_]+-[A-Z0-9_]+-[A-Za-z0-9_]+$/.test(String(existingOrigenLead).trim());
      if (vContact.cf_3507 && !hasStructuredOrigen) {
        customFieldsToUpdate.push({ id: origenLeadField, key: 'contact.origen_lead', field_value: String(vContact.cf_3507).trim() });
      }

      // 4. Armar Payload de Actualización Atómica
      // 4.1 Etiquetas Interactivas (Teléfono & Compra & vTiger Sync)
      const hasPhone = Boolean(ghlContact.phone || vContact.mobile || vContact.phone);
      if (tieneTelefonoField) {
        customFieldsToUpdate.push({ id: tieneTelefonoField, key: 'contact.tiene_telfono', field_value: hasPhone ? 'Sí' : 'No' });
      }

      const newTagsSet = new Set((ghlContact.tags || []).map(t => String(t).trim()));

      if (hasPhone) {
        newTagsSet.add('con-telefono');
        newTagsSet.delete('sin-telefono');
      } else {
        newTagsSet.add('sin-telefono');
        newTagsSet.delete('con-telefono');
      }

      newTagsSet.add('vtiger');
      newTagsSet.add('vtiger-sincronizado');

      if (truth.isWon) {
        newTagsSet.add('compro');
        newTagsSet.delete('no-compro');
        newTagsSet.add('cliente-vtiger');
        newTagsSet.delete('prospecto-vtiger');
      } else {
        newTagsSet.add('no-compro');
        newTagsSet.delete('compro');
        newTagsSet.add('prospecto-vtiger');
        newTagsSet.delete('cliente-vtiger');
      }

      if (vContact.cf_994) {
        const vStClean = String(vContact.cf_994).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (vStClean) newTagsSet.add(`vtiger-status-${vStClean}`);
      }
      if (vContact.cf_3507) {
        const vCanalClean = String(vContact.cf_3507).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (vCanalClean) newTagsSet.add(`canal-${vCanalClean}`);
      }

      // 4.2 Refuerzo de Etiquetas de Producto:
      // Si el contacto ya tiene una etiqueta activa de pauta Meta Ads ('meta-ads' o producto detectado recientemente),
      // no sobreescribir con una dolencia antigua de vTiger.
      const hasActiveMetaAds = (ghlContact.tags || []).includes('meta-ads');
      const hasExistingProductTag = (ghlContact.tags || []).some(t => isProductTag(t));

      if (treatment && (!hasActiveMetaAds || !hasExistingProductTag)) {
        const activeProductTag = toProductTag(treatment);
        newTagsSet.add(activeProductTag);

        // Purgar etiquetas falsas/obsoletas de otros productos (incluye la legada
        // `producto-tetosterona`, que se normaliza a `producto-potencia`).
        for (const pTag of PRODUCT_TAGS) {
          if (pTag !== activeProductTag) {
            newTagsSet.delete(pTag);
          }
        }
      }
      
      const updatePayload = {
        customFields: customFieldsToUpdate.filter(cf => cf && cf.id && cf.field_value !== ''),
        tags: Array.from(newTagsSet)
      };

      // 5. Inyectar a GHL (Custom Fields y Tags sanados) con headers específicos de subcuenta
      const targetHeaders = getGhlHeaders({ locationId: targetLocId });

      await acquireContactLock(ghlContact.id);
      try {
        const updateRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${ghlContact.id}`, {
          method: 'PUT',
          headers: targetHeaders,
          body: JSON.stringify(updatePayload)
        });

        if (updateRes.status === 200) {
           syncCount++;
           console.log(`[Reverse Sync] [SUCCESS] Cliente ${vContact.firstname || ''} ${vContact.lastname || ''} sincronizado de vTiger a GHL exitosamente.`);

           // 6. Sincronizar Oportunidad en el Pipeline Unificado
           try {
             const cardTitle = `${ghlContact.name || `${vContact.firstname || ''} ${vContact.lastname || ''}`.trim()}`;
             await syncUnifiedPipelineOpportunity(
               ghlContact.id,
               cardTitle,
               truth.isWon,
               true,
               truth.totalSpent,
               ghlContact.assignedTo,
               { locationId: targetLocId, headers: targetHeaders }
             );
           } catch (oppErr) {
             console.warn(`[Reverse Sync] [WARN] No se pudo sincronizar oportunidad para ${ghlContact.id}:`, oppErr.message);
           }
        }
      } finally {
        releaseContactLock(ghlContact.id);
      }
      
      await sleep(250); // Rate Limit Protection
    }
    
    if (syncCount > 0) {
      console.log(`[Reverse Sync] [COMPLETED] Ciclo completado. ${syncCount} contactos actualizados en GHL.`);
    }
    if (descartadosSinTelefono > 0 || sinSede > 0) {
      console.log(`[Reverse Sync] [CYCLE] Descartados sin teléfono: ${descartadosSinTelefono} | Sin par en GHL o sin sede válida: ${sinSede}.`);
    }

  } catch (error) {
    console.error(`[Reverse Sync Error]:`, error.message);
  }
}
