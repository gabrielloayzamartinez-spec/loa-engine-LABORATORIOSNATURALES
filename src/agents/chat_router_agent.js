import { GHL_CONFIG, FB_PAGE_ID_MAP, PAGE_TAG_MAP, PALACIOS_USERS, SEDES_GATEWAY, resolveSedeContext, getGhlHeaders, resolveSedeCustomFields } from '../config/index.js';
import { toProductTag, PRODUCT_TAGS, normalizeTreatment, normalizeTreatmentOrUnknown, UNKNOWN_TREATMENT } from '../domain/clinical_vocabulary.js';
import { resolveChannelFromEvent, detectSystemMessage } from '../utils/system_message_filter.js';
import { recordAuditEvent } from '../services/audit_logger.js';
import { resolveCustomFieldIds } from '../services/dual_sync_service.js';
import { ghlFetch, GHL_HEADERS } from '../utils/ghl_http_client.js';
import { analyzeSymptoms, extractShippingData, buildVtigerSource, resolveLeadProvider, resolveLeadSede, resolveLeadChannel, inferTreatmentFromCampaignOrUtm, isValidMetaAdId, isAdsetCandidate } from './nlp_symptom_engine.js';
import { extraerAdIdDeMensaje, extraerAdIdDeMensajes, extraerPageIdDeMensaje, resolverAdId } from '../services/ad_id_resolver.js';
import { isContextualDuplicate } from './fuzzy_matcher.js';
import { findVTigerContact } from '../services/vtiger_api_service.js';
import { learningBrain } from '../services/learning_brain.js';
import { buildSanitizedCommercialFields, evaluateCommercialTruth } from '../domain/commercial_engine.js';
import { syncUnifiedPipelineOpportunity } from '../services/ghl_opportunity_service.js';
import { getMetaAdDetails } from '../services/meta_api_service.js';

const { apiKey, locationId } = GHL_CONFIG;

/**
 * Save Process: Inyecta una Nota Histórica en el perfil de GHL ante un nuevo toque o cambio de pauta
 */
export function buildAdHistoryNoteBody({
  dateStr,
  newAdId,
  oldAdId,
  oldAdDate,
  previousSede,
  previousCampaign,
  previousTreatment,
  campaign,
  pageName,
  clickCount,
  source,
  treatment,
  isDoubleAdEntry = false,
  isGraceExpired = true,
  isMudanzaDeSede = false
}) {
  const formattedDate = dateStr || new Date().toLocaleString('es-PE', { timeZone: 'America/New_York' });
  const isDiffAd = Boolean(oldAdId && oldAdId !== 'Ninguna previa' && oldAdId !== 'Ninguna previa (Orgánico)' && oldAdId !== newAdId);
  const noteTitle = isDiffAd
    ? `[SAVE PROCESS: REINGRESO POR NUEVO ANUNCIO / CAMPAÑA DIFERENTE]`
    : (isDoubleAdEntry ? `[SAVE PROCESS: REINGRESO DE PAUTA / DOBLE INGRESO PUBLICITARIO]` : `[SAVE PROCESS: Ruteo y Diagnostico de Pauta]`);

  let interaccionText = `Clic #${clickCount || 1}`;
  if (isDiffAd || isDoubleAdEntry) {
    const datePart = oldAdDate ? `  ${oldAdDate}` : '';
    let contextPart = '';
    if (isMudanzaDeSede || previousSede === 'OTRA SEDE') {
      contextPart = '  (OTRA SEDE)';
    } else {
      const cleanPrevSede = previousSede || 'PALACIOS';
      const campSnippet = previousCampaign ? ` - ${previousCampaign.substring(0, 32)}` : '';
      const cleanTreatment = (previousTreatment && previousTreatment !== 'General') ? ` - ${previousTreatment}` : (previousTreatment ? ` - ${previousTreatment}` : '');
      contextPart = `  (${cleanPrevSede}${campSnippet}${cleanTreatment})`;
    }
    const vigenciaPart = ` ("${isGraceExpired ? 'tiempo de gracia expirado' : 'vigencia activa'}")`;
    
    const adLabel = isDiffAd
      ? `Anuncio / Campaña Previa: ${oldAdId}`
      : `Anuncio: ${newAdId}`;

    interaccionText = `DOBLE INGRESO PUBLICITARIO - ${adLabel}${datePart}${contextPart}${vigenciaPart}`;
  } else if (!oldAdId || oldAdId.includes('Orgánico')) {
    interaccionText = `1er Ingreso Publicitario tras Tráfico Orgánico`;
  }

  const estadoPautaText = isDiffAd
    ? `ACTUALIZADO (Ad ID y Origen renovados por nuevo anuncio)`
    : (isDoubleAdEntry ? `ACTUALIZADO (Reingreso de pauta detectado - Nuevo clic Meta)` : (newAdId ? `VINCULADO (Ad ID y Origen asignados)` : `ORGÁNICO (Sin costo publicitario)`));

  return `${noteTitle}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Fecha: ${formattedDate} (EST)
- Origen/Fuente Asignada: ${source || 'N/A'}
- Tratamiento Detectado: ${treatment || 'General'}
- Nuevo Ad ID: ${newAdId || 'Orgánico / Sin Ad'}
- Fanpage de Entrada: ${pageName || 'N/A'}
- Campaña Detectada: ${campaign || 'N/A'}
- Interacción: ${interaccionText}
- Estado de Pauta: ${estadoPautaText}
----------------------------------------
Powered by LOA Engine - Gabriel Loayza`;
}

const lastInjectedNoteTime = new Map();

export async function saveAdHistoryNote(contactId, params, options = {}) {
  // 1. Memoria rápida anti-loop (evita ráfagas repetidas en menos de 4 horas para el mismo contacto)
  const lastTime = lastInjectedNoteTime.get(contactId) || 0;
  if (Date.now() - lastTime < 4 * 60 * 60 * 1000) {
    console.log(`[Agente 4 Save Process] [GUARD] Nota ya inyectada hace menos de 4h en memoria para ${contactId}. Omitiendo.`);
    return null;
  }

  const targetHeaders = options.headers || getGhlHeaders({ locationId: options.locationId || locationId });
  const noteUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;

  // 2. Verificación en GHL: Consultar notas recientes para no duplicar si el proceso se reinicia
  try {
    const checkRes = await fetchWithRetry(noteUrl, { headers: targetHeaders });
    if (checkRes.status === 200) {
      const notesData = await checkRes.json();
      const existingNotes = notesData.notes || [];
      const recentSaveProcessNote = existingNotes.find(n => {
        const body = n.body || '';
        if (!body.includes('[SAVE PROCESS:')) return false;
        const noteDate = new Date(n.dateAdded).getTime();
        return (Date.now() - noteDate) < (4 * 60 * 60 * 1000); // Menos de 4 horas
      });
      if (recentSaveProcessNote) {
        console.log(`[Agente 4 Save Process] [GUARD] Ya existe nota Save Process creada en GHL en las últimas 4h para ${contactId}. Omitiendo.`);
        lastInjectedNoteTime.set(contactId, Date.now());
        return null;
      }
    }
  } catch (checkErr) {
    // Continuar si falla la lectura previa
  }

  const noteBody = buildAdHistoryNoteBody(params);

  try {
    await fetchWithRetry(noteUrl, {
      method: 'POST',
      headers: targetHeaders,
      body: JSON.stringify({ body: noteBody })
    });
    lastInjectedNoteTime.set(contactId, Date.now());
    console.log(`[Agente 4 Save Process] [NOTE] Nota histórica inyectada para contacto ${contactId}`);
    return noteBody;
  } catch (err) {
    console.error(`[Agente 4 Save Process Error]:`, err.message);
    return null;
  }
}

/**
 * Save Process: Inyecta una Nota Histórica de MUDANZA DE SEDE AUTORIZADA en GHL
 */
export async function saveMudanzaHistoryNote(contactId, params = {}, options = {}) {
  // En la arquitectura multi-tenant de subcuentas aisladas, cada subcuenta es soberana
  // y la mudanza de sede no existe. Preservado como no-op seguro para retrocompatibilidad.
  return null;
}

const HEADERS = GHL_HEADERS;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let liveRateLimitBlockedUntil = 0;
let backgroundRateLimitBlockedUntil = 0;

// ==========================================================================
// [MEDIDOR DE COSTO POR CONTACTO — nivel 1]
// Responde con datos reales, no estimaciones, la pregunta:
// "¿cuánta cuota de API consume atender a UN contacto nuevo de nivel 1?".
// Cada llamada que sale del router pasa por `fetchWithRetry`, así que basta con
// contar ahí y comparar el total al entrar y al salir de cada ruteo. El resultado
// se publica en /api/health para poder planificar la cuota del día.
// ==========================================================================
let contadorLlamadasGhl = 0;
let llamadasAlIniciarRuteo = 0;
const costosRuteo = [];              // últimos ruteos medidos
const COSTOS_MAX = 50;
const estadisticasCosto = { ultimo: null, promedio: null, maximo: null, minimo: null, muestras: 0, ultimoContacto: null, ultimoTs: null };

// ==========================================================================
// [DETECTOR DE BUCLES — LA AUDITORÍA TÉCNICA QUE FALTABA]
// El defecto más grave del sistema (un bucle infinito que reprocesaba los mismos
// contactos cada 5 s y consumía ~13,300 llamadas/hora) NO aparecía en ninguna de las
// auditorías existentes: todas revisaban la EXACTITUD DE LOS DATOS (campos, ruteo,
// atribución), ninguna la SALUD DE LAS FUNCIONES. Este contador cierra ese hueco:
// registra cuántas veces se rutea cada contacto en una hora. Si un contacto se rutea
// decenas de veces, hay un bucle, y se ve de inmediato.
// ==========================================================================
const ruteosPorContacto = new Map();          // contactId -> { count, primera, ultima }
const VENTANA_BUCLES_MS = 60 * 60 * 1000;     // ventana de 1 hora

function contarRuteoDeContacto(contactId) {
  const ahora = Date.now();
  const reg = ruteosPorContacto.get(contactId);
  if (!reg || (ahora - reg.primera) > VENTANA_BUCLES_MS) {
    ruteosPorContacto.set(contactId, { count: 1, primera: ahora, ultima: ahora });
  } else {
    reg.count++;
    reg.ultima = ahora;
  }
  // Poda oportunista para que el mapa no crezca sin control.
  if (ruteosPorContacto.size > 5000) {
    for (const [id, r] of ruteosPorContacto) {
      if ((ahora - r.ultima) > VENTANA_BUCLES_MS) ruteosPorContacto.delete(id);
    }
  }
}

/**
 * Diagnóstico de reprocesamiento: cuántos contactos se rutearon más de una vez en la
 * última hora y cuáles fueron los peores. Un valor alto delata un bucle.
 */
export function getReprocesos(umbralVeces = 3) {
  const ahora = Date.now();
  const vigentes = [...ruteosPorContacto.entries()].filter(([, r]) => (ahora - r.ultima) <= VENTANA_BUCLES_MS);
  const repetidos = vigentes.filter(([, r]) => r.count > 1);
  const bucle = vigentes.filter(([, r]) => r.count >= umbralVeces);

  const ruteosTotales = vigentes.reduce((a, [, r]) => a + r.count, 0);
  const contactosUnicos = vigentes.length;
  const desperdicioPct = ruteosTotales > 0
    ? Math.round(((ruteosTotales - contactosUnicos) / ruteosTotales) * 1000) / 10
    : 0;

  const peores = bucle
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15)
    .map(([id, r]) => ({
      contactId: id,
      ruteos: r.count,
      minutosActivo: Math.round((r.ultima - r.primera) / 60000),
      ultimoRuteo: new Date(r.ultima).toISOString()
    }));

  return {
    ventanaMin: 60,
    contactosUnicos,
    ruteosTotales,
    contactosRepetidos: repetidos.length,
    contactosEnBucle: bucle.length,
    desperdicioPct,
    veredicto: bucle.length === 0
      ? '🟢 SIN BUCLES: ningún contacto se rutea en exceso.'
      : (desperdicioPct > 50
        ? '🔴 BUCLE PROBABLE: más de la mitad de los ruteos son repeticiones sobre los mismos contactos.'
        : '🟡 REINTENTOS ALTOS: hay contactos ruteados varias veces; revisar la causa.'),
    peores
  };
}

function registrarCostoRuteo(contactId) {
  const costo = contadorLlamadasGhl - llamadasAlIniciarRuteo;
  if (costo <= 0) return;           // rutas abortadas antes de llamar (no ensucian la media)
  contarRuteoDeContacto(contactId);
  costosRuteo.push(costo);
  if (costosRuteo.length > COSTOS_MAX) costosRuteo.shift();
  estadisticasCosto.ultimo = costo;
  estadisticasCosto.ultimoContacto = contactId;
  estadisticasCosto.ultimoTs = new Date().toISOString();
  estadisticasCosto.muestras++;
  estadisticasCosto.promedio = Math.round((costosRuteo.reduce((a, b) => a + b, 0) / costosRuteo.length) * 10) / 10;
  estadisticasCosto.maximo = Math.max(...costosRuteo);
  estadisticasCosto.minimo = Math.min(...costosRuteo);
}

/** Estadísticas del costo de atender un contacto de nivel 1 (para /api/health). */
export function getCostoRuteo() {
  return { ...estadisticasCosto, llamadasTotalesRouter: contadorLlamadasGhl };
}

// fetchWithRetry ahora es un wrapper delgado sobre ghlFetch (centralizado en ghl_http_client.js)
async function fetchWithRetry(url, options, attempt = 1, _isLive = false) {
  contadorLlamadasGhl++;
  return ghlFetch(url, options, attempt, 'Agente 3');
}

// Mapa para controlar reintentos por delay de indexación
const indexingRetries = new Map();

// LOCK POR CONTACTO: Evita que el Radar y el Reverse Sync hagan PUT simultáneo al mismo contacto
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
export async function routeChatByContact(contactId, isLive = false, isDryRun = false, options = {}) {
  await acquireContactLock(contactId);
  // Punto de partida del medidor de costo (llamadas a GHL que consumirá este ruteo).
  llamadasAlIniciarRuteo = contadorLlamadasGhl;
  try {
    console.log(`[Agente 3] Analizando ruteo para el contacto ${contactId}... (Live: ${isLive}, DryRun: ${isDryRun})`);

    let activeLocationId = options.locationId || SEDES_GATEWAY.PALACIOS.ghl.locationId;
    let activeHeaders = options.headers || getGhlHeaders({ locationId: activeLocationId, sede: options.sede });

    // [SEDE GATEWAY] Resolución del contexto de subcuenta y bloqueo de sedes no registradas.
    // ARQUITECTURA DESCENTRALIZADA: no existe cuenta central; una ubicación desconocida
    // se rechaza en lugar de enrutarse contra la subcuenta de Palacios.
    const activeContext = resolveSedeContext({ locationId: activeLocationId });
    if (activeContext?.isUnresolved) {
      console.warn(`[Agente 3] [SEDE-UNRESOLVED] Ubicación ${activeLocationId} no pertenece a ninguna sede registrada. Ruteo abortado (fail-safe).`);
      return 'UNCHANGED';
    }

    // [CONFIG GUARD] Sede sin PIT/locationId cargado: no se emite tráfico externo.
    if (activeContext && activeContext.isConfigured === false) {
      console.warn(`[Agente 3] [SEDE-NO-CONFIGURADA] La sede ${activeContext.sedeId} no tiene credenciales cargadas. Ruteo diferido.`);
      return 'RETRY';
    }

    // 1. Cargar contacto de GHL UNA SOLA VEZ con detección y fallback de subcuenta (Palacios <-> Benavides)
    let contactRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: activeHeaders }, 1, isLive);

    if (contactRes.status === 403 || contactRes.status === 404) {
      const altLocId = activeLocationId === SEDES_GATEWAY.PALACIOS.ghl.locationId ? SEDES_GATEWAY.BENAVIDES.ghl.locationId : SEDES_GATEWAY.PALACIOS.ghl.locationId;
      const altHeaders = getGhlHeaders({ locationId: altLocId });
      const altRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: altHeaders }, 1, isLive);
      if (altRes.status === 200) {
        contactRes = altRes;
        activeLocationId = altLocId;
        activeHeaders = altHeaders;
        console.log(`[Agente 3] [MULTI-SEDE] Contacto ${contactId} resuelto en subcuenta ${activeLocationId}`);
      }
    }

    if (contactRes.status !== 200) {
      console.log(`[Agente 3] No se pudo obtener el contacto ${contactId}. Status: ${contactRes.status}`);
      if (contactRes.status >= 500) return 'RETRY';
      return;
    }

    const contactData = await contactRes.json();
    const contact = contactData.contact || contactData;
    if (contact.locationId && contact.locationId !== activeLocationId) {
      activeLocationId = contact.locationId;
      activeHeaders = getGhlHeaders({ locationId: activeLocationId });
    }

    // 2. Obtener la conversación del contacto
    const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${activeLocationId}&contactId=${contactId}`;
    const convRes = await fetchWithRetry(convUrl, { headers: activeHeaders }, 1, isLive);
    
    let allMessages = [];
    let fbMessages = [];
    // [CANAL REAL] Tipo del transporte del mensaje mas reciente, segun GHL.
    // Necesario para no asumir 'FB-MSGR' cuando el mensaje llego por SMS/Twilio.
    let latestMessageTransport = '';

    if (convRes.status === 200) {
      const convData = await convRes.json();
      const conversations = convData.conversations || [];
      
      if (conversations.length > 0) {
        // [FIX MISMO DÍA — MULTI-ATRIBUCIÓN] Recorrer TODAS las conversaciones (no solo
        // la primera). Un lead que entra por 2 anuncios de campañas distintas el MISMO
        // DÍA genera 2 conversaciones: si solo se lee la primera, el ad_id de la SEGUNDA
        // interacción se pierde y el origen queda atascado en el primer anuncio.
        const todasMsgs = [];
        const limiteConvs = Math.min(conversations.length, 5);
        for (let ci = 0; ci < limiteConvs; ci++) {
          const conv = conversations[ci];
          if (!conv?.id) continue;
          try {
            const msgUrl = `https://services.leadconnectorhq.com/conversations/${conv.id}/messages?locationId=${activeLocationId}&limit=20`;
            const msgRes = await fetchWithRetry(msgUrl, { headers: activeHeaders }, 1, isLive);
            if (msgRes.status === 200) {
              const msgData = await msgRes.json();
              const msgs = msgData.messages?.messages || [];
              todasMsgs.push(...msgs);
            }
          } catch { /* una conversación sin mensajes no aborta el lote */ }
        }

        allMessages = todasMsgs.sort((a, b) => new Date(b.dateAdded).getTime() - new Date(a.dateAdded).getTime());

        for (const m of allMessages) {
          // [EXTRACCION SISTEMATICA] El Ad ID se extrae SIEMPRE, aunque el mensaje
          // no traiga page id. DEFECTO CORREGIDO: antes la lectura del Ad ID estaba
          // DENTRO de `if (pageId)`, asi que un anuncio de WhatsApp/Instagram o un
          // referido sin `fromPageId` perdia el ID por completo y el lead quedaba
          // como ORGANICO aunque en Meta Business Suite tuviera su ID.
          const pageId = extraerPageIdDeMensaje(m);
          const adIdMsg = extraerAdIdDeMensaje(m);
          if (pageId || adIdMsg) {
            fbMessages.push({
              id: m.id,
              pageId: pageId ? String(pageId) : null,
              timestamp: new Date(m.dateAdded).getTime(),
              dateStr: m.dateAdded,
              adId: adIdMsg || null
            });
          }
        }
        fbMessages.sort((a, b) => b.timestamp - a.timestamp);
        // El transporte del mensaje mas reciente dicta el canal real.
        const newestAny = allMessages[0];
        latestMessageTransport = String(newestAny?.messageType || newestAny?.type || '').trim();
      } else {
        console.log(`[Agente 3] [FAST-PATH] Sin conversaciones indexadas aún para ${contactId}. Procesando y asignando directamente por subcuenta (${activeLocationId}).`);
      }
    } else {
      console.log(`[Agente 3] [FAST-PATH] Conversaciones no disponibles (Status ${convRes.status}). Ruteando directamente por subcuenta.`);
    }

    // ==========================================================================
    // [EARLY DROP] FILTRO DE MENSAJES DE SISTEMA / TRANSACCIONALES
    // ==========================================================================
    // INCIDENTE QUE ORIGINA ESTE FILTRO: un SMS con un código OTP de WhatsApp
    // ("Your WhatsApp code: 825-319") disparó todo el pipeline y creó un contacto
    // fantasma, una Oportunidad y una Tarjeta Forense con atribución FALSA.
    //
    // Los mensajes automatizados NO son leads. Se descartan AQUÍ, antes de
    // cualquier escritura en GHL, y el contacto queda intacto. Este es el punto
    // único por el que pasa todo ruteo (radar en vivo, webhooks y curación), por
    // lo que la defensa cubre todos los caminos de entrada.
    const ultimoEntrante = Array.isArray(allMessages)
      ? allMessages.find(m => m.direction === 'inbound' && m.body)
      : null;
    if (ultimoEntrante) {
      const sys = detectSystemMessage(ultimoEntrante.body);
      if (sys.isSystem) {
        console.log(`[Agente 3] [EARLY-DROP] Mensaje de sistema descartado (${sys.matched}). El contacto ${contactId} NO se procesa: cero mutaciones en GHL.`);
        recordAuditEvent({
          type: 'SYSTEM_MESSAGE_DROPPED',
          severity: 'info',
          contactId,
          locationId: activeLocationId,
          matched: sys.matched,
          bodyPreview: String(ultimoEntrante.body).slice(0, 60)
        });
        return 'SKIPPED_SYSTEM_MESSAGE';
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

    // Fallback: Si no se determinó por mensaje de Facebook, verificar si el contacto ya tiene etiquetas de sede.
    // El router etiqueta con slug a guiones ("bionatural-ultra"), asi que aqui se compara con la MISMA normalizacion.
    if (!targetPageName) {
      const tags = (contact.tags || []).map(t => String(t).toLowerCase());
      const slugificar = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      for (const pName of Object.keys(PAGE_TAG_MAP)) {
        if (tags.includes(slugificar(pName))) {
          targetPageName = pName;
          break;
        }
      }
    }

    // [PROCEDENCIA REAL vs CONTEXTO DE SUBCUENTA]
    // ANTES: si no había evidencia de Meta, el router FABRICABA una fanpage
    // ("Naturales BioNatural" / "Naturales Bio Corp"). Esa invención alimentaba
    // al resolvedor de proveedor, así que un lead por SMS/Twilio quedaba
    // atribuido a una fanpage de Facebook que nunca lo trajo (incidente del OTP).
    // Ahora se distingue: hasRealFanpage = hay evidencia REAL (mensaje Meta o tag).
    let hasRealFanpage = Boolean(targetPageId || targetPageName);

    if (!targetPageName) {
      if (activeLocationId === SEDES_GATEWAY.BENAVIDES.ghl.locationId) {
        targetPageName = "Naturales Bio Corp";
      } else {
        targetPageName = "Naturales BioNatural";
      }
    }

 // Resolver Sede Actual: la subcuenta define la sede operativa (sedes herméticas)
    let currentSedeName = resolveLeadSede({
      pageId: targetPageId,
      pageName: hasRealFanpage ? targetPageName : ''
    });
    if (!currentSedeName) {
      currentSedeName = (activeLocationId === SEDES_GATEWAY.BENAVIDES.ghl.locationId) ? 'BENAVIDES' : 'PALACIOS';
    }
    if (!hasRealFanpage) {
      console.log(`[Agente 3] [PROCEDENCIA] Sin evidencia de fanpage de Meta (transporte: ${latestMessageTransport || 'desconocido'}). Sede operativa: ${currentSedeName}. No se atribuye proveedor de pauta.`);
    }

    // Determinar a qué asesor le corresponde esta página (por Sede, Page ID o por Nombre de Fanpage)
    let targetAdvisorId = null;
    let targetAdvisorName = null;
    // [AUDITORIA DE RUTEO] Motivo por el que la asignacion NO se pudo confirmar con
    // evidencia de Meta. Si queda con valor, el contacto se etiqueta "revisar-ruteo"
    // para que sea auditable (antes la asignacion fallida era silenciosa).
    let routingReviewReason = null;

    const resolvedSede = resolveSedeContext({ pageId: targetPageId, sede: currentSedeName, locationId: activeLocationId });
    if (resolvedSede && resolvedSede.users) {
      if (resolvedSede.sedeId === 'BENAVIDES') {
        // ================================================================
        // [REGLA ESTRICTA DE PROPIETARIO — BENAVIDES]
        //   Naturales Bio Corp (510617778807469)                     -> REDES 1
        //   Bio Natural (126154270581792) / BioNatural Fuerza (…8423762) -> REDES 2
        //
        // MISMO DEFECTO QUE PALACIOS: el `else` atrapaba todo lo que no fuera
        // "corp", asi que un lead sin evidencia de fanpage caia en REDES 2 sin
        // dejar rastro. Ahora se evalua la evidencia REAL y se marca la revision.
        // ================================================================
        const esCorp = targetPageId === '510617778807469'
          || (targetPageName || '').toLowerCase().includes('corp');
        const esRedes2 = targetPageId === '126154270581792'
          || targetPageId === '1147742788423762'
          || (targetPageName || '').toLowerCase().includes('fuerza')
          || (targetPageName || '').toLowerCase().includes('bio natural');

        if (esCorp) {
          targetAdvisorId = resolvedSede.users.redes1.id;
          targetAdvisorName = resolvedSede.users.redes1.name;
        } else {
          targetAdvisorId = resolvedSede.users.redes2.id;
          targetAdvisorName = resolvedSede.users.redes2.name;
          if (!hasRealFanpage) {
            routingReviewReason = 'sin evidencia de fanpage de Meta';
          } else if (!esRedes2) {
            routingReviewReason = `fanpage no mapeada (${targetPageName || targetPageId})`;
          }
        }
      } else if (resolvedSede.sedeId === 'PALACIOS') {
        // ================================================================
        // [REGLA ESTRICTA DE PROPIETARIO — PALACIOS]
        //   CLICK2RING (REDES 2):
        //     - BioNatural - Ultra (111906554968800)
        //     - Laboratorios Naturales BIO (718150351371765) — formularios
        //   ERNESTO (REDES 1):
        //     - Naturales BioNatural (566501466542620)
        //
        // DEFECTO ANTERIOR: el `else` asignaba ERNESTO a CUALQUIER cosa que no
        // fuera ULTRA, incluso cuando la pagina NO se pudo confirmar (mensaje sin
        // metadatos de Meta, SMS, formulario). Asi un lead de ULTRA sin evidencia
        // terminaba en ERNESTO y sin dejar rastro. Ahora se evalua la evidencia
        // REAL y, si la pagina no esta mapeada o no hay evidencia, se mantiene la
        // continuidad operativa (ERNESTO) PERO se marca "revisar-ruteo".
        // ================================================================
        const esClick2Ring = targetPageId === '111906554968800'
          || targetPageId === '718150351371765'
          || (targetPageName || '').toLowerCase().includes('ultra')
          || (targetPageName || '').toLowerCase().includes('laboratorios naturales bio');
        const esErnesto = targetPageId === '566501466542620'
          || (targetPageName || '').toLowerCase().includes('bionatural');

        if (esClick2Ring) {
          targetAdvisorId = resolvedSede.users.ultra.id;
          targetAdvisorName = resolvedSede.users.ultra.name;
        } else {
          targetAdvisorId = resolvedSede.users.ernesto.id;
          targetAdvisorName = resolvedSede.users.ernesto.name;
          if (!hasRealFanpage) {
            routingReviewReason = 'sin evidencia de fanpage de Meta';
          } else if (!esErnesto) {
            routingReviewReason = `fanpage no mapeada (${targetPageName || targetPageId})`;
          }
        }
      }
    }

    // ==================================================================
    // [FALLBACK CONTEXTUAL SEGURO — SOLO ASESORES DE LA MISMA SUBCUENTA]
    //
    // DEFECTO ANTERIOR (afectaba a ROOSEVELT y PIURA): el fallback tenia un
    // `else` que asignaba el asesor de PALACIOS (ERNESTO) a CUALQUIER sede que
    // no fuera Benavides. Es decir, un lead de Roosevelt o Piura quedaba
    // asignado a un asesor de OTRA subcuenta: una fuga entre sedes.
    //
    // Ahora se toman SOLO los asesores de la subcuenta activa. Si la sede no
    // tiene asesores configurados, NO se asigna uno ajeno: queda para revision.
    // ==================================================================
    if (!targetAdvisorId) {
      const sedeActual = Object.values(SEDES_GATEWAY)
        .find(s => s?.ghl?.locationId === activeLocationId);
      const asesoresPropios = sedeActual?.users
        ? Object.values(sedeActual.users).filter(u => u?.id)
        : [];
      if (asesoresPropios.length > 0) {
        targetAdvisorId = asesoresPropios[0].id;
        targetAdvisorName = asesoresPropios[0].name;
        routingReviewReason = routingReviewReason || 'asignado por defecto al primer asesor de la sede';
      } else {
        routingReviewReason = `sede ${currentSedeName} sin asesores configurados`;
        console.warn(`[Agente 3] [RUTEO] ${currentSedeName} no tiene asesores configurados: no se asigna un asesor de otra subcuenta.`);
      }
    }

    // ==================================================================
    // [BLINDAJE MULTI-SEDE GENÉRICO]
    // El asesor asignado DEBE pertenecer a la subcuenta activa. Antes este
    // guard solo cubria BENAVIDES y PALACIOS: Roosevelt y Piura quedaban sin
    // proteccion. Ahora se aplica a las 4 sedes por locationId.
    // ==================================================================
    {
      const sedeActual = Object.values(SEDES_GATEWAY)
        .find(s => s?.ghl?.locationId === activeLocationId);
      const asesoresValidos = sedeActual?.users
        ? Object.values(sedeActual.users).filter(u => u?.id)
        : [];
      if (targetAdvisorId && asesoresValidos.length > 0
          && !asesoresValidos.some(u => u.id === targetAdvisorId)) {
        console.warn(`[Agente 3] [GUARD] Prevenida asignacion de asesor ajeno (${targetAdvisorId}) en ${currentSedeName}. Corrigiendo a ${asesoresValidos[0].name}.`);
        targetAdvisorId = asesoresValidos[0].id;
        targetAdvisorName = asesoresValidos[0].name;
        routingReviewReason = 'asesor de otra subcuenta prevenido por el guard';
      }
    }

    if (!targetAdvisorId) {
      console.log(`[Agente 3] No se encontró un asesor asignado para la página ${targetPageName}.`);
      return;
    }

    indexingRetries.delete(contactId); // Limpiar reintentos en caso de éxito

    const existingTags = (contact.tags || []).map(t => String(t).toLowerCase());
    const isCustomerWon = existingTags.includes('cliente-comprador') || existingTags.includes('venta-cerrada');

    // 4. MULTI-SEDE INDEPENDIENTE: OMISIÓN DE TIEMPO DE GRACIA ARTIFICIAL
    // Cada sede opera como entidad independiente en su propia subcuenta.
    // Se detecta si existió toque en otra fanpage previa con fines de auditoría forense,
    // pero sin abortar el procesamiento ni bloquear la asignación legítima.
    let expiredGraceMsg = null;
    let expiredTimeDiffHours = 0;

    if (newestMsg && fbMessages.length > 1) {
      for (const msg of fbMessages) {
        if (msg.pageId !== targetPageId) {
          const timeDiffHours = (newestMsg.timestamp - msg.timestamp) / (1000 * 60 * 60);
          expiredGraceMsg = msg;
          expiredTimeDiffHours = timeDiffHours;
          break;
        }
      }
    }

    // Custom Field IDs Oficiales Dinámicos por Subcuenta
    const sedeFields = resolveSedeCustomFields({ locationId: activeLocationId });
    const ID_ANUNCIO_FIELD = sedeFields.idAnuncio;
    const AD_ID_ALT_FIELD = sedeFields.adIdAlt;
    const TRATAMIENTO_FIELD = sedeFields.tratamientoComprado;
    const VTIGER_NOTAS_FIELD = sedeFields.historialCompleto;
    const UTM_SOURCE_FIELD = sedeFields.utmSource;
    const UTM_MEDIUM_FIELD = sedeFields.utmMedium;
    const UTM_CAMPAIGN_FIELD = sedeFields.utmCampaign;
    const UTM_CONTENT_FIELD = sedeFields.utmContent;
    const UTM_TERM_FIELD = sedeFields.utmTerm;
    const ADSET_ID_FIELD = sedeFields.adsetId;
    const SEDE_ASIGNADA_FIELD = sedeFields.sedeAsignada;
    const ORIGEN_LEAD_FIELD = sedeFields.origenLead;
    const TIENE_TELEFONO_FIELD = sedeFields.tieneTelefono;
    const ULTIMA_INTERACCION_FIELD = sedeFields.ultimaInteraccion;

    // [ATRIBUCION VISIBLE] Campos claros (Nombre del Anuncio / Campaña Meta / Conjunto).
    // Se resuelven POR NOMBRE (no estan en las tablas fijas por sede). Si aun no fueron
    // creados, la resolucion devuelve null y simplemente no se escriben (no es critico).
    let NOMBRE_ANUNCIO_FIELD = null;
    let CAMPANA_META_FIELD = null;
    let CONJUNTO_ANUNCIOS_FIELD = null;
    try {
      // [FIX] getGhlHeaders espera un OBJETO { locationId }. Antes se le pasaba el string
      // suelto: el destructuring dejaba locationId='' y resolvia un token VACIO, lo que
      // provocaba HTTP 403 en toda sede distinta a la de fallback (BENAVIDES/ROOSEVELT/PIURA).
      const atribucionIds = await resolveCustomFieldIds(activeLocationId, getGhlHeaders({ locationId: activeLocationId }));
      NOMBRE_ANUNCIO_FIELD = atribucionIds.nombreAnuncio || null;
      CAMPANA_META_FIELD = atribucionIds.campanaMeta || null;
      CONJUNTO_ANUNCIOS_FIELD = atribucionIds.conjuntoAnuncios || null;
    } catch { /* sin campos claros: se omite la escritura, no rompe el flujo */ }

    const existingCustomFields = contact.customFields || [];
    const rawCurrentAdId = existingCustomFields.find(f => (f.id === ID_ANUNCIO_FIELD || f.id === AD_ID_ALT_FIELD) && f.value)?.value;
    const currentAdId = isValidMetaAdId(rawCurrentAdId) ? String(rawCurrentAdId).trim() : null;
    const currentTratamiento = existingCustomFields.find(f => f.id === TRATAMIENTO_FIELD && f.value)?.value;
    const currentVtigerNota = existingCustomFields.find(f => f.id === VTIGER_NOTAS_FIELD && f.value)?.value;

 // A. FRESHNESS FIRST: DETECCIÓN DEL AD ID, ADSET (CONJUNTO DE ANUNCIOS), CAMPAÑA Y UTMS
    let latestAdId = null;
    let latestCampaign = null;
    let latestMedium = null;
    let latestAdSetName = null;

    // 1. Referral del mensaje (prioridad máxima para Ad ID). Se usa el resolutor
    //    SISTEMATICO: busca el ID en cualquier canal y en cualquier clave del
    //    metadata (Messenger, WhatsApp, Instagram, ads_context_data...), en vez de
    //    4 rutas fijas que dejaban fuera los formatos no previstos.
    const deMensajes = extraerAdIdDeMensajes(allMessages);
    if (deMensajes.adId) {
      latestAdId = deMensajes.adId;
      console.log(`[Agente 3] [AD-ID] Resuelto desde referral del mensaje (${deMensajes.fecha || 'sin fecha'}): ${latestAdId}`);
    }

    // 2. Recopilar todas las fuentes de atribución disponibles en GHL ordenadas por recencia
    // [ORDEN CORREGIDO — CRÍTICO] ANTES: `attributionSource` (PRIMER toque) iba PRIMERO,
    // asi que `latestCampaign`/`latestAdSetName` tomaban la campaña VIEJA y el origen
    // NO se actualizaba cuando el lead re-engañaba desde una campaña NUEVA (se perdia
    // el trabajo del dia). AHORA: el mas reciente PRIMERO (lastAttributionSource ->
    // attributions al reves -> attributionSource como ultimo recurso).
    const attributionSources = [];
    if (contact.lastAttributionSource) attributionSources.push(contact.lastAttributionSource);
    if (contact.attributions && Array.isArray(contact.attributions)) {
      attributionSources.push(...[...contact.attributions].reverse());
    }
    if (contact.attributionSource) attributionSources.push(contact.attributionSource);

    // [ATRIBUCIÓN MÁS RECIENTE] Helper para todo lo que refleja la interacción ACTUAL
    // (tratamiento, pauta pagada, canal). Evita caer en el PRIMER toque (attributionSource)
    // cuando el lead re-engaña el mismo día por otra campaña.
    const attrReciente = contact.lastAttributionSource || contact.attributionSource || null;

    for (const attr of attributionSources) {
      if (!attr) continue;

      // Ad ID
      const rawAttrId = attr.utmAdId || attr.adId;
      if (!latestAdId && isValidMetaAdId(rawAttrId)) latestAdId = String(rawAttrId).trim();

      // Campaña
      if (!latestCampaign && (attr.utmCampaign || attr.campaign)) {
        latestCampaign = attr.utmCampaign || attr.campaign;
      }

      // Medium
      if (!latestMedium && attr.utmMedium) {
        latestMedium = attr.utmMedium;
      }

 // Detección de Nombre de Conjunto de Anuncios (AdSet Name)
      // Meta Ads / GHL puede almacenar el AdSet en utmMedium, utmTerm, utmContent o adsetName
      if (!latestAdSetName) {
        if (isAdsetCandidate(attr.utmMedium)) {
          latestAdSetName = String(attr.utmMedium).trim();
        } else if (isAdsetCandidate(attr.utmTerm)) {
          latestAdSetName = String(attr.utmTerm).trim();
        } else if (isAdsetCandidate(attr.utmContent)) {
          latestAdSetName = String(attr.utmContent).trim();
        } else if (isAdsetCandidate(attr.adsetName || attr.adSetName)) {
          latestAdSetName = String(attr.adsetName || attr.adSetName).trim();
        }
      }
    }

    // Fallback de AdSet desde campos personalizados existentes si ya se guardó previamente
    if (!latestAdSetName) {
      const existingAdset = existingCustomFields.find(f => (f.id === ADSET_ID_FIELD || f.id === UTM_TERM_FIELD) && f.value)?.value;
      if (isAdsetCandidate(existingAdset)) {
        latestAdSetName = String(existingAdset).trim();
      }
    }

 // B. ANÁLISIS INTELIGENTE DE SÍNTOMAS (NLP + LEARNING BRAIN) Y DATOS DE ENVÍO
    const combinedText = allMessages.map(m => m.body || '').join(' \n ');
    const shippingData = extractShippingData(combinedText, contact.phone);
    const effectivePhone = contact.phone || (shippingData?.hasPhone ? shippingData.phone : null);

    let vtigerTreatment = null;
    let vContact = null;
    try {
      vContact = await findVTigerContact({ ...contact, phone: effectivePhone }, currentSedeName);
      if (vContact) {
 // SEDE-SHIELD: Bloqueo total de contacto de otra sede
        const vSede = (vContact.cf_3451 || '').toUpperCase().trim();
        const curSede = (currentSedeName || '').toUpperCase().trim();
        if (vSede && curSede && vSede !== curSede) {
          console.warn(`[Agente 3] [SEDE-SHIELD] Bloqueado match vTiger ${vContact.id} (Sede: ${vSede}) para subcuenta de ${curSede}. Contacto invalidado.`);
          vContact = null;
        }
      }
      if (vContact) {
        const vCond = vContact.cf_2610 || '';
        vtigerTreatment = inferTreatmentFromCampaignOrUtm(vCond) || (vCond.length > 2 ? vCond : null);
        if (vtigerTreatment) {
          console.log(`[Agente 3] [VTIGER] Ground Truth vTiger para ${contact.id}: [${vtigerTreatment}]`);
          // [ANTI-CONTAMINACION DEL CEREBRO]
          // ANTES se pasaba `chatText: combinedText` (el transcript CRUDO de toda
          // la conversación). Eso enseñó asociaciones como `your -> Potencia` a
          // partir de un SMS transaccional en inglés, y luego TODO texto en
          // inglés se clasificaba como Potencia (atribución falsa).
          // El Cerebro aprende del GROUND TRUTH verificable (padecimiento de
          // vTiger + campaña), NO de texto libre de chat.
          learningBrain.learnFromVtigerSale({
            treatment: vtigerTreatment,
            chatText: '',
            campaignName: latestCampaign
          });
        }
 // RECUPERACIÓN DE META AD ID REAL DESDE VTIGER (cf_2850)
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

    if (targetAdId && isValidMetaAdId(targetAdId)) {
      const metaDetails = await getMetaAdDetails(targetAdId, {
        sede: currentSedeName,
        pageId: targetPageId,
        locationId: activeLocationId
      });
      if (metaDetails) {
        latestCampaign = metaDetails.campaignName || latestCampaign;
        targetAdName = metaDetails.adName || metaDetails.creativeTitle;
        if (metaDetails.adsetName) {
          latestAdSetName = metaDetails.adsetName;
        }
        console.log(`[Agente 3] [META] UTMs Actualizados en vivo desde Meta: Campaña [${latestCampaign}], AdSet [${latestAdSetName}], Ad [${targetAdName}]`);
      }
    }

    const nlpAnalysis = analyzeSymptoms(combinedText, latestCampaign, latestMedium);

 // REGLA DE ORO CON OJOS Y CRÍTICA OPERATIVA:
    // 1. Prioridad Máxima: Dolencia explícita en el Nombre de Conjunto de Anuncios (AdSet / UTM Term)
    //    (ej: "TESTOSTERONA - ERNESTO - 2pm a 9pm - 1175" -> Potencia). ¡Es el anuncio exacto que cliquió hoy!
    // 2. Prioridad Fanpage Ultra: "BioNatural - Ultra" es la marca exclusiva de Potencia de Click2Ring.
    // 3. Prioridad Chat / NLP: Síntomas o palabras clave en el chat de hoy (ej: "MUESTRA GRATIS POTENCIA", "pajarito").
    // 4. Prioridad Otros UTMs: Creativo, medium, campaña.
    // 5. Fallback CRM vTiger: La dolencia histórica de vTiger (ej: Artritis en 2021) SOLO se usa como último recurso
    //    si NO hay AdSet, NO es página Ultra, NO hay síntomas de hoy y NO hay pauta activa.
    const adsetInferredTreatment = inferTreatmentFromCampaignOrUtm(latestAdSetName);
    const isUltraPage = targetPageId === '111906554968800' || (targetPageName || '').toLowerCase().includes('ultra');

    const utmInferredTreatment = inferTreatmentFromCampaignOrUtm(targetAdName) ||
                                  inferTreatmentFromCampaignOrUtm(latestMedium) ||
                                  inferTreatmentFromCampaignOrUtm(latestCampaign) ||
                                  inferTreatmentFromCampaignOrUtm(attrReciente?.campaign) ||
                                  inferTreatmentFromCampaignOrUtm(attrReciente?.utmContent);

    let targetTratamiento = adsetInferredTreatment;
    if (!targetTratamiento && isUltraPage) {
      targetTratamiento = 'Potencia';
    }
    if (!targetTratamiento) {
      targetTratamiento = nlpAnalysis.primaryTreatment;
    }
    if (!targetTratamiento) {
      targetTratamiento = utmInferredTreatment || vtigerTreatment || currentTratamiento;
    }

    // Detección de pauta pagada (usada tanto en triage como en resolución de proveedor)
    const checkIsPaidAd = (adId) => Boolean(
      (adId && isValidMetaAdId(adId)) ||
      latestAdSetName ||
      attrReciente?.sessionSource === 'Paid Social' ||
      attrReciente?.utmMedium === 'cpc' ||
      attrReciente?.utmMedium === 'paid' ||
      latestMedium === 'cpc' ||
      latestMedium === 'paid'
    );
    let isPaidAd = checkIsPaidAd(targetAdId);

    // [TRIAGE - SIN CLASIFICAR]
    // REGLA DE NEGOCIO: si el lead entra SIN Ad ID y SIN palabras clave de
    // dolencia identificables, NO se le atribuye producto ni proveedor. Antes
    // caía en 'General' y ese valor se usaba igual para armar el origen,
    // atribuyendo métricas falsas a proveedores de pauta.
    if (!targetTratamiento) {
      const sinEvidenciaDePauta = !isPaidAd && !targetAdId;
      targetTratamiento = UNKNOWN_TREATMENT;
      if (sinEvidenciaDePauta) {
        console.log(`[Agente 3] [TRIAGE] Lead sin Ad ID y sin dolencia identificable. Clasificado como ${UNKNOWN_TREATMENT} (sin atribución de producto).`);
      }
    }
    // Normalización final al vocabulario canónico (incluye el estado de triage).
    targetTratamiento = normalizeTreatmentOrUnknown(targetTratamiento);
    let targetVtigerNota = currentVtigerNota || null;
    let duplicateCount = 1;

 // E. Penalización Automática de Falsos Positivos en el Cerebro:
    if ((contact.tags || []).includes('producto-artritis') && targetTratamiento !== 'Artritis') {
      learningBrain.penalizeAssociation({
        phrase: combinedText.slice(0, 100),
        incorrectTreatment: 'Artritis',
        correctTreatment: targetTratamiento
      });
    }

 // C. FUZZY MATCHING FORENSE (Deduplicación Contextual de Historial)
    const fullName = `${contact.firstName || ''} ${contact.lastName || ''}`.trim();
    if ((!targetVtigerNota || !targetAdId || !targetTratamiento) && fullName.length >= 3) {
      try {
        const searchRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/?locationId=${activeLocationId}&query=${encodeURIComponent(fullName)}`, { headers: activeHeaders }, 1, isLive);
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

 // D. PREPARACIÓN DE FUENTE ESTILO VTIGER: [SEDE]-[PROVEEDOR]-[CANAL]-[TRATAMIENTO]
    // Actualizar estado de pauta tras el fuzzy matching
    isPaidAd = checkIsPaidAd(targetAdId);

    const targetProvider = resolveLeadProvider({
      pageId: targetPageId,
      // [ATRIBUCION LIMPIA] Si no hay evidencia real de fanpage, NO se pasa el
      // nombre fabricado: así el proveedor sale por la vía legítima (pauta
      // explícita o IN_HOUSE) y nunca por una página inventada.
      pageName: hasRealFanpage ? targetPageName : '',
      campaignName: latestCampaign,
      adsetName: latestAdSetName,
      adName: targetAdName,
      isPaidAd,
      existingSource: contact.source
    });

 // [AFINAMIENTO POR PROVEEDOR — SOLO SI LA PAGINA NO FUE CONFIRMADA]
    // DEFECTO CORREGIDO (confirmado por auditoria de ruteo): esta afinacion
    // SOBREESCRIBIA la asignacion correcta por pagina. Un lead de la fanpage de
    // ERNESTO cuyo anuncio/campaña menciona "CLICK2RING" (o CESAR/PIKALEX)
    // terminaba asignado a CLICK2RING: ~50% de Palacios y Benavides mal delegados.
    //
    // La PAGINA es la fuente AUTORITATIVA. El proveedor solo afina cuando NO hay
    // fanpage confirmada (routingReviewReason != null, p.ej. SMS/formulario sin
    // pagina o pagina no mapeada).
    if (routingReviewReason && resolvedSede && resolvedSede.users) {
      if (resolvedSede.sedeId === 'PALACIOS') {
        if (targetProvider === 'CLICK2RING') {
          targetAdvisorId = resolvedSede.users.ultra.id;
          targetAdvisorName = resolvedSede.users.ultra.name;
        } else {
          targetAdvisorId = resolvedSede.users.ernesto.id;
          targetAdvisorName = resolvedSede.users.ernesto.name;
        }
      } else if (resolvedSede.sedeId === 'BENAVIDES') {
        if (targetProvider === 'CLICK2RING') {
          targetAdvisorId = resolvedSede.users.redes2.id;
          targetAdvisorName = resolvedSede.users.redes2.name;
        } else {
          targetAdvisorId = resolvedSede.users.redes1.id;
          targetAdvisorName = resolvedSede.users.redes1.name;
        }
      }
    }

    // [CANAL REAL] Se resuelve desde el transporte del evento, no por defecto.
    // ANTES: resolveLeadChannel() devolvía 'FB-MSGR' siempre, así que un SMS de
    // Twilio se etiquetaba como Messenger y contaminaba la atribución.
    const targetChannel = resolveChannelFromEvent({
      type: latestMessageTransport,
      source: attrReciente?.sessionSource || '',
      campaignName: latestCampaign || targetAdName,
      hasMetaPage: hasRealFanpage
    });

    const vtigerSource = buildVtigerSource({
      sedeName: targetPageName,
      campaignName: latestCampaign || targetAdName,
      pageId: targetPageId,
      provider: targetProvider,
      channel: targetChannel,
      treatment: targetTratamiento || 'General'
    });

 // E. ETIQUETADO INTELIGENTE Y MULTI-CONDICIÓN
    const tagsToRemove = [];
    const newTagsSet = new Set((contact.tags || []).map(t => String(t).trim()));
    newTagsSet.add('facebook-messenger');

    if (isPaidAd) {
      newTagsSet.add('meta-ads');
      newTagsSet.delete('organico');
    } else {
      newTagsSet.add('organico');
      // Si entra puramente orgánico sin historial previo de pauta, purgar meta-ads erróneo
      if (!currentAdId && !targetAdId) {
        newTagsSet.delete('meta-ads');
        if ((contact.tags || []).includes('meta-ads')) {
          tagsToRemove.push('meta-ads');
        }
      }
    }

    if (targetPageName) {
      const pageSlug = targetPageName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      newTagsSet.add(pageSlug);
    }

    // 1. Definir la ÚNICA etiqueta de producto permitida (El Tratamiento Principal)
    // [VOCABULARIO CANÓNICO] La lista incluye la etiqueta legada
    // `producto-tetosterona`, que aún existe en contactos reales: así la limpieza
    // quirúrgica la purga en cuanto se detecta el tratamiento canónico Potencia.
    const activeProductTag = toProductTag(targetTratamiento);
    
    // 2. Solo añadimos LA etiqueta principal, ignorando detecciones secundarias de NLP para evitar que se disparen múltiples bots
    if (activeProductTag) {
      newTagsSet.add(activeProductTag);
    }

 // 3. Limpieza Quirúrgica ESTRICTA de etiquetas huérfanas
    if (activeProductTag) {
      for (const pTag of PRODUCT_TAGS) {
        if (pTag !== activeProductTag) {
          newTagsSet.delete(pTag);
          // Si el contacto ya tenía esta etiqueta falsa/antigua en GHL, la preparamos para el borrado forzoso
          if ((contact.tags || []).includes(pTag)) {
            tagsToRemove.push(pTag);
          }
        }
      }
    }

 // RE-EVALUAR SEDE SI EL NOMBRE DE CAMPAÑA TRAE DIRECTIVA EXPLÍCITA (MÁXIMA PRIORIDAD):
    if (latestCampaign || targetAdName) {
      const campSede = resolveLeadSede({
        pageId: targetPageId,
        pageName: targetPageName,
        campaignName: latestCampaign || targetAdName
      });
      if (campSede) currentSedeName = campSede;
    }

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

 // ARQUITECTURA MULTI-TENANT: Cada subcuenta en GHL es su propia sede soberana e independiente.
    // La mudanza de sede entre subcuentas ya no existe. Cada contacto pertenece a la sede de su subcuenta.
    const isMudanzaDeSede = false;
    newTagsSet.add(`sede-${currentSedeName.toLowerCase()}`);

    // [AUDITORIA DE RUTEO] Si la asignacion no se pudo confirmar con evidencia de
    // Meta, se marca el contacto para revision humana. Es el "ojo" permanente sobre
    // las delegaciones que antes ocurrian en silencio.
    if (routingReviewReason) {
      newTagsSet.add('revisar-ruteo');
      recordAuditEvent({
        type: 'ROUTING_REVIEW_FLAGGED',
        severity: 'warn',
        sede: currentSedeName,
        contactoId: contact.id,
        pageId: targetPageId,
        pageName: targetPageName,
        asesorAsignado: targetAdvisorName,
        motivo: routingReviewReason
      });
      console.warn(`[Agente 3] [RUTEO-REVISAR] ${contact.id}: ${routingReviewReason} -> asignado a ${targetAdvisorName}`);
    } else if (newTagsSet.has('revisar-ruteo') && hasRealFanpage) {
      // El ruteo quedo confirmado: se retira la marca de revision previa.
      newTagsSet.delete('revisar-ruteo');
      tagsToRemove.push('revisar-ruteo');
    }

 // Purga forzosa de etiquetas obsoletas de mudanza que hayan quedado de sincronizaciones previas
    const MUDANZA_OBSOLETE_TAGS = ['mudanza-desde-palacios', 'mudanza-desde-benavides', 'mudanza-de-sede', 'mudanza-gracia-expirada'];
    for (const mTag of MUDANZA_OBSOLETE_TAGS) {
      if (newTagsSet.has(mTag)) {
        newTagsSet.delete(mTag);
        tagsToRemove.push(mTag);
      }
    }

    // Alerta de Lead Caliente (Teléfono o Dirección)
    if (shippingData.isHotLead) {
      newTagsSet.add('lead-caliente');
    }

    if (duplicateCount > 1) {
      newTagsSet.add('alerta-duplicado-clic');
      newTagsSet.add(`pauta-clic-x${duplicateCount}`);
    }

    // ALERTA: Doble Ingreso Publicitario (Detección Avanzada CPM)
    let isDoubleAdEntry = false;

    const KNOWN_TRIGGER_KEYWORDS = [
      'muestra gratis', 'azucar alta', 'hormigueo', 'diabetes', 'glucosa', 'potencia', 'dolor intenso', 'prostata', 'colageno', 'mala circulacion', 'vision borrosa'
    ];
    const newestInboundMsg = allMessages.find(m => m.direction === 'inbound');
    const hasTriggerKeyword = Boolean(newestInboundMsg && KNOWN_TRIGGER_KEYWORDS.some(kw => (newestInboundMsg.body || '').toLowerCase().includes(kw)));

    let hoursSinceFirstTouch = 0;
    if (contact.dateAdded && newestInboundMsg?.dateAdded) {
      hoursSinceFirstTouch = (new Date(newestInboundMsg.dateAdded).getTime() - new Date(contact.dateAdded).getTime()) / (1000 * 60 * 60);
    }

    // Regla 1: Entró por un Ad diferente al que tenía registrado.
    if (latestAdId && currentAdId && latestAdId !== currentAdId) {
      isDoubleAdEntry = true;
    } 
    // Regla 2: Lead de pauta que vuelve a interactuar con un gatillo publicitario ("MUESTRA GRATIS...", etc.) tras más de 20 horas
    else if ((latestAdId || currentAdId || isPaidAd) && hoursSinceFirstTouch >= 20 && hasTriggerKeyword) {
      isDoubleAdEntry = true;
    }
    // Regla 3: Entró por el MISMO Ad, pero pasaron más de 20 horas (Nuevo cobro de Meta)
    else if (latestAdId && latestAdId === currentAdId) {
      const adClicks = fbMessages.filter(m => m.adId === latestAdId);
      if (adClicks.length >= 2) {
        const timeDiffHours = (adClicks[0].timestamp - adClicks[adClicks.length - 1].timestamp) / (1000 * 60 * 60);
        if (timeDiffHours >= 20) {
          isDoubleAdEntry = true;
        }
      } else if (hoursSinceFirstTouch >= 20) {
        isDoubleAdEntry = true;
      }
    }

    if (isDoubleAdEntry) {
      newTagsSet.add('doble-ingreso-publicitario');
      newTagsSet.add('alerta-reingreso-pauta');
    }

 // F. PREPARAR CUSTOM FIELDS (FULL DATA STACK)
    const customFieldsToUpdate = [];
    if (targetAdId && isValidMetaAdId(targetAdId)) {
      customFieldsToUpdate.push({ id: ID_ANUNCIO_FIELD, key: 'contact.id_de_anuncio', field_value: String(targetAdId) });
      customFieldsToUpdate.push({ id: AD_ID_ALT_FIELD, key: 'contact.ad_id', field_value: String(targetAdId) });
    } else if (rawCurrentAdId && !isValidMetaAdId(rawCurrentAdId)) {
 // PURGA QUIRÚRGICA: Si el contacto tenía una cadena de origen (ej: PALACIOS-...) en el Ad ID, limpiarlo
      console.log(`[Agente 3] [PURGE] Limpiando Ad ID invalido ("${rawCurrentAdId}") para ${contactId}`);
      customFieldsToUpdate.push({ id: ID_ANUNCIO_FIELD, key: 'contact.id_de_anuncio', field_value: '' });
      customFieldsToUpdate.push({ id: AD_ID_ALT_FIELD, key: 'contact.ad_id', field_value: '' });
    }
    if (targetTratamiento && targetTratamiento !== 'General') {
      customFieldsToUpdate.push({ id: TRATAMIENTO_FIELD, key: 'contact.tratamiento_comprado', field_value: targetTratamiento });
    }
    if (targetVtigerNota) customFieldsToUpdate.push({ id: VTIGER_NOTAS_FIELD, key: 'contact.vtiger_historial_completo', field_value: targetVtigerNota });
    
    // UTMs & Tarjeta de Contacto Completa (Sede, Origen, UTMs, Teléfono, Interacción)
    if (UTM_SOURCE_FIELD) customFieldsToUpdate.push({ id: UTM_SOURCE_FIELD, key: 'contact.utm_source', field_value: 'facebook' });
    if (UTM_MEDIUM_FIELD) customFieldsToUpdate.push({ id: UTM_MEDIUM_FIELD, key: 'contact.utm_medium', field_value: isPaidAd ? 'cpc' : 'messenger' });
    if (UTM_CAMPAIGN_FIELD && latestCampaign) customFieldsToUpdate.push({ id: UTM_CAMPAIGN_FIELD, key: 'contact.utm_campaign', field_value: latestCampaign });
    if (UTM_CONTENT_FIELD) customFieldsToUpdate.push({ id: UTM_CONTENT_FIELD, key: 'contact.utm_content', field_value: targetAdName || targetTratamiento || 'Anuncio' });
    if (UTM_TERM_FIELD && latestAdSetName) customFieldsToUpdate.push({ id: UTM_TERM_FIELD, key: 'contact.utm_term', field_value: latestAdSetName });
    if (ADSET_ID_FIELD && latestAdSetName) customFieldsToUpdate.push({ id: ADSET_ID_FIELD, key: 'contact.adset_id', field_value: latestAdSetName });
    // [ATRIBUCION VISIBLE] Espejo de los UTM en campos con nombre claro para la tarjeta.
    if (NOMBRE_ANUNCIO_FIELD && targetAdName) customFieldsToUpdate.push({ id: NOMBRE_ANUNCIO_FIELD, key: 'contact.nombre_anuncio', field_value: targetAdName });
    if (CAMPANA_META_FIELD && latestCampaign) customFieldsToUpdate.push({ id: CAMPANA_META_FIELD, key: 'contact.campana_meta', field_value: latestCampaign });
    if (CONJUNTO_ANUNCIOS_FIELD && latestAdSetName) customFieldsToUpdate.push({ id: CONJUNTO_ANUNCIOS_FIELD, key: 'contact.conjunto_anuncios', field_value: latestAdSetName });
    if (SEDE_ASIGNADA_FIELD) customFieldsToUpdate.push({ id: SEDE_ASIGNADA_FIELD, key: 'contact.sede_asignada', field_value: currentSedeName });
    if (ORIGEN_LEAD_FIELD && vtigerSource) customFieldsToUpdate.push({ id: ORIGEN_LEAD_FIELD, key: 'contact.origen_lead', field_value: vtigerSource });
    if (TIENE_TELEFONO_FIELD) customFieldsToUpdate.push({ id: TIENE_TELEFONO_FIELD, key: 'contact.tiene_telfono', field_value: (contact.phone || (shippingData && shippingData.hasPhone)) ? 'Sí' : 'No' });
    if (ULTIMA_INTERACCION_FIELD) customFieldsToUpdate.push({ id: ULTIMA_INTERACCION_FIELD, key: 'contact.ultima_interaccion', field_value: new Date().toISOString().split('T')[0] });

 // G. SINCRONIZACIÓN COMERCIAL CON VTIGER Y PURGA DE COMPRAS FALSAS (EN VIVO - DOMINIO AISLADO)
    let finalCustomerWon = isCustomerWon;
    let finalMonetaryValue = 0;
    try {
      // [SEDE-SHIELD] El veredicto comercial hereda la sede activa del enrutamiento:
      // una sola puerta de aislamiento para veredicto y saneado de campos.
      const truth = evaluateCommercialTruth(contact, vContact, activeContext?.sedeId || '');
      finalCustomerWon = truth.isWon;
      finalMonetaryValue = truth.totalSpent;
      const sanitizedCommercialFields = buildSanitizedCommercialFields(contact, vContact, activeLocationId);
      customFieldsToUpdate.push(...sanitizedCommercialFields);
    } catch (commErr) {
      console.warn(`[Agente 3] [WARN] No se pudo evaluar estado comercial en vivo para ${contactId}:`, commErr.message);
    }

 // INYECCIÓN DE ETIQUETAS ACCIONABLES (TELÉFONO & ESTADO COMERCIAL)
    const hasPhone = Boolean(contact.phone || (shippingData && shippingData.hasPhone));
    if (hasPhone) {
      newTagsSet.add('con-telefono');
      newTagsSet.delete('sin-telefono');
      if ((contact.tags || []).includes('sin-telefono')) tagsToRemove.push('sin-telefono');
    } else {
      newTagsSet.add('sin-telefono');
      newTagsSet.delete('con-telefono');
      if ((contact.tags || []).includes('con-telefono')) tagsToRemove.push('con-telefono');
    }

    if (finalCustomerWon) {
      newTagsSet.add('compro');
      newTagsSet.delete('no-compro');
      if ((contact.tags || []).includes('no-compro')) tagsToRemove.push('no-compro');
    } else {
      newTagsSet.add('no-compro');
      newTagsSet.delete('compro');
      if ((contact.tags || []).includes('compro')) tagsToRemove.push('compro');
    }

 // INYECCIÓN FLUIDA DE ETIQUETAS VTIGER EN VIVO
    if (vContact || targetVtigerNota) {
      newTagsSet.add('vtiger');
      newTagsSet.add('vtiger-sincronizado');
      if (finalCustomerWon) {
        newTagsSet.add('cliente-vtiger');
        newTagsSet.delete('prospecto-vtiger');
        if ((contact.tags || []).includes('prospecto-vtiger')) tagsToRemove.push('prospecto-vtiger');
      } else {
        newTagsSet.add('prospecto-vtiger');
        newTagsSet.delete('cliente-vtiger');
        if ((contact.tags || []).includes('cliente-vtiger')) tagsToRemove.push('cliente-vtiger');
      }
      if (vContact?.cf_994) {
        const vStClean = String(vContact.cf_994).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (vStClean) newTagsSet.add(`vtiger-status-${vStClean}`);
      }
      if (vContact?.cf_3507) {
        const vCanalClean = String(vContact.cf_3507).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (vCanalClean) newTagsSet.add(`canal-${vCanalClean}`);
      }
    }

    // SINCRONIZACION DE PIPELINE (Orquestacion LOA)
    try {
      const cleanSede = (targetPageName?.toLowerCase().includes('bionatural') || targetPageName?.toLowerCase().includes('palacios')) 
        ? 'PALACIOS' 
        : (targetPageName ? targetPageName.replace(/Naturales\s*/i, '').trim().toUpperCase() : 'SEDE');
      const campaignSnippet = (latestCampaign || targetAdName || 'Directa').substring(0, 32);
      const prodPrefix = targetTratamiento && targetTratamiento !== 'General' ? `[${targetTratamiento.toUpperCase()}] ` : '';
      const cardTitle = `${prodPrefix}${fullName} | ${cleanSede} | ${campaignSnippet}`;
      await syncUnifiedPipelineOpportunity(contactId, cardTitle, finalCustomerWon, true, finalMonetaryValue, targetAdvisorId, { locationId: activeLocationId, headers: activeHeaders });
    } catch (oppErr) {
      console.error(`[Agente 3] Error sincronizando pipeline para ${contactId}:`, oppErr.message);
    }

 // G. CONSTRUIR PAYLOAD ATÓMICO (1 SOLO PUT)
    const updatePayload = {
      source: vtigerSource,        // Fuente de contacto estilo vTiger
      tags: Array.from(newTagsSet),
      customFields: customFieldsToUpdate
    };

    // [ASIGNACIÓN POR SEDE ACTUAL — SUBCUENTAS SEPARADAS]
    // El dueño se asigna SIEMPRE según la página por la que escribió (regla estricta
    // de ruteo). El antiguo "Escudo de Propietario" (no robar clientes cerrados) era
    // para cuando TODAS las sedes vivían en UNA subcuenta; con subcuentas separadas
    // cada sede es soberana y no hay conflicto de posesión.
    //
    // Aislamiento de datos de compra: si un cliente que compró en PALACIOS escribe a
    // la página de BENAVIDES, el SEDE-LOCK (cf_3451 = sede) hace que `findVTigerContact`
    // NO lo encuentre en Benavides: conversa normal, pero sus datos de compra NO se
    // filtran a Benavides. La compra queda SOLO en la subcuenta de la sede donde compró.
    updatePayload.assignedTo = targetAdvisorId;

 // INYECCIÓN AUTOMÁTICA DE "GENERAL INFO" (ESTRICTO USA)
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

 // Filtro Silencioso: Comprobar si realmente hay cambios antes de hacer PUT
    const isSameAdvisor = contact.assignedTo === targetAdvisorId;
    const isSameSource = contact.source === vtigerSource;
    const currentTags = (contact.tags || []).map(t => String(t).trim());
    const tagsChanged = newTagsSet.size !== currentTags.length || Array.from(newTagsSet).some(t => !currentTags.includes(t));
    const currentCFs = contact.customFields || [];

 // EJECUTAR PURGA DE ETIQUETAS FALSAS EN GHL (API V2)
    if (tagsToRemove.length > 0) {
      console.log(`[Agente 3] [CLEANUP] Purgando etiquetas huérfanas de ${contactId}: ${tagsToRemove.join(', ')}`);
      await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
        method: 'DELETE',
        headers: activeHeaders,
        body: JSON.stringify({ tags: tagsToRemove })
      }, 1, isLive);
    }

    const CRITICAL_CF_IDS = [
      ...Object.values(sedeFields),
      // Palacios (Legacy Fallback)
      '8EQtKkiW7Z022bcN0vhS', '5TY5AIOpu1c8f6WosyF2', 'RLxFOTXkICXLWShjaLaB',
      'GZKRu2z1Z156lRUfyrpo', '5js0Lfbh5XDLq87SDgdT', 'jfaxRCXTLZQCuzsTl49v',
      '7SgOMq4Aeti7gN1SqVN6', 'cN6NrhXqMlEhyp35g7bs', 'Wh4IIv4TEbxJaZBi95cp',
      'XTGicfQtDwBrlr2qPKxF', 'Yd0Ix40PYOcZQn6TokaX'
    ].filter(Boolean);
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
    const hasChanges = !isSameAdvisor || !isSameSource || tagsChanged || hasCFChanges || hasPhoneUpdate || hasGeoUpdate || isDoubleAdEntry;

    if (!hasChanges) {
      console.log(`[Agente 3] [SYNC] Contacto ${contactId} ya está 100% sincronizado. Omitiendo PUT para evitar parpadeos en pantalla.`);
      return 'UNCHANGED';
    }

 // Limpieza final del payload para evitar 400 Bad Request por strings vacíos
    for (const key of Object.keys(updatePayload)) {
      if (updatePayload[key] === '') {
        delete updatePayload[key];
      }
    }

    if (isDryRun) {
      console.log(`[Agente 3] [DRY-RUN] Simulacion completada para ${contactId}. Cambios que se habrian inyectado:`);
      console.log(JSON.stringify(updatePayload, null, 2));
      return;
    }

    const updateRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: activeHeaders,
      body: JSON.stringify(updatePayload)
    }, 1, isLive);

    if (updateRes.status === 200) {
      if (global.pushLiveLog) {
        global.pushLiveLog(`[ROUTING] Agente 3: ${contact.name || 'Lead'} -> ${targetAdvisorName} | Src: ${vtigerSource}`);
      }
      console.log(`[Agente 3] [SUCCESS] ${contact.firstName || ''} ${contact.lastName || ''} (${contactId}) | Ad ID: ${targetAdId || 'N/A'} | Fuente: ${vtigerSource} | Estado: ${updatePayload.state || contact.state || '--'} | Actualizado OK.`);

 // H. SAVE PROCESS: INYECTAR NOTA HISTÓRICA ANTE NUEVO AD, CAMBIO DE TRATAMIENTO O REINGRESO DE PAUTA (>20H)
      const adChanged = Boolean(
        (latestAdId && currentAdId && latestAdId !== currentAdId) ||
        (latestAdId && !currentAdId)
      );
      const treatmentChanged = Boolean(targetTratamiento && targetTratamiento !== currentTratamiento);
      const shouldSaveNote = adChanged || treatmentChanged || isDoubleAdEntry;

      if (shouldSaveNote) {
        let prevAdDateStr = null;
        let prevAdTimestamp = 0;
        if (currentAdId && fbMessages.length > 0) {
          const prevAdMsg = fbMessages.find(m => m.adId === currentAdId);
          if (prevAdMsg && prevAdMsg.timestamp) {
            prevAdTimestamp = prevAdMsg.timestamp;
            prevAdDateStr = new Date(prevAdMsg.timestamp).toLocaleDateString('es-PE', { timeZone: 'America/New_York' });
          }
        }
        if (!prevAdDateStr && contact.dateAdded) {
          prevAdTimestamp = new Date(contact.dateAdded).getTime();
          prevAdDateStr = new Date(contact.dateAdded).toLocaleDateString('es-PE', { timeZone: 'America/New_York' });
        }

        const nowMs = newestMsg?.timestamp || Date.now();
        const diffHours = prevAdTimestamp > 0 ? (nowMs - prevAdTimestamp) / (1000 * 60 * 60) : 999;
        const graceThreshold = isCustomerWon ? 30 * 24 : 96; // 30 días si es cliente con venta, 4 días si es prospecto
        const isGraceExpiredCalc = Boolean(
          expiredGraceMsg || 
          isMudanzaDeSede || 
          diffHours > graceThreshold
        );

        const prevCampaignVal = existingCustomFields.find(f => f.id === UTM_CAMPAIGN_FIELD && f.value)?.value ||
                                contact.attributionSource?.utmCampaign ||
                                previousSource ||
                                '';
        const prevTreatmentVal = currentTratamiento || 
                                 (vContact?.cf_2610 ? inferTreatmentFromCampaignOrUtm(vContact.cf_2610) || vContact.cf_2610 : null) ||
                                 'General';

        await saveAdHistoryNote(contactId, {
          newAdId: latestAdId || currentAdId || targetAdId,
          oldAdId: currentAdId || 'Ninguna previa (Orgánico)',
          oldAdDate: prevAdDateStr,
          previousSede: previousSede || currentSedeName || 'PALACIOS',
          previousCampaign: prevCampaignVal,
          previousTreatment: prevTreatmentVal,
          campaign: latestCampaign || 'Pauta Reciente',
          pageName: targetPageName,
          clickCount: duplicateCount,
          source: vtigerSource,
          treatment: targetTratamiento,
          isDoubleAdEntry,
          isGraceExpired: isGraceExpiredCalc,
          isMudanzaDeSede: false
        }, { locationId: activeLocationId, headers: activeHeaders });
      }
      return 'SUCCESS';
    } else {
      const errText = await updateRes.text();
      const isDuplicateConflict = updateRes.status === 400 && errText.includes('duplicated contacts') && errText.includes('matchingField');
      const isUserNotExist = updateRes.status === 400 && (
        errText.includes('does not exist in this location') ||
        errText.includes('User') ||
        errText.includes('assignedTo')
      );

 // AUTO-HEALING: Asesor no existe en esta ubicación (Reintentar sin assignedTo)
      if (isUserNotExist) {
        console.warn(`[Agente 3] [AUTO-HEAL] Asesor no válido para ubicación (${activeLocationId}). Reintentando actualización atómica sin assignedTo para ${contactId}...`);
        delete updatePayload.assignedTo;
        const retryUserRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
          method: 'PUT',
          headers: activeHeaders,
          body: JSON.stringify(updatePayload)
        }, 1, isLive);
        if (retryUserRes.status === 200) {
          console.log(`[Agente 3] [SUCCESS] [AUTO-HEAL] Contacto ${contactId} actualizado exitosamente sin assignedTo.`);
          return 'SUCCESS';
        }
      }

 // AUTO-HEALING: Conflicto de Contacto Duplicado (Phone/Email)
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
              headers: activeHeaders,
              body: JSON.stringify(updatePayload)
            }, 1, isLive);
            
            if (retryRes.status === 200) {
               console.log(`[Agente 3] [SUCCESS] [AUTO-HEAL] Contacto ${contactId} actualizado exitosamente tras esquivar conflicto de duplicado.`);
               
               if (rescateValor && isLive) {
                 try {
                   const notaText = `[AVISO] NÚMERO RESCATADO DE VTIGER: ${rescateValor}\n(GHL bloqueó la inserción automática porque este número ya le pertenece a otro contacto/familiar en esta ubicación. Usa este número para llamar.)`;
                   await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
                     method: 'POST',
                     headers: activeHeaders,
                     body: JSON.stringify({ body: notaText, userId: updatePayload.assignedTo || null })
                   }, 1, true);
                   console.log(`[Agente 3] [NOTE] Nota de Rescate insertada exitosamente en GHL para ${contactId}.`);
                 } catch (noteErr) {
                   console.log(`[Agente 3] [WARN] No se pudo insertar la nota de rescate: ${noteErr.message}`);
                 }
               }
               return 'SUCCESS';
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

 // AUTO-HEALING: Errores de servidor GHL (500/502/503)
      // Marcar el contacto para re-proceso en el siguiente ciclo del Radar
      if (updateRes.status >= 500) {
        console.warn(`[Agente 3] [WARN] GHL devolvió ${updateRes.status} para ${contactId}. Marcando para re-proceso en el siguiente ciclo.`);
        return 'RETRY';
      }
    }

  } catch (error) {
    console.error(`[Agente 3] Error crítico en routeChatByContact:`, error.message);
    return 'ERROR';
  } finally {
    registrarCostoRuteo(contactId);
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
    const targetPalaciosLoc = SEDES_GATEWAY.PALACIOS.ghl.locationId;
    const targetPalaciosHeaders = getGhlHeaders({ locationId: targetPalaciosLoc });
    const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${targetPalaciosLoc}&limit=20`;
    const res = await fetchWithRetry(convUrl, { headers: targetPalaciosHeaders });
    
    if (res.status !== 200) return;
    
    const data = await res.json();
    const conversations = data.conversations || [];
    
    for (const conv of conversations) {
      if (!conv.contactId) continue;
      const lastProc = processedTimestamps.get(conv.contactId) || 0;
      if (Date.now() - lastProc > 60000) { // 60 segundos de debounce por contacto
        processedTimestamps.set(conv.contactId, Date.now());
        routeChatByContact(conv.contactId, false, false, { locationId: targetPalaciosLoc, headers: targetPalaciosHeaders }).catch(err => console.error(err));
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
  const targetPalaciosLoc = SEDES_GATEWAY.PALACIOS.ghl.locationId;
  const targetPalaciosHeaders = getGhlHeaders({ locationId: targetPalaciosLoc });
  for (const [, advisor] of Object.entries(PALACIOS_USERS)) {
    try {
      const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${targetPalaciosLoc}&assignedTo=${advisor.id}&limit=20`;
      const res = await fetchWithRetry(convUrl, { headers: targetPalaciosHeaders });
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
