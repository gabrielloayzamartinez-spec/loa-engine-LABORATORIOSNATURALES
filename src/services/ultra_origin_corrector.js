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
      const resultado = await routeChatByContact(c.id, true, false, { locationId: ctx.locId, headers: ctx.headers });
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
          await routeChatByContact(c.id, true, false, { locationId: ctx.locId, headers: ctx.headers });
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
