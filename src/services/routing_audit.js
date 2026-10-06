/**
 * ==============================================================================
 * AUDITOR DE RUTEO DE PROPIETARIO — "el ojo" sobre las delegaciones
 * ==============================================================================
 * POR QUE EXISTE
 * El router asigna el propietario del chat segun la fanpage por la que escribio
 * el lead. La regla de negocio del dealer es estricta:
 *
 *    Fanpage "BioNatural - Ultra"      ->  SIEMPRE  CLICK2RING
 *    Fanpage "Naturales BioNatural"    ->  SIEMPRE  ERNESTO
 *
 * El router etiqueta cada contacto con el slug de su fanpage (via PAGE_TAG_MAP),
 * asi que aqui se puede auditar de forma INDEPENDIENTE: se lee la etiqueta de
 * fanpage y se compara con el propietario real. Si no coinciden, el contacto se
 * reporta como mal delegado.
 *
 * Es solo lectura: NO corrige nada por si mismo. Su trabajo es DAR VISIBILIDAD
 * para que el error no vuelva a pasar desapercibido.
 * ==============================================================================
 */

import { ghlFetch } from '../utils/ghl_http_client.js';
import { PAGE_TAG_MAP, PALACIOS_USERS, SEDES_GATEWAY } from '../config/index.js';

/** Fanpage -> propietario esperado (la regla del dealer). */
const REGLA_PROPIETARIO = {
  'bionatural ultra': { usuario: 'bionatural ultra', etiqueta: 'CLICK2RING' },
  'naturales bionatural': { usuario: 'naturales bionatural', etiqueta: 'ERNESTO' },
  'laboratorios naturales bio': { usuario: 'naturales bionatural', etiqueta: 'ERNESTO' }
};

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

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 20, 1), 500);

  // Indice inverso: id de usuario -> nombre esperado
  const nombrePorId = new Map(Object.values(PALACIOS_USERS).map(u => [u.id, u.name]));

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

      // 1) Se detecta la fanpage por la etiqueta que dejo el router.
      let slugFanpage = null;
      for (const [, tag] of Object.entries(PAGE_TAG_MAP)) {
        if (tags.includes(String(tag).toLowerCase())) { slugFanpage = String(tag).toLowerCase(); break; }
      }

      if (!slugFanpage) { sinFanpage++; continue; }
      conFanpage++;

      const regla = REGLA_PROPIETARIO[slugFanpage];
      if (!regla) continue; // fanpage de otra sede: fuera del alcance de esta regla

      const esperado = PALACIOS_USERS[regla.usuario];
      const asignadoNombre = nombrePorId.get(c.assignedTo) || null;

      if (!c.assignedTo) {
        sinPropietario++;
        desajustes.push({
          contactoId: c.id,
          nombre: c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          fanpage: slugFanpage,
          esperado: esperado?.name || regla.etiqueta,
          actual: '(sin propietario)',
          motivo: 'contacto con fanpage conocida pero SIN propietario'
        });
        continue;
      }

      if (c.assignedTo === esperado?.id) { correctos++; continue; }

      // Fallo de ruteo: la fanpage manda a un propietario y esta asignado otro.
      malDelegados++;
      if (desajustes.length < 100) {
        desajustes.push({
          contactoId: c.id,
          nombre: c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          fanpage: slugFanpage,
          esperado: esperado?.name || regla.etiqueta,
          actual: asignadoNombre || c.assignedTo,
          motivo: `la fanpage "${slugFanpage}" exige ${regla.etiqueta}`
        });
      }
    }

    const cursor = d?.meta?.startAfter;
    url = cursor ? `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100&startAfter=${cursor}` : null;
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
