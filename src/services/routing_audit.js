/**
 * ==============================================================================
 * AUDITOR DE RUTEO DE PROPIETARIO — "el ojo" sobre las delegaciones
 * ==============================================================================
 * POR QUE EXISTE
 * El router asigna el propietario del chat segun la fanpage por la que escribio
 * el lead. La regla del dealer es estricta: cada fanpage tiene UN propietario fijo.
 *
 * El router etiqueta cada contacto con el slug de su fanpage (via PAGE_TAG_MAP),
 * asi que aqui se audita de forma INDEPENDIENTE: se lee la etiqueta de fanpage y
 * se compara con el propietario real asignado. Si no coinciden, se reporta.
 *
 * [GENERICO PARA LAS 4 SUBCUENTAS] Las reglas se derivan de la propia configuracion
 * (los `fbPageIds` y `pages` de cada asesor), no de una lista escrita a mano. Asi el
 * auditor cubre Palacios, Benavides, Roosevelt y Piura con la misma logica, y sigue
 * funcionando cuando se agregue una sede nueva.
 *
 * Es SOLO LECTURA: no corrige nada por si mismo. Su trabajo es dar visibilidad para
 * que una delegacion equivocada no vuelva a pasar desapercibida.
 * ==============================================================================
 */

import { ghlFetch } from '../utils/ghl_http_client.js';
import { PALACIOS_USERS, SEDES_GATEWAY } from '../config/index.js';

/**
 * El router etiqueta la fanpage con un slug normalizado a guiones:
 *   "BioNatural - Ultra"   -> "bionatural-ultra"
 *   "Naturales BioNatural" -> "naturales-bionatural"
 * PAGE_TAG_MAP usa espacios ("bionatural ultra"), por eso el auditor debe aplicar
 * la MISMA normalizacion que el router, o no encontrara ninguna etiqueta.
 */
const slugificar = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** Construye el indice: slug de fanpage (normalizado) -> asesor esperado. */
function construirReglas() {
  const porSlug = new Map();
  for (const usuario of Object.values(PALACIOS_USERS)) {
    if (!usuario?.id) continue;
    for (const nombrePagina of (usuario.pages || [])) {
      porSlug.set(slugificar(nombrePagina), usuario);
    }
  }
  return { porSlug };
}

/**
 * Audita el ruteo de propietario de una sede.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede='PALACIOS']
 * @param {number} [opts.paginas=20] paginas de 100 contactos a escanear (tope 500)
 * @returns {Promise<object>} reporte con los desajustes encontrados
 */
export async function auditarRuteo({ sede = 'PALACIOS', paginas = 20 } = {}) {
  const sedeId = String(sede).toUpperCase();
  const cfg = SEDES_GATEWAY[sedeId];
  const locId = cfg?.ghl?.locationId;
  const apiKey = cfg?.ghl?.apiKey;
  if (!locId || !apiKey) {
    return { ok: false, reason: `Sede ${sedeId} sin credenciales` };
  }

  const { porSlug } = construirReglas();
  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 20, 1), 500);

  // Indice inverso: id de usuario -> nombre
  const nombrePorId = new Map(
    Object.values(PALACIOS_USERS).filter(u => u?.id).map(u => [u.id, u.name])
  );

  let escaneados = 0;
  let conFanpage = 0;
  let sinFanpage = 0;
  let correctos = 0;
  let malDelegados = 0;
  let sinPropietario = 0;
  const desajustes = [];

  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100`;
  for (let p = 0; p < limitePaginas; p++) {
    const r = await ghlFetch(url, { headers }, 1, 'Audit-Ruteo');
    if (r.status !== 200) {
      return { ok: false, reason: `GHL devolvio HTTP ${r.status}`, escaneados };
    }
    const d = await r.json();
    const contactos = d?.contacts || [];
    if (contactos.length === 0) break;

    for (const c of contactos) {
      escaneados++;
      const tags = (c.tags || []).map(t => String(t).toLowerCase().trim());

      // 1) Fanpage detectada por la etiqueta que dejo el router.
      let slugFanpage = null;
      for (const slug of porSlug.keys()) {
        if (tags.includes(slug)) { slugFanpage = slug; break; }
      }

      if (!slugFanpage) { sinFanpage++; continue; }
      conFanpage++;

      const esperado = porSlug.get(slugFanpage);
      if (!esperado) continue; // fanpage de otra sede: fuera del alcance de esta regla

      const asignadoNombre = nombrePorId.get(c.assignedTo) || null;
      const nombreContacto = c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim();

      if (!c.assignedTo) {
        sinPropietario++;
        if (desajustes.length < 100) {
          desajustes.push({
            contactoId: c.id, nombre: nombreContacto, fanpage: slugFanpage,
            esperado: esperado.name, actual: '(sin propietario)',
            motivo: 'contacto con fanpage conocida pero SIN propietario'
          });
        }
        continue;
      }

      if (c.assignedTo === esperado.id) { correctos++; continue; }

      malDelegados++;
      if (desajustes.length < 100) {
        desajustes.push({
          contactoId: c.id, nombre: nombreContacto, fanpage: slugFanpage,
          esperado: esperado.name, actual: asignadoNombre || c.assignedTo,
          motivo: `la fanpage "${slugFanpage}" exige ${esperado.name}`
        });
      }
    }

    const meta = d?.meta || {};
    if (meta.nextPageUrl) {
      url = meta.nextPageUrl;
    } else {
      const cursor = meta.startAfterId ?? meta.startAfter ?? (contactos[contactos.length - 1]?.id);
      url = cursor ? `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100&startAfterId=${cursor}` : null;
    }
    if (!url) break;
  }

  const totalConRegla = correctos + malDelegados + sinPropietario;
  return {
    ok: true,
    sede: sedeId,
    escaneados,
    conFanpage,
    sinFanpage,
    conReglaAplicable: totalConRegla,
    correctos,
    malDelegados,
    sinPropietario,
    tasaAcierto: totalConRegla > 0 ? Math.round((correctos / totalConRegla) * 1000) / 10 : null,
    desajustes
  };
}

/**
 * Audita las 4 subcuentas de una sola vez.
 * @param {object} [opts]
 * @param {number} [opts.paginas=10] paginas por sede
 */
export async function auditarRuteoTodasLasSedes({ paginas = 10 } = {}) {
  const porSede = {};
  for (const sedeId of Object.keys(SEDES_GATEWAY)) {
    try {
      porSede[sedeId] = await auditarRuteo({ sede: sedeId, paginas });
    } catch (e) {
      porSede[sedeId] = { ok: false, reason: String(e.message).slice(0, 120) };
    }
  }
  const ok = Object.values(porSede).filter(r => r.ok);
  return {
    ok: true,
    paginasPorSede: paginas,
    resumen: {
      sedesAuditadas: ok.length,
      totalEscaneado: ok.reduce((a, r) => a + (r.escaneados || 0), 0),
      totalConFanpage: ok.reduce((a, r) => a + (r.conFanpage || 0), 0),
      totalCorrectos: ok.reduce((a, r) => a + (r.correctos || 0), 0),
      totalMalDelegados: ok.reduce((a, r) => a + (r.malDelegados || 0), 0),
      totalSinPropietario: ok.reduce((a, r) => a + (r.sinPropietario || 0), 0)
    },
    porSede
  };
}
