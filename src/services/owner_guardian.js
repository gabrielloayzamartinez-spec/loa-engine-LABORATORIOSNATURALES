/**
 * ==============================================================================
 * GUARDIÁN DE PROPIETARIO — "cada página tiene UN dueño, y se respeta"
 * ==============================================================================
 * POR QUÉ EXISTE
 * La regla del dealer es estricta y ya está codificada en el router:
 *
 *   PALACIOS   · Naturales BioNatural        (566501466542620) -> REDES 1 ERNESTO
 *              · BioNatural - Ultra          (111906554968800) -> REDES 2 CLICK2RING
 *              · Laboratorios Naturales BIO  (718150351371765) -> REDES 2 CLICK2RING
 *
 *   BENAVIDES  · Naturales Bio Corp          (510617778807469) -> REDES 1 BENAVIDES
 *              · Bio Natural / Fuerza        (126154270581792 / 1147742788423762) -> REDES 2 BENAVIDES
 *
 * DEFECTO REAL EN PRODUCCION (reportado por el usuario)
 * La auditoría de ruteo detectó contactos con la etiqueta de fanpage CORRECTA pero
 * SIN PROPIETARIO asignado (propietario vacío). No estaban mal delegados: estaban
 * HUÉRFANOS. El router sólo actúa cuando el lead escribe, así que un contacto
 * migrado o sin chat reciente se quedaba sin dueño para siempre — y nadie lo veía.
 *
 * QUÉ HACE
 * Lee los contactos de una sede, detecta los que TIENEN etiqueta de fanpage pero
 * NO tienen propietario, resuelve el dueño que dicta la regla y lo ASIGNA.
 * Es la contraparte proactiva del auditor: el auditor AVISA, este CORRIGE.
 *
 * SEGURIDAD
 *   · DRY-RUN por defecto: sin `ejecutar=true` no escribe NADA.
 *   · Solo toca contactos con fanpage CONOCIDA y sin propietario: nunca reasigna
 *     a alguien que ya tiene dueño (cero robos de cartera).
 *   · Throttle de 150 ms y todas las llamadas pasan por el freno central de GHL.
 * ==============================================================================
 */

import { ghlFetch } from '../utils/ghl_http_client.js';
import { SEDES_GATEWAY, PALACIOS_USERS } from '../config/index.js';
import { recordAuditEvent } from './audit_logger.js';

/** Misma normalización que el router y el auditor: slug a guiones. */
const slugificar = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Indice: slug de fanpage -> asesor esperado.
 * Se deriva de la propia configuracion (pages + id), no de una lista a mano, para
 * que sirva a las 4 sedes y siga funcionando si se agrega una página nueva.
 */
function construirReglas() {
  const porSlug = new Map();
  for (const sede of Object.values(SEDES_GATEWAY)) {
    for (const usuario of Object.values(sede?.users || {})) {
      if (!usuario?.id) continue;
      for (const nombrePagina of (usuario.pages || [])) {
        porSlug.set(slugificar(nombrePagina), { id: usuario.id, name: usuario.name, sede: sede.sedeId });
      }
    }
  }
  // Palacios se apoya además en PALACIOS_USERS (fuente 1:1 de fanpages).
  for (const usuario of Object.values(PALACIOS_USERS)) {
    if (!usuario?.id) continue;
    for (const nombrePagina of (usuario.pages || [])) {
      const slug = slugificar(nombrePagina);
      if (!porSlug.has(slug)) {
        porSlug.set(slug, { id: usuario.id, name: usuario.name, sede: 'PALACIOS' });
      }
    }
  }
  return porSlug;
}

/**
 * Corrige (o simula corregir) los contactos con fanpage conocida pero SIN dueño.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede='PALACIOS']
 * @param {number} [opts.paginas=10] páginas de 100 contactos a escanear (tope 200)
 * @param {boolean} [opts.ejecutar=false] false = DRY-RUN (no escribe)
 */
export async function guardianDePropietario({ sede = 'PALACIOS', paginas = 10, ejecutar = false } = {}) {
  const sedeId = String(sede).toUpperCase();
  const cfg = SEDES_GATEWAY[sedeId];
  const locId = cfg?.ghl?.locationId;
  const apiKey = cfg?.ghl?.apiKey;
  if (!locId || !apiKey) return { ok: false, reason: `Sede ${sedeId} sin credenciales cargadas` };

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };
  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 10, 1), 200);
  const porSlug = construirReglas();

  let escaneados = 0;
  let sinDuenio = 0;
  let corregidos = 0;
  let errores = 0;
  const detalle = [];

  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100`;
  for (let p = 0; p < limitePaginas && url; p++) {
    const r = await ghlFetch(url, { headers }, 1, 'Guardian-Propietario');
    if (r.status !== 200) break;
    const d = await r.json();
    const contactos = d?.contacts || [];
    if (contactos.length === 0) break;

    for (const c of contactos) {
      escaneados++;
      // Solo interesan los que NO tienen dueño.
      if (c.assignedTo) continue;

      const tags = (c.tags || []).map(t => String(t).toLowerCase().trim());
      let esperado = null;
      for (const [slug, asesor] of porSlug.entries()) {
        if (tags.includes(slug)) { esperado = asesor; break; }
      }
      if (!esperado) continue; // sin fanpage conocida: no se inventa un dueño

      sinDuenio++;
      const item = { id: c.id, nombre: `${c.firstName || ''} ${c.lastName || ''}`.trim(), asesor: esperado.name, sedeAsesor: esperado.sede };

      if (!ejecutar) {
        item.resultado = 'DRY_RUN (no se escribio nada)';
        detalle.push(item);
        continue;
      }

      try {
        const put = await ghlFetch(
          `https://services.leadconnectorhq.com/contacts/${c.id}`,
          { method: 'PUT', headers, body: JSON.stringify({ assignedTo: esperado.id }) },
          1,
          'Guardian-Propietario'
        );
        if (put.ok) {
          corregidos++;
          item.resultado = `ASIGNADO a ${esperado.name}`;
        } else {
          errores++;
          item.resultado = `FALLO HTTP ${put.status}`;
        }
      } catch (err) {
        errores++;
        item.resultado = `ERROR ${err.message}`;
      }
      detalle.push(item);
      await sleep(150);
    }

    url = d?.meta?.nextPageUrl || null;
  }

  const reporte = {
    ok: true,
    sede: sedeId,
    modo: ejecutar ? 'EJECUTADO' : 'DRY-RUN',
    escaneados,
    sinPropietarioConFanpage: sinDuenio,
    corregidos,
    errores,
    detalle: detalle.slice(0, 100)
  };

  recordAuditEvent({
    type: ejecutar ? 'OWNER_GUARDIAN_CORREGIDOS' : 'OWNER_GUARDIAN_DRY_RUN',
    severity: 'info',
    sede: sedeId,
    escaneados,
    sinDuenio,
    corregidos,
    errores
  });

  return reporte;
}
