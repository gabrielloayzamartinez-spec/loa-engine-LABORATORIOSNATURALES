/**
 * ==============================================================================
 * RESOLUTOR SISTEMÁTICO DEL AD ID — "el ID se extrae SIEMPRE, sin fallas"
 * ==============================================================================
 * PROBLEMA REPORTADO POR EL USUARIO
 * La extracción del ID del anuncio era INTERMITENTE: leads que en Meta Business
 * Suite tienen su ID aparecían en GHL como "orgánicos". Hacía falta que la
 * extracción fuera un PROCESO SISTEMÁTICO, claro y sin fallas.
 *
 * DEFECTOS ENCONTRADOS AL AUDITAR
 *   1. El Ad ID se leía DENTRO de `if (pageId)`. Si el mensaje traía el Ad ID
 *      pero NO el page id (caso típico de anuncios Click-to-WhatsApp, Instagram
 *      o de referidos que no exponen `fromPageId`), el ID se DESCARTABA por
 *      completo. Esa es la fuga principal.
 *   2. Solo se miraban 4 rutas fijas (`meta.fb.adId`, `meta.fb.ad_id`,
 *      `meta.referral.ad_id`, `meta.referral.adId`). Cualquier formato nuevo o
 *      canal distinto (WhatsApp, IG, `ads_context_data`) quedaba fuera.
 *   3. Las fuentes se consultaban repartidas por el código, sin un orden único
 *      ni registro de DE DÓNDE salió el dato.
 *
 * CÓMO FUNCIONA AHORA
 *   · BÚSQUEDA PROFUNDA: se recorre todo el árbol de metadata del mensaje y se
 *     acepta CUALQUIER clave equivalente a `ad_id` / `adId` (en cualquier nivel
 *     y en cualquier canal). Así se cubre Messenger, WhatsApp, Instagram y
 *     formatos futuros sin tocar código.
 *   · ORDEN ÚNICO Y EXPLÍCITO de las fuentes, con prioridad a la interacción
 *     MÁS RECIENTE:
 *         1. el referral del mensaje más nuevo        (lo que el lead clicó ahora)
 *         2. la atribución más reciente de GHL        (lastAttributionSource)
 *         3. el historial de atribuciones de GHL      (attributions)
 *         4. la atribución de primer toque           (attributionSource)
 *         5. el Ad ID ya guardado en el contacto     (no se degrada)
 *         6. el Ad ID que vTiger tenga registrado    (cf_2850)
 *   · TRAZABILIDAD: siempre se devuelve `fuente` (de dónde salió) y `evidencia`
 *     (el valor crudo), para que una extracción se pueda auditar.
 * ==============================================================================
 */

import { isValidMetaAdId } from '../agents/nlp_symptom_engine.js';

/** Claves que Meta/GHL usan para el ID del anuncio, en cualquier canal. */
const CLAVES_AD_ID = new Set(['ad_id', 'adid', 'ad_id_', 'ads_id', 'adid_', 'ad_id_fb']);

/**
 * BÚSQUEDA PROFUNDA del Ad ID en un árbol de metadata.
 * Recorre el objeto completo aceptando cualquier clave equivalente a `ad_id`,
 * sin importar el canal ni la profundidad. Es la pieza que hace la extracción
 * sistemática: ya no depende de rutas fijas ni de que venga `pageId`.
 *
 * @param {any} obj
 * @param {number} [profundidad=0]
 * @returns {string|null}
 */
export function buscarAdIdProfundo(obj, profundidad = 0) {
  if (!obj || typeof obj !== 'object' || profundidad > 6) return null;

  // 1a pasada: claves directas del nivel actual (lo más probable primero).
  for (const [k, v] of Object.entries(obj)) {
    if (!v) continue;
    if (CLAVES_AD_ID.has(String(k).toLowerCase()) && isValidMetaAdId(v)) {
      return String(v).trim();
    }
  }

  // 2a pasada: descender. Se priorizan los contenedores habituales de Meta.
  const preferidos = ['referral', 'fb', 'facebook', 'whatsapp', 'instagram', 'ig', 'ads_context_data', 'meta', 'context'];
  for (const key of preferidos) {
    if (obj[key]) {
      const found = buscarAdIdProfundo(obj[key], profundidad + 1);
      if (found) return found;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = buscarAdIdProfundo(v, profundidad + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Extrae el Ad ID de UN mensaje, sin exigir page id. */
export function extraerAdIdDeMensaje(mensaje) {
  if (!mensaje) return null;
  // Rutas explícitas primero (las conocidas), y luego la búsqueda profunda.
  const explicitas = [
    mensaje?.meta?.fb?.adId,
    mensaje?.meta?.fb?.ad_id,
    mensaje?.meta?.referral?.ad_id,
    mensaje?.meta?.referral?.adId,
    mensaje?.meta?.referral?.ads_context_data?.ad_id,
    mensaje?.meta?.whatsapp?.referral?.ad_id,
    mensaje?.meta?.instagram?.referral?.ad_id,
    mensaje?.meta?.adId,
    mensaje?.meta?.ad_id,
    mensaje?.adId,
    mensaje?.ad_id
  ];
  for (const c of explicitas) {
    if (c && isValidMetaAdId(c)) return String(c).trim();
  }
  return buscarAdIdProfundo(mensaje.meta || mensaje);
}

/** Extrae el page id de Meta de un mensaje (independiente del Ad ID). */
export function extraerPageIdDeMensaje(mensaje) {
  if (!mensaje) return null;
  const cands = [
    mensaje?.meta?.fb?.fromPageId,
    mensaje?.meta?.fb?.pageId,
    mensaje?.meta?.pageId,
    mensaje?.meta?.referral?.source_id,
    mensaje?.meta?.whatsapp?.fromPageId,
    mensaje?.meta?.instagram?.fromPageId
  ];
  for (const c of cands) {
    if (c && String(c).trim() !== '') return String(c).trim();
  }
  return null;
}

/**
 * Recorre los mensajes (se esperan ordenados del MÁS NUEVO al más viejo) y
 * devuelve el Ad ID de la interacción publicitaria más reciente, junto con el
 * mensaje exacto del que salió. NO exige page id: si el Ad ID está, se toma.
 *
 * @param {Array} mensajes
 * @returns {{adId: string|null, fecha: string|null, mensajeId: string|null}}
 */
export function extraerAdIdDeMensajes(mensajes = []) {
  for (const m of mensajes) {
    const adId = extraerAdIdDeMensaje(m);
    if (adId) {
      return { adId, fecha: m?.dateAdded || null, mensajeId: m?.id || null };
    }
  }
  return { adId: null, fecha: null, mensajeId: null };
}

/** Extrae el Ad ID de un objeto de atribución de GHL. */
function adIdDeAtribucion(attr) {
  if (!attr) return null;
  for (const c of [attr.utmAdId, attr.adId, attr.ad_id, attr.utm_ad_id]) {
    if (c && isValidMetaAdId(c)) return String(c).trim();
  }
  return null;
}

/**
 * RESOLUCIÓN SISTEMÁTICA del Ad ID con orden explícito y trazabilidad.
 *
 * @param {object} opts
 * @param {Array}  [opts.mensajes]      mensajes (más nuevo primero)
 * @param {object} [opts.contacto]      contacto de GHL (para la atribución)
 * @param {string} [opts.adIdActual]    Ad ID ya guardado en el contacto
 * @param {string} [opts.adIdVtiger]    Ad ID registrado en vTiger (cf_2850)
 * @returns {{adId: string|null, fuente: string|null, evidencia: string|null}}
 */
export function resolverAdId({ mensajes = [], contacto = null, adIdActual = null, adIdVtiger = null } = {}) {
  // 1. Referral del mensaje más reciente (la interacción publicitaria actual).
  const deMensajes = extraerAdIdDeMensajes(mensajes);
  if (deMensajes.adId) {
    return { adId: deMensajes.adId, fuente: 'referral_mensaje', evidencia: `mensaje ${deMensajes.mensajeId || '?'} (${deMensajes.fecha || 'sin fecha'})` };
  }

  // 2. Atribución MÁS RECIENTE de GHL.
  const last = adIdDeAtribucion(contacto?.lastAttributionSource);
  if (last) return { adId: last, fuente: 'atribucion_ultima_ghl', evidencia: 'lastAttributionSource' };

  // 3. Historial de atribuciones (de la más reciente a la más antigua).
  if (Array.isArray(contacto?.attributions)) {
    for (const attr of [...contacto.attributions].reverse()) {
      const id = adIdDeAtribucion(attr);
      if (id) return { adId: id, fuente: 'atribucion_historial_ghl', evidencia: 'attributions[]' };
    }
  }

  // 4. Atribución de primer toque.
  const first = adIdDeAtribucion(contacto?.attributionSource);
  if (first) return { adId: first, fuente: 'atribucion_primer_toque_ghl', evidencia: 'attributionSource' };

  // 5. El Ad ID ya guardado en el contacto (nunca se degrada a vacío).
  if (adIdActual && isValidMetaAdId(adIdActual)) {
    return { adId: String(adIdActual).trim(), fuente: 'campo_previo_contacto', evidencia: 'ID de Anuncio existente' };
  }

  // 6. Lo que vTiger tenga registrado (cf_2850).
  if (adIdVtiger && isValidMetaAdId(adIdVtiger)) {
    return { adId: String(adIdVtiger).trim(), fuente: 'vtiger_cf_2850', evidencia: 'Ground Truth vTiger' };
  }

  return { adId: null, fuente: null, evidencia: null };
}
