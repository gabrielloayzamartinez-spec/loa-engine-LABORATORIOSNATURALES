/**
 * ==============================================================================
 * CORRECTOR DE ORÍGENES — CONTACTOS DE LA FANPAGE "ULTR A" (BioNatural - Ultra)
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
 * SEGURIDAD Y GOBERNANZA
 *   · DRY-RUN por defecto: solo reporta, NO escribe.
 *   · Solo toca contactos etiquetados con la fanpage de Ultra.
 *   · Throttle de 150 ms para no saturar GHL ni vTiger.
 *   · vTiger se consulta en SOLO LECTURA (gobernanza intacta).
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

/**
 * Corrige (o simula corregir) los orígenes de los contactos de Ultra.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede='PALACIOS']
 * @param {number} [opts.paginas=10]  páginas de 100 contactos a escanear (tope 200)
 * @param {boolean} [opts.ejecutar=false] false = DRY-RUN (no escribe)
 * @returns {Promise<object>} reporte con el conteo y el detalle por contacto
 */
export async function corregirOrigenesUltra({ sede = 'PALACIOS', paginas = 10, ejecutar = false } = {}) {
  const sedeId = String(sede).toUpperCase();
  const cfg = SEDES_GATEWAY[sedeId];
  const locId = cfg?.ghl?.locationId;
  const apiKey = cfg?.ghl?.apiKey;

  if (!locId || !apiKey) {
    return { ok: false, reason: `Sede ${sedeId} sin credenciales cargadas` };
  }

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 10, 1), 200);

  const { encontrados, escaneados } = await listarContactosUltra({ locId, headers, limitePaginas });

  let corregidos = 0;
  let errores = 0;
  const detalle = [];

  for (const c of encontrados) {
    try {
      if (ejecutar) {
        const resultado = await routeChatByContact(c.id, true, false, { locationId: locId, headers });
        detalle.push({ id: c.id, nombre: c.nombre, resultado });
      } else {
        detalle.push({ id: c.id, nombre: c.nombre, resultado: 'DRY_RUN (no se escribio nada)' });
      }
      corregidos++;
    } catch (err) {
      errores++;
      detalle.push({ id: c.id, nombre: c.nombre, error: err.message });
    }
    await sleep(150); // Throttle seguro: ni GHL ni vTiger se saturan.
  }

  const reporte = {
    ok: true,
    sede: sedeId,
    modo: ejecutar ? 'EJECUTADO' : 'DRY-RUN',
    escaneados,
    contactosUltra: encontrados.length,
    corregidos,
    errores,
    detalle: detalle.slice(0, 100)
  };

  recordAuditEvent({
    type: ejecutar ? 'ULTRA_ORIGENES_CORREGIDOS' : 'ULTRA_ORIGENES_DRY_RUN',
    severity: 'info',
    sede: sedeId,
    escaneados,
    contactosUltra: encontrados.length,
    corregidos,
    errores
  });

  return reporte;
}
