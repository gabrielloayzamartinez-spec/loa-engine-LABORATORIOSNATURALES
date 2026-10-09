/**
 * ==============================================================================
 * DIAGNÓSTICO DE ATRIBUCIÓN DE UN CONTACTO — "¿por qué este lead quedó orgánico?"
 * ==============================================================================
 * PROBLEMA REPORTADO POR EL USUARIO
 * Un lead que SÍ vino de pauta aparece en GHL como "orgánico": en Meta Business
 * Suite el ID del anuncio existe, pero en GHL no está. Ocurre de forma
 * intermitente y hay que entender POR QUÉ en cada caso concreto.
 *
 * QUÉ HACE ESTE DIAGNÓSTICO
 * Toma UN contacto y muestra, en crudo, TODAS las fuentes de atribución que el
 * motor consulta, en el orden en que las consulta:
 *
 *   1. Campos del contacto en GHL  -> "ID de Anuncio", "Ad ID", "Campaña Meta",
 *      "Nombre del Anuncio", "Conjunto de Anuncios", "UTM *", "Origen Lead".
 *   2. Atribución de GHL           -> attributionSource / lastAttributionSource /
 *      attributions (adId, utmAdId, utmCampaign, sessionSource, medium...).
 *   3. Mensajes de TODAS las conversaciones -> el "referral" de Meta, que es
 *      donde viaja el `ad_id` cuando el lead hace clic en un anuncio y se abre
 *      Messenger/WhatsApp. Se muestran las CLAVES reales del metadata para ver si
 *      el referral viene por `meta.fb`, `meta.referral` o algún formato nuevo.
 *
 * Con eso se ve si el fallo es: (a) el referral no llegó, (b) llegó con otra
 * forma que no reconocemos, (c) GHL no lo guardó, o (d) el contacto nunca pasó
 * por el router.
 *
 * Es SOLO LECTURA: no modifica nada.
 * ==============================================================================
 */

import { ghlFetch } from '../utils/ghl_http_client.js';
import { SEDES_GATEWAY } from '../config/index.js';
import { obtenerMapaCamposGhl } from './ghl_fields_map.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Extrae los campos de atribución que nos interesan de un objeto de atribución. */
function resumirAtribucion(attr) {
  if (!attr) return null;
  return {
    adId: attr.adId || attr.utmAdId || null,
    utmAdId: attr.utmAdId || null,
    utmSource: attr.utmSource || null,
    utmMedium: attr.utmMedium || null,
    utmCampaign: attr.utmCampaign || null,
    utmContent: attr.utmContent || null,
    utmTerm: attr.utmTerm || null,
    campaign: attr.campaign || null,
    medium: attr.medium || null,
    sessionSource: attr.sessionSource || null,
    referrer: attr.referrer || null
  };
}

/**
 * Diagnostica la atribución de UN contacto.
 *
 * @param {object} opts
 * @param {string} opts.contactId  ID del contacto en GHL
 * @param {string} [opts.sede='PALACIOS']
 * @param {boolean} [opts.crudos=false] incluir las CLAVES crudas del metadata de cada mensaje
 */
export async function diagnosticarContacto({ contactId, sede = 'PALACIOS', crudos = false } = {}) {
  if (!contactId) return { ok: false, reason: 'falta contactId' };

  const sedeId = String(sede).toUpperCase();
  const cfg = SEDES_GATEWAY[sedeId];
  const locId = cfg?.ghl?.locationId;
  const apiKey = cfg?.ghl?.apiKey;
  if (!locId || !apiKey) return { ok: false, reason: `Sede ${sedeId} sin credenciales cargadas` };

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  const headersJson = { ...headers, 'Content-Type': 'application/json' };

  const salida = { ok: true, sede: sedeId, contactId, camposGhl: null, atribucionGhl: null, mensajes: [], analisis: {} };

  // -------- 1. Contacto + sus campos personalizados --------
  try {
    // GHL entrega `customFields: [{id, value}]` SIN nombre: hay que resolver el
    // diccionario id->nombre de la subcuenta o se leería todo vacío.
    const mapaCampos = await obtenerMapaCamposGhl(locId, headers);
    const rC = await ghlFetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers }, 1, 'Diag-Atribucion');
    if (rC.status === 200) {
      const c = (await rC.json())?.contact || {};
      const porNombre = {};
      const todos = {};
      for (const cf of (c.customFields || [])) {
        const nombre = mapaCampos.porId.get(cf.id) || cf.name || cf.id;
        const valor = cf.value ?? cf.field_value ?? null;
        const v = Array.isArray(valor) ? valor.join(', ') : valor;
        todos[nombre] = v;
        // Se listan los relacionados con atribución, pero además se conserva el
        // volcado completo cuando se pide `crudos` (para diagnosticar sin dudas).
        if (/anuncio|ad_id|adset|campa|conjunto|utm|origen|interacc|canal|fuente/i.test(String(nombre))) {
          porNombre[nombre] = v;
        }
      }
      salida.camposGhlTodos = todos;
      salida.camposGhl = {
        id: c.id,
        nombre: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        telefono: c.phone || null,
        propietario: c.assignedTo || null,
        etiquetas: c.tags || [],
        fechaCreacion: c.dateAdded || null,
        fechaActualizacion: c.dateUpdated || null,
        atribucion: porNombre
      };
      salida.atribucionGhl = {
        firstTouch: resumirAtribucion(c.attributionSource),
        lastTouch: resumirAtribucion(c.lastAttributionSource),
        todas: Array.isArray(c.attributions) ? c.attributions.map(resumirAtribucion) : []
      };
    } else {
      salida.camposGhl = { error: `HTTP ${rC.status}` };
    }
  } catch (e) {
    salida.camposGhl = { error: e.message };
  }

  // -------- 2. Mensajes de TODAS las conversaciones (el referral) --------
  try {
    const rConv = await ghlFetch(
      `https://services.leadconnectorhq.com/conversations/search?locationId=${locId}&contactId=${contactId}&limit=10`,
      { headers: { ...headers, Version: '2021-04-15' } },
      1,
      'Diag-Atribucion'
    );
    if (rConv.status === 200) {
      const dConv = await rConv.json();
      const conversaciones = dConv?.conversations || dConv?.conversaciones || [];
      for (const cv of conversaciones) {
        const rMsg = await ghlFetch(
          `https://services.leadconnectorhq.com/conversations/${cv.id}/messages?locationId=${locId}&limit=50`,
          { headers: headersJson },
          1,
          'Diag-Atribucion'
        );
        if (rMsg.status !== 200) continue;
        const dMsg = await rMsg.json();
        const msgs = dMsg?.messages?.messages || [];
        for (const m of msgs) {
          const fb = m.meta?.fb || {};
          const ref = m.meta?.referral || {};
          const adId = fb.adId || fb.ad_id || ref.ad_id || ref.adId || null;
          const entrada = {
            conversacion: cv.id,
            fecha: m.dateAdded,
            direccion: m.direction || null,
            tipo: m.messageType || m.type || null,
            adIdDetectado: adId,
            clavesMeta: m.meta ? Object.keys(m.meta) : [],
            referralSource: ref.source || null,
            referralType: ref.type || null,
            paginaOrigen: fb.fromPageId || fb.pageId || null
          };
          if (crudos && m.meta) entrada.metaCrudo = m.meta;
          salida.mensajes.push(entrada);
        }
        await sleep(120);
      }
    }
  } catch (e) {
    salida.analisis.errorMensajes = e.message;
  }

  // -------- 3. Análisis: ¿de dónde DEBERÍA haber salido el Ad ID? --------
  const conAdIdEnMensajes = salida.mensajes.filter(m => m.adIdDetectado && m.adIdDetectado !== 'N/A');
  const atrib = salida.atribucionGhl || {};
  const conAdIdEnGhl = [atrib.firstTouch, atrib.lastTouch, ...(atrib.todas || [])].filter(a => a && (a.adId || a.utmAdId));
  const campoIdAnuncio = salida.camposGhl?.atribucion?.['ID de Anuncio'] || null;

  salida.analisis = {
    ...salida.analisis,
    adIdEnMensajes: conAdIdEnMensajes.length,
    adIdEnAtribucionGhl: conAdIdEnGhl.length,
    campoIdAnuncioActual: campoIdAnuncio,
    diagnostico: campoIdAnuncio
      ? '✅ El campo "ID de Anuncio" SI tiene valor: revisar si corresponde al ultimo anuncio.'
      : (conAdIdEnMensajes.length > 0
        ? '🟡 El Ad ID EXISTE en los mensajes pero NO esta escrito en el contacto: el router no lo proceso (o fallo).'
        : (conAdIdEnGhl.length > 0
          ? '🟡 El Ad ID EXISTE en la atribucion de GHL pero NO esta en el campo: el router no lo proceso.'
          : '🔴 NO hay Ad ID en ninguna fuente. Si en Meta Business Suite aparece, el referral NO llego a GHL (revisar el type/canal del anuncio y el metadata crudo).'))
  };

  return salida;
}
