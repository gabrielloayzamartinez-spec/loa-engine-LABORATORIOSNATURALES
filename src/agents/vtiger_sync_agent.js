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
import { getStateStore } from '../services/state/state_store.js';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS = GHL_HEADERS;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==============================================================================
// [CURSOR DE SINCRONIZACION INVERSA] Estado persistente por sede
// ==============================================================================
// ANTES: el reverse sync usaba una VENTANA DE TIEMPO (`modifiedtime >= hace 4
// minutos`) con `LIMIT 50` y SIN `ORDER BY`. Tres consecuencias medidas:
//   1. El ciclo se desperdiciaba: en 4 min se modifican ~0 contactos, asi que el
//      ciclo corria cada 3 min para procesar nada.
//   2. Reprocesaba los mismos: una ventana de 4 min cada 3 min SIEMPRE solapa.
//   3. Se desbordaba EN SILENCIO: sin ORDER BY, si se modificaban mas de 50
//      contactos en la ventana se traian 50 al azar y el resto se PERDIA, porque
//      el siguiente ciclo usaba una ventana nueva que ya no los alcanzaba. Hoy no
//      ocurre (8 cambios en 30 min) pero ocurriria con una importacion o campana.
//
// AHORA: un CURSOR persistente por sede. Cada ciclo lee desde donde quedo, ordena
// del mas viejo al mas nuevo y AVANZA. Si hay backlog lo drena; si esta al dia, no
// hace nada. Una caida de vTiger no pierde cambios: el cursor no avanza y al volver
// recupera todo.
//
// NOTA DE PARSER (verificado en vivo): vTiger NO admite `ORDER BY a, b` (error
// "token ',' Unexpected COMMA"). Por eso el cursor es por `modifiedtime` y el
// desempate de ids iguales se resuelve en memoria con `idsEnCursor`.
// ==============================================================================
const reverseCursorStore = getStateStore('reverse_sync_cursor');
const CURSOR_KEY = 'cursor_v1';
const CURSOR_PAGE_SIZE = 50;   // filas por consulta
const CURSOR_MAX_PAGES = 20;   // tope de paginas por ciclo (drena sin bloquear)

/**
 * Guarda de solapamiento del reverse sync. La funcion se invoca desde el
 * scheduler y desde el webhook, y ambos comparten el cursor persistente.
 */
let reverseSyncCorriendo = false;

/** Campo de vTiger que marca la ultima modificacion del registro. */
const VTIGER_FIELDS_MODIFIED = 'modifiedtime';

const pad2 = n => String(n).padStart(2, '0');

/** Formatea una fecha como la espera vTiger: 'YYYY-MM-DD HH:MM:SS' en UTC. */
function formatoVtiger(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} `
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** Lee el estado del cursor (o {}) sin fallar si el store no responde. */
async function leerCursor() {
  try {
    const c = await reverseCursorStore.get(CURSOR_KEY, null);
    return c && typeof c === 'object' ? c : {};
  } catch (err) {
    console.warn(`[Reverse Sync] [CURSOR-WARN] No se pudo leer el cursor: ${err.message}`);
    return {};
  }
}

/** Persiste el estado del cursor. Un fallo no debe tumbar el ciclo. */
async function guardarCursor(estado) {
  try {
    await reverseCursorStore.set(CURSOR_KEY, estado);
  } catch (err) {
    console.warn(`[Reverse Sync] [CURSOR-WARN] No se pudo guardar el cursor: ${err.message}`);
  }
}

/**
 * Lee UNA pagina de contactos modificados desde el cursor de una sede,
 * ordenada del mas antiguo al mas nuevo.
 *
 * RESTRICCION DE PARSER (verificado en vivo): vTiger NO admite `IS NOT NULL`
 * ("token 'IS' Unexpected VALUE(IS)"). El filtro por fecha ES la condicion
 * obligatoria; no hace falta una comprobacion de nulos porque `modifiedtime`
 * siempre tiene valor en vTiger.
 *
 * @param {string} sede
 * @param {string} desde  modifiedtime desde el que leer (obligatorio)
 * @returns {Promise<Array>} filas
 */
async function fetchPaginaModificados(sede, desde, limite = CURSOR_PAGE_SIZE) {
  // ORDER BY ASC es IMPRESCINDIBLE: garantiza que se procesen primero los cambios
  // mas antiguos y que el cursor avance de forma monotona. Sin el, una pagina con
  // mas filas que el limite perderia cambios.
  const q = `SELECT * FROM Contacts WHERE ${VTIGER_FIELDS_MODIFIED} >= '${sanitizeForVtigerQuery(desde, 25)}'${sedeClause(sede)} ORDER BY ${VTIGER_FIELDS_MODIFIED} ASC LIMIT ${limite};`;
  return queryVTiger(q, sede, { timeoutMs: 30000, maxAttempts: 4 });
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

  // [ENDPOINT CORREGIDO] `/contacts/search` responde HTTP 400 en esta cuenta y
  // hacía que el Reverse Sync no encontrara NUNCA el par en GHL. El correcto es
  // `/contacts/?locationId=...&query=...` (verificado en vivo).
  const headers = getGhlHeaders({ locationId: targetLocId });

  if (cleanPhone.length >= 7) {
    const searchUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${targetLocId}&query=${cleanPhone}`;
    const res = await fetchWithRetry(searchUrl, { headers });
    if (res.status === 200) {
      const data = await res.json();
      const contacts = data.contacts || [];
      if (contacts.length > 0) return { ...contacts[0], locationId: targetLocId };
    } else {
      console.warn(`[Reverse Sync] [SEARCH-WARN] Búsqueda por teléfono devolvió HTTP ${res.status}.`);
    }
  }

  if (email.includes('@')) {
    const searchUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${targetLocId}&query=${encodeURIComponent(email)}`;
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
 * [REMOVIDO] `fetchModifiedContactsBySede` leia por VENTANA DE TIEMPO
 * (`modifiedtime >= hace 4 min`) con `LIMIT 50` y SIN `ORDER BY`. Se sustituyo por
 * `fetchPaginaModificados`, que lee desde un CURSOR persistente con `ORDER BY
 * modifiedtime ASC`. Motivos medidos:
 *   - La ventana de 4 min casi siempre traia 0 registros (en 30 min solo hubo 8
 *     cambios en Palacios): el ciclo corria cada 3 min para no hacer nada.
 *   - Una ventana de 4 min cada 3 min SIEMPRE solapa: reprocesaba los mismos.
 *   - Sin `ORDER BY`, si se modificaban mas de 50 registros en la ventana se
 *     traian 50 al azar y el resto se PERDIA en silencio.
 * Se conserva la nota historica del incidente de Sede-Lock, que sigue siendo
 * valida: la consulta DEBE llevar la clausula de sede (ahora lo hace
 * `fetchPaginaModificados` via `sedeClause`).
 */

/**
 * Demonio de Sincronización Inversa (Reverse Poller) 24/7.
 *
 * [CURSOR] Lee desde el cursor persistente de cada sede, del cambio mas antiguo al
 * mas nuevo, y AVANZA. Drena el backlog en varias paginas dentro del mismo ciclo.
 * Ya no usa una ventana de tiempo: eso perdia cambios cuando habia mas de 50
 * modificaciones en la ventana y reprocesaba siempre las mismas filas.
 *
 * Aplica el DROP RULE: sin teléfono válido no se sincroniza y se audita.
 *
 * @param {number} [minutesLookback] Ya no define la ventana de lectura; se conserva
 *        por compatibilidad de firma con los llamantes existentes.
 */
export async function runVTigerToGHLPoller(minutesLookback = 4) {
  // ==========================================================================
  // [GUARDA DE SOLAPAMIENTO — DEFECTO CORREGIDO]
  //
  // Esta funcion se invoca desde DOS sitios: el scheduler (cada 180 s) y el
  // webhook `/webhook/vtiger`. Sin guarda, ambos ciclos leen el MISMO cursor,
  // avanzan por separado y el que guarde ULTIMO pisa al otro: los cambios que el
  // primero ya habia procesado se saltan de forma PERMANENTE, porque el cursor
  // quedo mas adelante de donde el otro lo dejo.
  //
  // Se descarta el disparo si ya hay un ciclo en curso. El trabajo no se pierde:
  // el cursor no avanzo, asi que el ciclo en curso (o el siguiente) lo cubre.
  // ==========================================================================
  if (reverseSyncCorriendo) {
    console.warn('[Reverse Sync] [SKIP] Ya hay un ciclo en curso: se omite este disparo para no pisar el cursor.');
    return { ok: false, skipped: true, reason: 'ciclo en curso' };
  }
  reverseSyncCorriendo = true;

  try {
    const sedesObjetivo = getActiveSedes().map(s => s.sedeId);

    const estadoCursor = await leerCursor();
    // Techo de seguridad: no se leen registros con `modifiedtime` futuro (relojes
    // desfasados entre vTiger y el servidor). Se deja 5 s de margen.
    const techo = formatoVtiger(new Date(Date.now() - 5000));

    const resumenCiclo = {
      sedes: {}, totalNuevos: 0, totalPaginas: 0, backlogRestante: false
    };

    for (const sede of sedesObjetivo) {
      const previo = estadoCursor[sede] || {};
      // [INICIALIZACION] En la primera corrida (sin cursor) se arranca desde una
      // ventana corta hacia atras, NO desde el origen de los tiempos. Motivo: los
      // cambios historicos ya los cubren el backfill de compradores y el puente de
      // ventas; reprocesar anos de `modifiedtime` en el primer arranque saturaria
      // vTiger y GHL sin aportar nada. La ventana inicial es configurable.
      const ventanaInicialMin = Math.min(Math.max(parseInt(minutesLookback, 10) || 4, 1), 240);
      let cursor = previo.modifiedtime
        || formatoVtiger(new Date(Date.now() - ventanaInicialMin * 60 * 1000));
      const primeraVez = !previo.modifiedtime;
      // Ids ya procesados que comparten el `modifiedtime` del cursor. vTiger no
      // admite desempatar por id en el ORDER BY, asi que las filas del mismo
      // segundo se repiten entre paginas: aqui se descartan sin perder ninguna.
      let idsEnCursor = new Set(Array.isArray(previo.ids) ? previo.ids : []);

      let paginas = 0;
      let procesadosSede = 0;

      for (let p = 0; p < CURSOR_MAX_PAGES; p++) {
        let filas;
        try {
          filas = await fetchPaginaModificados(sede, cursor);
        } catch (err) {
          console.error(`[Reverse Sync] [ERROR] Lectura de modificados falló en ${sede}: ${err.message}`);
          recordAuditEvent({
            type: 'REVERSE_SYNC_QUERY_FAILED',
            severity: 'error',
            sede,
            message: err.message,
            cursor: cursor || null
          });
          break; // el cursor NO avanza: el proximo ciclo reintenta desde el mismo punto
        }

        // [AVANCE CUANDO NO HAY FILAS] Si la consulta no devuelve nada, el cursor
        // avanza al TECHO (la hora actual). Sin este avance el cursor quedaria
        // pegado consultando eternamente el mismo rango y nunca alcanzaria los
        // cambios nuevos. No se pierde nada: si no hay filas, no habia cambios
        // entre el cursor y el techo.
        if (!filas || filas.length === 0) {
          cursor = techo > cursor ? techo : cursor;
          break;
        }
        paginas++;

        for (const f of filas) {
          // Se salta lo ya procesado de este mismo instante (sin perdida).
          if (f.modifiedtime === cursor && idsEnCursor.has(String(f.id))) continue;
          if (f.modifiedtime > techo) continue; // fuera de la ventana segura
          await procesarContactoModificado({ ...f, __sedeOrigen: sede });
          procesadosSede++;
        }

        // Avance del cursor. Se guarda el `modifiedtime` de la ULTIMA fila leida,
        // con los ids de ese mismo instante para no reprocesarlos.
        const ultima = filas[filas.length - 1];
        const nuevoCursor = ultima.modifiedtime;
        const idsMismoInstante = filas
          .filter(f => f.modifiedtime === nuevoCursor)
          .map(f => String(f.id));

        if (nuevoCursor === cursor) {
          // Mismo instante: se acumulan los ids para no repetirlos.
          for (const id of idsMismoInstante) idsEnCursor.add(id);
        } else {
          cursor = nuevoCursor;
          idsEnCursor = new Set(idsMismoInstante);
        }

        if (filas.length < CURSOR_PAGE_SIZE) break; // se alcanzo el presente
      }

      estadoCursor[sede] = {
        modifiedtime: cursor,
        ids: Array.from(idsEnCursor).slice(-500), // tope: no crecer sin limite
        ultimaEjecucion: new Date().toISOString(),
        procesadosUltimoCiclo: procesadosSede,
        paginasUltimoCiclo: paginas,
        inicializado: true
      };

      resumenCiclo.sedes[sede] = { procesados: procesadosSede, paginas, cursor };
      resumenCiclo.totalNuevos += procesadosSede;
      resumenCiclo.totalPaginas += paginas;
      if (paginas >= CURSOR_MAX_PAGES) resumenCiclo.backlogRestante = true;

      if (primeraVez) {
        console.log(`[Reverse Sync] [${sede}] Cursor inicializado en ${cursor} (no se recorre el historico: de eso se encarga el backfill).`);
      } else if (procesadosSede > 0) {
        console.log(`[Reverse Sync] [${sede}] ${procesadosSede} cambios sincronizados en ${paginas} pagina(s). Cursor -> ${cursor}`);
      }
    }

    await guardarCursor(estadoCursor);

    if (resumenCiclo.totalNuevos > 0 || resumenCiclo.backlogRestante) {
      recordAuditEvent({
        type: 'REVERSE_SYNC_CYCLE',
        severity: 'info',
        ...resumenCiclo
      });
    }
    return resumenCiclo;
  } catch (err) {
    console.error('[Reverse Sync] [ERROR] Ciclo fallido:', err.message);
    recordAuditEvent({ type: 'REVERSE_SYNC_CYCLE_FAILED', severity: 'error', message: err.message });
    return { ok: false, error: err.message };
  } finally {
    // Se libera SIEMPRE (exito, fallo o excepcion): si quedara en true, el ciclo
    // se omitiria para siempre y el reverse sync moriria en silencio.
    reverseSyncCorriendo = false;
  }
}

/**
 * Procesa UN contacto modificado: encuentra su par en GHL y lo actualiza.
 * Se extrajo del bucle para que el poller pueda recorrer varias paginas con cursor.
 */
async function procesarContactoModificado(vContact) {
  try {
    // [DROP RULE] El teléfono es el identificador único de sincronización.
    const phoneDigits = normalizeToE164(vContact.mobile || vContact.phone || vContact.homephone || vContact.otherphone || '');
    if (!phoneDigits) {
      recordAuditEvent({
        type: 'REVERSE_SYNC_DROPPED_NO_PHONE',
        severity: 'warn',
        vTigerId: vContact.id || null,
        nombre: `${vContact.firstname || ''} ${vContact.lastname || ''}`.trim().slice(0, 60),
        sedeRegistro: vContact.cf_3451 || null,
        reason: 'sin teléfono válido no se sincroniza (identificador único ausente)'
      });
      return { ok: false, reason: 'sin telefono' };
    }
    return await aplicarCambioEnGhl(vContact, phoneDigits);
  } catch (err) {
    console.error(`[Reverse Sync] [CONTACT-ERROR] ${vContact?.id}: ${err.message}`);
    recordAuditEvent({
      type: 'REVERSE_SYNC_CONTACT_FAILED',
      severity: 'warn',
      vTigerId: vContact?.id || null,
      sedeRegistro: vContact?.cf_3451 || null,
      message: err.message
    });
    return { ok: false, error: err.message };
  }
}

/**
 * Replica en GHL el estado de un contacto modificado (logica original del poller,
 * ahora por contacto en lugar de un bucle con ventana de tiempo).
 */
async function aplicarCambioEnGhl(vContact, phoneDigits) {
  {
    const ghlContact = await findGhlContact(vContact);
    if (!ghlContact) return { ok: false, reason: 'sin par en GHL' };

    {
      // 1. Sede del REGISTRO de vTiger: define la subcuenta destino (hermetismo).
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
      return { ok: true, actualizado: true };
    }
  }
}
