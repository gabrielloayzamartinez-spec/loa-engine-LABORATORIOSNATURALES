/**
 * ==============================================================================
 * CORRECTOR DE ORÍGENES — CONTACTOS DE LA FANPAGE "ULTRA" (BioNatural - Ultra)
 * ==============================================================================
 * POR QUÉ EXISTE
 * La fanpage "BioNatural - Ultra" no estaba vinculada al System User de Meta, así
 * que el motor NO podía traducir el Ad ID de sus anuncios a Campaña / Conjunto /
 * Nombre de Anuncio. Resultado: los contactos de Ultra (HISTÓRICOS y RECIENTES)
 * quedaron con el ORIGEN erróneo o vacío.
 *
 * Con Ultra YA vinculada al System User, el Ad ID se puede traducir. Este corrector
 * RE-RESUELVE el origen real de cada contacto de Ultra leyendo el Ad ID del
 * "referral" de sus mensajes de Messenger.
 *
 * CÓMO FUNCIONA (sin duplicar lógica)
 * Re-ejecuta el MISMO router que corre en vivo (`routeChatByContact`). Así cada
 * contacto se corrige con EXACTAMENTE la lógica vigente:
 *   · lectura de TODAS las conversaciones (no solo la primera),
 *   · atribución MÁS RECIENTE (no el primer toque),
 *   · resolución del anuncio con los accesos nuevos de Meta,
 *   · escritura atómica de los campos claros (Anuncio / Campaña / Conjunto).
 *
 * DOS MODOS
 *   1. SÍNCRONO (para tandas chicas): `corregirOrigenesUltra({ limite })`.
 *   2. BACKGROUND (para la cartera completa): `iniciarCorreccionUltraFondo()`.
 *      Un request HTTP no aguanta ~40 minutos de trabajo, así que el barrido
 *      completo corre en segundo plano y el avance se consulta aparte.
 *
 * SEGURIDAD Y GOBERNANZA
 *   · DRY-RUN por defecto en modo síncrono: solo reporta, NO escribe.
 *   · Solo toca contactos etiquetados con la fanpage de Ultra.
 *   · Throttle de 150 ms para no saturar GHL ni vTiger.
 *   · vTiger se consulta en SOLO LECTURA (gobernanza intacta).
 *   · Un solo barrido a la vez (flag en memoria) para no duplicar trabajo.
 * ==============================================================================
 */

import { ghlFetch } from '../utils/ghl_http_client.js';
import { SEDES_GATEWAY } from '../config/index.js';
import { routeChatByContact } from '../agents/chat_router_agent.js';
import { recordAuditEvent } from './audit_logger.js';

/**
 * Etiquetas (slugs) que el router deja en los contactos de la fanpage Ultra.
 * El router normaliza a guiones ("bionatural-ultra"); se aceptan ambas formas
 * para cubrir datos históricos escritos antes de la normalización.
 */
const ULTRA_PAGE_SLUGS = [
  'bionatural-ultra',
  'bionatural ultra',
  'laboratorios-naturales-bio',
  'laboratorios naturales bio'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Estado del barrido en segundo plano (consulta via estadoCorreccionUltra). */
let estadoUltra = {
  corriendo: false,
  sede: null,
  iniciadoEn: null,
  total: 0,
  procesados: 0,
  errores: 0,
  actual: null,
  ultimoReporte: null
};

/** Devuelve una copia del estado actual del barrido. */
export function estadoCorreccionUltra() {
  return { ...estadoUltra };
}

/**
 * Recorre los contactos de una sede (paginado) y devuelve los de Ultra.
 * Es SOLO LECTURA: no modifica nada.
 */
async function listarContactosUltra({ locId, headers, limitePaginas }) {
  const encontrados = [];
  let escaneados = 0;
  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100`;

  for (let p = 0; p < limitePaginas; p++) {
    if (!url) break;
    const r = await ghlFetch(url, { headers }, 1, 'Ultra-Corrector');
    if (r.status !== 200) break;
    const d = await r.json();
    const contactos = d?.contacts || [];
    if (contactos.length === 0) break;

    for (const c of contactos) {
      escaneados++;
      const tags = (c.tags || []).map(t => String(t).toLowerCase().trim());
      if (tags.some(t => ULTRA_PAGE_SLUGS.includes(t))) {
        encontrados.push({
          id: c.id,
          nombre: `${c.firstName || ''} ${c.lastName || ''}`.trim() || '(sin nombre)'
        });
      }
    }

    // [PAGINACIÓN CONFIABLE] GHL exige seguir `meta.nextPageUrl`; el `startAfter`
    // numérico NO avanza la página (defecto ya corregido en los otros depuradores).
    url = d?.meta?.nextPageUrl || null;
  }

  return { encontrados, escaneados };
}

/** Resuelve credenciales de una sede. */
function resolverSede(sede) {
  const sedeId = String(sede || 'PALACIOS').toUpperCase();
  const cfg = SEDES_GATEWAY[sedeId];
  const locId = cfg?.ghl?.locationId;
  const apiKey = cfg?.ghl?.apiKey;
  if (!locId || !apiKey) return null;
  return {
    sedeId,
    locId,
    headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' }
  };
}

/**
 * MODO SÍNCRONO — corrige una tanda chica (default DRY-RUN).
 * Útil para simular y para aplicar de a poco sin exceder el timeout del request.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede='PALACIOS']
 * @param {number} [opts.paginas=10]  páginas de 100 contactos a escanear (tope 500)
 * @param {boolean} [opts.ejecutar=false] false = DRY-RUN (no escribe)
 * @param {number} [opts.limite=50]   máximo de contactos de Ultra a procesar
 * @returns {Promise<object>} reporte con el conteo y el detalle por contacto
 */
export async function corregirOrigenesUltra({ sede = 'PALACIOS', paginas = 10, ejecutar = false, limite = 50 } = {}) {
  const ctx = resolverSede(sede);
  if (!ctx) return { ok: false, reason: `Sede ${sede} sin credenciales cargadas` };

  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 10, 1), 500);
  const tope = Math.min(Math.max(parseInt(limite, 10) || 50, 1), 200);

  const { encontrados, escaneados } = await listarContactosUltra({ ...ctx, limitePaginas });
  const aProcesar = encontrados.slice(0, tope);

  let corregidos = 0;
  let errores = 0;
  const detalle = [];

  for (const c of aProcesar) {
    try {
      if (!ejecutar) {
        detalle.push({ id: c.id, nombre: c.nombre, resultado: 'DRY_RUN (no se escribio nada)' });
        continue; // En simulación NO se cuenta como corregido.
      }
      const resultado = await routeChatByContact(c.id, true, false, { locationId: ctx.locId, headers: ctx.headers, origen: 'ultra-corrector' });
      detalle.push({ id: c.id, nombre: c.nombre, resultado });
      corregidos++;
    } catch (err) {
      errores++;
      detalle.push({ id: c.id, nombre: c.nombre, error: err.message });
    }
    await sleep(150); // Throttle seguro: ni GHL ni vTiger se saturan.
  }

  const reporte = {
    ok: true,
    sede: ctx.sedeId,
    modo: ejecutar ? 'EJECUTADO' : 'DRY-RUN',
    escaneados,
    contactosUltra: encontrados.length,
    procesadosEnEstaTanda: aProcesar.length,
    corregidos,
    errores,
    detalle: detalle.slice(0, 100)
  };

  recordAuditEvent({
    type: ejecutar ? 'ULTRA_ORIGENES_CORREGIDOS' : 'ULTRA_ORIGENES_DRY_RUN',
    severity: 'info',
    sede: ctx.sedeId,
    escaneados,
    contactosUltra: encontrados.length,
    corregidos,
    errores
  });

  return reporte;
}

/**
 * MODO BACKGROUND — barre la cartera completa de Ultra en segundo plano.
 * Devuelve de inmediato; el avance se consulta con `estadoCorreccionUltra()`.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede='PALACIOS']
 * @param {number} [opts.paginas=200]
 */
export function iniciarCorreccionUltraFondo({ sede = 'PALACIOS', paginas = 200 } = {}) {
  if (estadoUltra.corriendo) {
    return { ok: false, reason: 'Ya hay una correccion de Ultra en curso', estado: estadoCorreccionUltra() };
  }

  const ctx = resolverSede(sede);
  if (!ctx) return { ok: false, reason: `Sede ${sede} sin credenciales cargadas` };

  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 200, 1), 500);

  estadoUltra = {
    corriendo: true,
    sede: ctx.sedeId,
    iniciadoEn: new Date().toISOString(),
    total: 0,
    procesados: 0,
    errores: 0,
    actual: 'escaneando contactos...',
    ultimoReporte: null
  };

  // Barrido asíncrono: NO se espera (el request responde al instante).
  (async () => {
    let total = 0;
    try {
      const { encontrados } = await listarContactosUltra({ ...ctx, limitePaginas });
      total = encontrados.length;
      estadoUltra.total = total;

      for (const c of encontrados) {
        estadoUltra.actual = c.nombre;
        try {
          await routeChatByContact(c.id, true, false, { locationId: ctx.locId, headers: ctx.headers, origen: 'ultra-corrector' });
          estadoUltra.procesados++;
        } catch {
          estadoUltra.errores++;
        }
        await sleep(150);
      }

      recordAuditEvent({
        type: 'ULTRA_ORIGENES_FONDO_COMPLETADO',
        severity: 'info',
        sede: ctx.sedeId,
        total,
        procesados: estadoUltra.procesados,
        errores: estadoUltra.errores
      });
    } catch (err) {
      recordAuditEvent({
        type: 'ULTRA_ORIGENES_FONDO_ERROR',
        severity: 'critical',
        sede: ctx.sedeId,
        message: err.message
      });
    } finally {
      estadoUltra.corriendo = false;
      estadoUltra.actual = null;
      estadoUltra.ultimoReporte = {
        sede: ctx.sedeId,
        total,
        procesados: estadoUltra.procesados,
        errores: estadoUltra.errores,
        finalizadoEn: new Date().toISOString()
      };
    }
  })();

  return { ok: true, iniciado: true, sede: ctx.sedeId, estado: estadoCorreccionUltra() };
}

/**
 * ==============================================================================
 * DIAGNÓSTICO DE UTMs — ¿qué origen se puede EXTRAER de un contacto de Ultra?
 * ==============================================================================
 * Ultra es SOLO Messenger, así que el origen llega por DOS vías distintas:
 *
 *   VÍA 1 — Referral del mensaje (la principal para Messenger):
 *     Cuando el lead hace clic en el anuncio, Facebook abre Messenger con un
 *     "referral" que lleva el `ad_id` (y a veces `ref`, `source`, `type`). No hay
 *     URL de destino, así que NO hay parámetros utm_* clásicos: el `ad_id` es el
 *     identificador maestro y se traduce a Campaña / Conjunto / Anuncio con la
 *     API de Meta.
 *
 *   VÍA 2 — Atribución de GHL (`attributionSource` / `lastAttributionSource` /
 *     `attributions`): si el lead llegó por un enlace con parámetros, GHL guarda
 *     utmSource, utmMedium, utmCampaign, utmContent, utmTerm y adId.
 *
 * Este diagnóstico es SOLO LECTURA: muestra, contacto por contacto, qué campos
 * trae cada vía para saber exactamente qué se puede recuperar y qué no.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede='PALACIOS']
 * @param {number} [opts.paginas=20] páginas a escanear para encontrar Ultra
 * @param {number} [opts.muestra=5]  contactos a inspeccionar a fondo (tope 25)
 */
export async function diagnosticarUtmsUltra({ sede = 'PALACIOS', paginas = 20, muestra = 5 } = {}) {
  const ctx = resolverSede(sede);
  if (!ctx) return { ok: false, reason: `Sede ${sede} sin credenciales cargadas` };

  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 20, 1), 500);
  const tope = Math.min(Math.max(parseInt(muestra, 10) || 5, 1), 25);

  const { encontrados, escaneados } = await listarContactosUltra({ ...ctx, limitePaginas });
  const seleccion = encontrados.slice(0, tope);

  /** Normaliza una atribución a los campos que nos interesan. */
  const extraerUtms = attr => {
    if (!attr) return null;
    return {
      utmSource: attr.utmSource || null,
      utmMedium: attr.utmMedium || null,
      utmCampaign: attr.utmCampaign || attr.campaign || null,
      utmContent: attr.utmContent || null,
      utmTerm: attr.utmTerm || null,
      adId: attr.utmAdId || attr.adId || null,
      sessionSource: attr.sessionSource || null,
      medium: attr.medium || null
    };
  };

  const detalle = [];
  for (const c of seleccion) {
    const item = { id: c.id, nombre: c.nombre, atribucionGhl: null, adsEnMensajes: [], error: null };
    try {
      // 1. Atribución de GHL (vía 2).
      const rC = await ghlFetch(
        `https://services.leadconnectorhq.com/contacts/${c.id}`,
        { headers: ctx.headers },
        1,
        'Ultra-Diag'
      );
      if (rC.status === 200) {
        const contacto = (await rC.json())?.contact || {};
        item.atribucionGhl = {
          firstTouch: extraerUtms(contacto.attributionSource),
          lastTouch: extraerUtms(contacto.lastAttributionSource),
          todasLasAtribuciones: Array.isArray(contacto.attributions)
            ? contacto.attributions.map(extraerUtms)
            : []
        };
      }

      // 2. Referral de los mensajes (vía 1) — la fuente real para Messenger.
      const rConv = await ghlFetch(
        `https://services.leadconnectorhq.com/conversations/search?locationId=${ctx.locId}&contactId=${c.id}&limit=5`,
        { headers: { ...ctx.headers, Version: '2021-04-15' } },
        1,
        'Ultra-Diag'
      );
      if (rConv.status === 200) {
        const dConv = await rConv.json();
        const conversaciones = dConv?.conversations || dConv?.conversaciones || [];
        for (const cv of conversaciones.slice(0, 3)) {
          const rMsg = await ghlFetch(
            `https://services.leadconnectorhq.com/conversations/${cv.id}/messages?locationId=${ctx.locId}&limit=20`,
            { headers: ctx.headers },
            1,
            'Ultra-Diag'
          );
          if (rMsg.status !== 200) continue;
          const dMsg = await rMsg.json();
          for (const m of (dMsg?.messages?.messages || [])) {
            const fb = m.meta?.fb || {};
            const ref = m.meta?.referral || {};
            const ad = fb.adId || fb.ad_id || ref.ad_id || ref.adId || null;
            if (ad || ref.source || ref.type) {
              item.adsEnMensajes.push({
                fecha: m.dateAdded,
                adId: ad,
                refSource: ref.source || null,
                refType: ref.type || null,
                refRef: ref.ref || null,
                desdePagina: fb.fromPageId || fb.pageId || null
              });
            }
          }
          await sleep(120);
        }
      }
    } catch (err) {
      item.error = err.message;
    }
    detalle.push(item);
    await sleep(150);
  }

  const conAdEnMensaje = detalle.filter(d => d.adsEnMensajes.some(a => a.adId)).length;
  const conUtmGhl = detalle.filter(d =>
    d.atribucionGhl && (
      (d.atribucionGhl.lastTouch && (d.atribucionGhl.lastTouch.utmCampaign || d.atribucionGhl.lastTouch.adId)) ||
      (d.atribucionGhl.firstTouch && (d.atribucionGhl.firstTouch.utmCampaign || d.atribucionGhl.firstTouch.adId))
    )
  ).length;

  return {
    ok: true,
    sede: ctx.sedeId,
    escaneados,
    contactosUltra: encontrados.length,
    muestraInspeccionada: detalle.length,
    resumen: {
      conAdIdEnMensajes: conAdEnMensaje,
      conUtmsEnGhl: conUtmGhl,
      sinNingunaFuente: detalle.length - Math.max(conAdEnMensaje, conUtmGhl)
    },
    detalle
  };
}
