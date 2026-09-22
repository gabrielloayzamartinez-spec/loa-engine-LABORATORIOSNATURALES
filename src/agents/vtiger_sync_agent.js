import { queryVTiger } from '../services/vtiger_api_service.js';
import { GHL_CONFIG, SEDES_GATEWAY, getGhlHeaders, resolveSedeContext } from '../config/index.js';
import { ghlFetch, GHL_HEADERS } from '../utils/ghl_http_client.js';
import { acquireContactLock, releaseContactLock } from './chat_router_agent.js';
import { buildSanitizedCommercialFields, evaluateCommercialTruth } from '../domain/commercial_engine.js';
import { syncUnifiedPipelineOpportunity } from '../services/ghl_opportunity_service.js';
import { learningBrain } from '../services/learning_brain.js';

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

  // [CENTRAL GUARD]: Nunca sincronizar hacia la bóveda Central Universal pasiva
  const sedeContext = resolveSedeContext({ locationId: targetLocId, sede: vSede });
  if (sedeContext && sedeContext.allowActiveRouting === false) {
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
 * Demonio de Sincronización Inversa (Reverse Poller) 24/7.
 * Busca cambios en vTiger en los últimos X minutos y los refleja en GHL.
 */
export async function runVTigerToGHLPoller(minutesLookback = 4) {
  try {
    // Calcular fecha en zona horaria UTC (vTiger suele trabajar en UTC o zona del servidor)
    // Para asegurar margen de error, restamos 4 minutos.
    const date = new Date(Date.now() - (minutesLookback * 60 * 1000));
    // Formato MySQL: YYYY-MM-DD HH:MM:SS
    const pad = n => n.toString().padStart(2, '0');
    const modifiedTimeStr = `${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

    // Consultamos los contactos modificados recientemente
    const q = `SELECT * FROM Contacts WHERE modifiedtime >= '${modifiedTimeStr}' LIMIT 50;`;
    let modifiedContacts = [];
    try {
       modifiedContacts = await queryVTiger(q);
    } catch(err) {
       // Si vtiger falla o no soporta modifiedtime en esta version WS, salir silenciosamente
       return;
    }

    if (!modifiedContacts || modifiedContacts.length === 0) return;
    
    console.log(`[Reverse Sync] [SYNC] ${modifiedContacts.length} contactos modificados en vTiger detectados en los últimos ${minutesLookback} mins. Sincronizando a GHL...`);

    let syncCount = 0;
    for (const vContact of modifiedContacts) {
      // 1. Encontrar su par en GHL
      const ghlContact = await findGhlContact(vContact);
      if (!ghlContact) continue; // Si no existe en GHL, lo ignoramos

      // 2. Extraer "Ground Truth" para alimentar el Cerebro (Opcional, si cambió condición)
      const vCond = vContact.cf_2610 || '';
      let treatment = null;
      const lower = vCond.toLowerCase();
      if (lower.includes('tetosterona') || lower.includes('testosterona') || lower.includes('potencia')) treatment = 'Tetosterona';
      else if (lower.includes('diabet')) treatment = 'Diabetes';
      else if (lower.includes('artrit')) treatment = 'Artritis';
      else if (lower.includes('hongo')) treatment = 'Hongos';
      else if (lower.includes('gastro') || lower.includes('gastrit')) treatment = 'Gastro';
      else if (lower.includes('gumm') || lower.includes('gomit')) treatment = 'Gummies';
      else if (lower.includes('prostat')) treatment = 'Prostata';
      else if (lower.includes('colagen')) treatment = 'Colageno';
      else if (lower.includes('vision')) treatment = 'Vision';

      if (treatment && ghlContact.tags && !ghlContact.tags.includes(`producto-${treatment.toLowerCase()}`)) {
         learningBrain.learnFromVtigerSale({ treatment, chatText: `Manual vTiger Sync: ${vCond}`, campaignName: 'vTiger Direct' });
      }

      // 3. Evaluar y Sanear Campos Comerciales (Regla de Oro: vTiger manda)
      const targetLocId = ghlContact.locationId || SEDES_GATEWAY.PALACIOS.ghl.locationId;
      const truth = evaluateCommercialTruth(ghlContact, vContact);
      const customFieldsToUpdate = buildSanitizedCommercialFields(ghlContact, vContact, targetLocId);

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
      const ALL_PRODUCT_TAGS = [
        'producto-artritis', 'producto-diabetes', 'producto-prostata', 'producto-potencia', 
        'producto-tetosterona', 'producto-colageno', 'producto-vision', 'producto-gastro', 
        'producto-hongos', 'producto-gummies'
      ];
      const hasActiveMetaAds = (ghlContact.tags || []).includes('meta-ads');
      const hasExistingProductTag = (ghlContact.tags || []).some(t => ALL_PRODUCT_TAGS.includes(t));

      if (treatment && (!hasActiveMetaAds || !hasExistingProductTag)) {
        const activeProductTag = `producto-${treatment.toLowerCase()}`;
        newTagsSet.add(activeProductTag);
        
        // Purgar etiquetas falsas/obsoletas de otros productos
        for (const pTag of ALL_PRODUCT_TAGS) {
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

  } catch (error) {
    console.error(`[Reverse Sync Error]:`, error.message);
  }
}
