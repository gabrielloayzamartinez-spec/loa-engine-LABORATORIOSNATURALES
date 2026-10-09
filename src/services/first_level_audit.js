/**
 * ==============================================================================
 * AUDITORÍA DE PRIMER NIVEL — DE ESQUINA A ESQUINA
 * ==============================================================================
 * OBJETIVO (pedido del usuario)
 * "El trabajo de primer nivel necesita tener una auditoría de esquina a esquina."
 * No basta con revisar UNA cosa: hay que verificar, contacto por contacto, TODAS
 * las dimensiones que hacen que el primer nivel esté completo y actualizado.
 *
 * LAS 7 DIMENSIONES QUE SE AUDITAN
 *   1. PROPIETARIO    -> el lead tiene dueño asignado.
 *   2. REGLA DE PÁGINA-> ese dueño corresponde a la fanpage por la que escribió.
 *   3. AD ID          -> el ID del anuncio está capturado (la fuga reportada).
 *   4. CAMPAÑA/ANUNCIO-> campaña, conjunto y nombre del anuncio poblados.
 *   5. UTM            -> los UTM del día presentes.
 *   6. INTERACCIÓN    -> "Ultima Interaccion" con fecha.
 *   7. RECENCIA       -> la última interacción es de HOY (dato del día).
 *
 * SALIDA
 *   · Cobertura por dimensión (cuántos de los N cumplen).
 *   · Los huecos concretos (con el nombre y el motivo de cada uno).
 *   · Un veredicto único de salud del primer nivel (0-100).
 *
 * Es SOLO LECTURA: no modifica nada.
 * ==============================================================================
 */

import { ghlFetch } from '../utils/ghl_http_client.js';
import { SEDES_GATEWAY, PALACIOS_USERS } from '../config/index.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slugificar = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** Indice: slug de fanpage -> asesor esperado (derivado de la config). */
function construirReglas() {
  const porSlug = new Map();
  for (const sede of Object.values(SEDES_GATEWAY)) {
    for (const usuario of Object.values(sede?.users || {})) {
      if (!usuario?.id) continue;
      for (const nombrePagina of (usuario.pages || [])) {
        porSlug.set(slugificar(nombrePagina), { id: usuario.id, name: usuario.name });
      }
    }
  }
  for (const usuario of Object.values(PALACIOS_USERS)) {
    if (!usuario?.id) continue;
    for (const nombrePagina of (usuario.pages || [])) {
      const slug = slugificar(nombrePagina);
      if (!porSlug.has(slug)) porSlug.set(slug, { id: usuario.id, name: usuario.name });
    }
  }
  return porSlug;
}

/** Lee un campo personalizado del contacto por nombre (tolerante a variantes). */
function campo(c, ...nombres) {
  const lista = c.customFields || [];
  for (const n of nombres) {
    const f = lista.find(x => String(x.name || '').toLowerCase() === n.toLowerCase());
    if (f) {
      const v = f.value ?? f.field_value;
      if (Array.isArray(v)) return v.join(', ');
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return null;
}

/** Primer día del rango: medianoche de hoy en Lima (UTC-5, sin horario de verano). */
function inicioDiaLima() {
  const ahora = new Date();
  const lima = new Date(ahora.getTime() - 5 * 3600 * 1000);
  return Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate()) + 5 * 3600 * 1000;
}

/**
 * Audita de esquina a esquina el primer nivel de una sede.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede='PALACIOS']
 * @param {number} [opts.paginas=10] páginas de 100 contactos (tope 200)
 * @param {boolean} [opts.soloRecientes=true] auditar solo contactos con actividad de hoy
 */
export async function auditarPrimerNivel({ sede = 'PALACIOS', paginas = 10, soloRecientes = true } = {}) {
  const sedeId = String(sede).toUpperCase();
  const cfg = SEDES_GATEWAY[sedeId];
  const locId = cfg?.ghl?.locationId;
  const apiKey = cfg?.ghl?.apiKey;
  if (!locId || !apiKey) return { ok: false, reason: `Sede ${sedeId} sin credenciales cargadas` };

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 10, 1), 200);
  const desde = inicioDiaLima();
  const porSlug = construirReglas();

  const totales = { conPropietario: 0, reglaOk: 0, conAdId: 0, conCampana: 0, conUtm: 0, conInteraccion: 0, deHoy: 0 };
  const huecos = { sinPropietario: [], reglaViolada: [], sinAdId: [], sinCampana: [], sinUtm: [], sinInteraccion: [], noEsDeHoy: [] };
  let auditados = 0;
  let elegibles = 0;

  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100&sortBy=date_updated`;
  for (let p = 0; p < limitePaginas && url; p++) {
    const r = await ghlFetch(url, { headers }, 1, 'Auditoria-N1');
    if (r.status !== 200) break;
    const d = await r.json();
    const contactos = d?.contacts || [];
    if (contactos.length === 0) break;

    for (const c of contactos) {
      const fechaAct = new Date(c.dateUpdated || c.dateAdded || 0).getTime();
      const esDeHoy = fechaAct >= desde;
      // Con soloRecientes se audita la operación del día (que es lo accionable);
      // el histórico se audita aparte con soloRecientes=false.
      if (soloRecientes && !esDeHoy) continue;

      elegibles++;
      auditados++;
      const nombre = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.id;
      const tags = (c.tags || []).map(t => String(t).toLowerCase().trim());

      // 1. PROPIETARIO
      const tienePropietario = Boolean(c.assignedTo);
      if (tienePropietario) totales.conPropietario++;
      else huecos.sinPropietario.push({ id: c.id, nombre, motivo: 'lead sin dueño asignado' });

      // 2. REGLA DE PÁGINA
      let slugFanpage = null;
      for (const slug of porSlug.keys()) if (tags.includes(slug)) { slugFanpage = slug; break; }
      if (slugFanpage) {
        const esperado = porSlug.get(slugFanpage);
        if (tienePropietario && c.assignedTo === esperado.id) totales.reglaOk++;
        else if (tienePropietario) {
          huecos.reglaViolada.push({ id: c.id, nombre, fanpage: slugFanpage, esperado: esperado.name, real: c.assignedTo, motivo: 'la fanpage exige otro propietario' });
        } else {
          huecos.reglaViolada.push({ id: c.id, nombre, fanpage: slugFanpage, esperado: esperado.name, real: null, motivo: 'sin dueño: la regla exige uno' });
        }
      } else {
        // Sin fanpage conocida no se puede juzgar la regla: se cuenta como no aplicable.
        totales.reglaOk++;
      }

      // 3. AD ID
      const adId = campo(c, 'ID de Anuncio', 'Ad ID');
      if (adId) totales.conAdId++;
      else huecos.sinAdId.push({ id: c.id, nombre, fuenteAtribucion: c.attributionSource?.sessionSource || null, motivo: 'sin ID de Anuncio capturado' });

      // 4. CAMPAÑA / ANUNCIO
      const campana = campo(c, 'Campaña Meta', 'UTM Campaign');
      const anuncio = campo(c, 'Nombre del Anuncio', 'UTM Content');
      if (campana || anuncio) totales.conCampana++;
      else huecos.sinCampana.push({ id: c.id, nombre, motivo: 'sin campaña ni nombre de anuncio' });

      // 5. UTM
      const utm = campo(c, 'UTM Medium', 'UTM Source');
      if (utm) totales.conUtm++;
      else huecos.sinUtm.push({ id: c.id, nombre, motivo: 'sin UTM' });

      // 6. INTERACCIÓN
      const interaccion = campo(c, 'Ultima Interaccion');
      if (interaccion) totales.conInteraccion++;
      else huecos.sinInteraccion.push({ id: c.id, nombre, motivo: 'sin Ultima Interaccion' });

      // 7. RECENCIA (el dato del día)
      if (esDeHoy) totales.deHoy++;
      else huecos.noEsDeHoy.push({ id: c.id, nombre, fechaActualizacion: c.dateUpdated || null, motivo: 'su última actividad no es de hoy' });
    }

    url = d?.meta?.nextPageUrl || null;
    await sleep(80);
  }

  const pct = n => (elegibles ? Math.round((n / elegibles) * 1000) / 10 : 0);
  const cobertura = {
    propietario: pct(totales.conPropietario),
    reglaPagina: pct(totales.reglaOk),
    adId: pct(totales.conAdId),
    campanaAnuncio: pct(totales.conCampana),
    utm: pct(totales.conUtm),
    interaccion: pct(totales.conInteraccion),
    datoDelDia: pct(totales.deHoy)
  };

  // Salud global: promedio de las dimensiones críticas del primer nivel.
  const criticas = [cobertura.propietario, cobertura.reglaPagina, cobertura.adId, cobertura.campanaAnuncio, cobertura.interaccion, cobertura.datoDelDia];
  const salud = Math.round(criticas.reduce((a, b) => a + b, 0) / criticas.length);

  return {
    ok: true,
    sede: sedeId,
    ventana: soloRecientes ? 'solo contactos con actividad de HOY (Lima)' : 'todos los contactos escaneados',
    auditados: elegibles,
    cobertura,
    saludPrimerNivel: salud,
    veredicto: salud >= 95 ? '🟢 EXCELENTE' : salud >= 85 ? '🟡 ACEPTABLE' : salud >= 70 ? '🟠 CON HUECOS' : '🔴 CRITICO',
    conteos: totales,
    huecos: {
      sinPropietario: huecos.sinPropietario.slice(0, 25),
      reglaViolada: huecos.reglaViolada.slice(0, 25),
      sinAdId: huecos.sinAdId.slice(0, 25),
      sinCampana: huecos.sinCampana.slice(0, 25),
      sinUtm: huecos.sinUtm.slice(0, 25),
      sinInteraccion: huecos.sinInteraccion.slice(0, 25)
    },
    tamanosHuecos: {
      sinPropietario: huecos.sinPropietario.length,
      reglaViolada: huecos.reglaViolada.length,
      sinAdId: huecos.sinAdId.length,
      sinCampana: huecos.sinCampana.length,
      sinUtm: huecos.sinUtm.length,
      sinInteraccion: huecos.sinInteraccion.length
    }
  };
}
