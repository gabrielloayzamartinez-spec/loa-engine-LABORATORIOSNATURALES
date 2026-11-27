/**
 * Nivel 2 — Leads Roosevelt/Piura (ONE-SHOT, servidor).
 * Sincroniza los leads (spl_num_compras=0) de Roosevelt y Piura con CF completos + tags.
 * Una sola vida: offset por sede, al llegar al final (meta) muere.
 */
import { query as vtigerQuery } from './vtigerClient.js';
import { getActiveSedes, getGhlHeaders } from '../config/index.js';
import { ghlFetch } from '../utils/ghl_http_client.js';
import { loadCursor, saveCursor } from './nivel2_cursor.js';
import { aplicarContratoEtiquetas, etiquetaCanal, etiquetaProveedor, etiquetaProducto, etiquetaSede, TAGS_ESTADO } from '../domain/ghl_tags.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

const CF_ROOSEVELT = {
  sedeAsignada: 'KBUlOyRjKdqcImITke04', sedeTienda: 'KKh2nhNI5UJTuU8wjAHI',
  totalCompras: 'LBOlg2GtJpXoXpTWZL4t', estadoComercial: 'm739AIOt9N68vnhpkhYR',
  proveedor: 'XUqgxuqFtAcX2IE3F08l', canalCaptacion: 'sxtuDddHtxozxIV8BbvU',
  origenLead: 'ucL1d15KakFeVmhbTOE3', tratamientoComprado: 'rNlnU2z3tEwUNph62WOR',
  sexo: 'tD14mdnqUXRRQLN2dtyB', etapaComercial: 'JOGD8uaVRBpiM4K5aAD0',
  contactNo: 'YPVYFic5eDYHCTYiaxqC', idCliente: 'DCKKghiLJxf1j8VDdEqw',
  fechaCreacion: 'bI11b8hBWHR7KU4oytmv', fechaCreacionFecha: 'VjLfeS7UdCv8XUeqkeeT',
  asesorAsignado: '19WtCElkOTS5V7CFyLXf', tieneTelefono: 'BrOT8hmvMV08Dt9Gbplb',
};
const CF_PIURA = {
  sedeAsignada: 'vraGzEs3y5rUou5YRarl', sedeTienda: 'miUGB926PE84NVWfSaxh',
  totalCompras: 'zm1kBzn0jmFKFeAXokBF', estadoComercial: '6BsZGGtezrVxXmpATYQx',
  proveedor: 'QxG9DCliGUcB5h5jMRjq', canalCaptacion: 'a07aFbSn2NQ94QCKwqbW',
  origenLead: '447BH1pTVmLB9YEFHh5o', tratamientoComprado: 'GxZzHJNzrT6qH1q1mWcx',
  sexo: '5ZcLFoujnVysSgVH7ZY6', etapaComercial: 'siTFWfxLySIOYzIUoqDT',
  contactNo: 'au9RSRYnZ8WMWdZci6qb', idCliente: 'hknMZOz0F3egUdUNoKFG',
  fechaCreacion: 'rQ7FhIKSCfmlE0YcAm8j', fechaCreacionFecha: '6QhWVxjRsDFCJwpl8jDv',
  asesorAsignado: 'NZE3uT3xOcwLkuJGykRw', tieneTelefono: 'EznP2kUQGm9agUpufvtW',
};

// [AUDITORÍA 27/11] Los mapas PROV_MAP / CANAL_MAP / slug() se eliminaron: el
// vocabulario vive en el contrato único (domain/ghl_tags.js). Duplicarlo aquí era
// la causa de que un mismo canal se etiquetara distinto según el proceso.

let cursorOffset = loadCursor('leads_rp');
let terminadoGlobal = false;

function v(x) { const s = String(x || '').trim(); return (s && !['none', 'null'].includes(s.toLowerCase())) ? s : ''; }
function normPhone(...raws) {
  for (const r of raws) {
    if (!r) continue;
    const d = String(r).replace(/\D/g, '');
    if (d.length === 10 && '23456789'.includes(d[0])) return '+1' + d;
    if (d.length === 11 && d.startsWith('1')) return '+' + d;
    if (d.length >= 10 && d.length <= 15) return '+' + d;
  }
  return null;
}
/**
 * [AUDITORÍA 27/11 — CONTRATO ÚNICO] Antes esta función devolvía
 * `['vtiger','vtiger-sincronizado','prospecto-vtiger', ...]`: las dos primeras son
 * RUIDO declarado (el Nivel 1 las purga) y provocaban que el mismo contacto
 * tuviera etiquetas que se contradecían con el router. Ahora se construyen con el
 * contrato: canal/proveedor/producto/sede canónicos + estado de prospecto.
 */
function tagsFor(rec, sede) {
  const { tags } = aplicarContratoEtiquetas({
    actuales: [],
    canal: etiquetaCanal(rec.cf_3507),
    proveedor: etiquetaProveedor(rec.cf_2572),
    sede: etiquetaSede(sede),
    producto: etiquetaProducto(rec.cf_2610),
    agregar: [TAGS_ESTADO.PROSPECTO]
  });
  return tags;
}
function buildCf(cfd, rec, sede) {
  const cf = [
    { id: cfd.sedeAsignada, value: sede },
    { id: cfd.sedeTienda, value: sede },
    { id: cfd.totalCompras, value: '0' },
    { id: cfd.estadoComercial, value: v(rec.cf_1876) || 'SIN VENTA' },
    { id: cfd.tieneTelefono, value: 'Sí' },
  ];
  const ct = v(rec.createdtime);
  if (ct) { cf.push({ id: cfd.fechaCreacion, value: ct.slice(0, 10) }); cf.push({ id: cfd.fechaCreacionFecha, value: ct.slice(0, 10) }); }
  if (v(rec.cf_2821)) cf.push({ id: cfd.sexo, value: v(rec.cf_2821) });
  if (v(rec.cf_994)) cf.push({ id: cfd.etapaComercial, value: v(rec.cf_994) });
  if (v(rec.contact_no)) cf.push({ id: cfd.contactNo, value: v(rec.contact_no) });
  if (v(rec.id)) cf.push({ id: cfd.idCliente, value: v(rec.id) });
  if (v(rec.wcf_acf_atf_3390)) cf.push({ id: cfd.asesorAsignado, value: v(rec.wcf_acf_atf_3390) });
  if (v(rec.cf_2572)) cf.push({ id: cfd.proveedor, value: v(rec.cf_2572) });
  if (v(rec.cf_3507)) cf.push({ id: cfd.canalCaptacion, value: v(rec.cf_3507) });
  if (v(rec.cf_2610)) cf.push({ id: cfd.tratamientoComprado, value: v(rec.cf_2610) });
  if (v(rec.cf_3472)) cf.push({ id: cfd.origenLead, value: v(rec.cf_3472) });
  return cf;
}

const SELECT = 'id, firstname, lastname, phone, mobile, homephone, cf_3590, cf_1876, cf_2572, cf_3507, cf_2610, cf_2821, cf_994, cf_3472, contact_no, createdtime, wcf_acf_atf_3390';

export async function runLeadsRp({ rate = 6, lotes = 15 } = {}) {
  const sedes = getActiveSedes().filter(s => ['ROOSEVELT', 'PIURA'].includes(s.vtigerSedeName || s.sedeId) && s.ghl?.locationId);
  const cfMap = { ROOSEVELT: CF_ROOSEVELT, PIURA: CF_PIURA };
  const counters = { total: 0, ok: 0, skip: 0, fail: 0 };
  const progreso = [];

  await Promise.all(sedes.map(async (sede) => {
    const locId = sede.ghl.locationId;
    const code = sede.vtigerSedeName || sede.sedeId;
    const cfd = cfMap[code];
    if (!cfd) { progreso.push({ sede: sede.name, error: 'sin field ids' }); return; }
    const headers = getGhlHeaders({ locationId: locId });
    let offset = cursorOffset.get(locId) || 0;
    let filas = 0, lotesHechos = 0, sedeTerminada = false;

    while (lotesHechos < lotes) {
      const q = `SELECT ${SELECT} FROM Contacts WHERE cf_3451 = '${code}' AND spl_num_compras = '0' LIMIT ${offset}, 100;`;
      const rows = await vtigerQuery(q, { context: 'nivel2-leads-rp' }) || [];
      if (!rows.length) { sedeTerminada = true; break; }

      for (const rec of rows) {
        counters.total++;
        const phone = normPhone(rec.homephone, rec.mobile, rec.phone);
        if (!phone) { counters.skip++; continue; }
        const nombre = `${rec.firstname || ''} ${rec.lastname || ''}`.trim();
        const parts = nombre.split(' ');
        const gh = { ...headers, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };
        const payload = {
          locationId: locId, phone,
          firstName: parts[0] || '', lastName: parts.slice(1).join(' '),
          customFields: buildCf(cfd, rec, code)
          // [AUDITORÍA 27/11] `tags` se retiró del cuerpo del upsert: GHL reemplaza
          // la lista y este job habría borrado `meta-ads`/`canal-messenger` de los
          // leads que también entraron por Meta (Nivel 1). Ahora se AÑADEN con el
          // endpoint aditivo /contacts/{id}/tags.
        };
        const r = await ghlFetch(`${GHL_BASE}/contacts/upsert`, { method: 'POST', headers: gh, body: JSON.stringify(payload) }, 1, 'Nivel2-LeadsRP');
        if (r.status === 200 || r.status === 201) {
          counters.ok++;
          const data = await r.json().catch(() => ({}));
          const contactId = data?.contact?.id || data?.id || null;
          const tags = tagsFor(rec, code);
          if (contactId && tags.length) {
            await new Promise(res => setTimeout(res, 120));
            const rt = await ghlFetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
              method: 'POST', headers: gh, body: JSON.stringify({ tags })
            }, 1, 'Nivel2-LeadsRP');
            if (rt.status !== 200 && rt.status !== 201) counters.fail++;
          }
        } else {
          counters.fail++;
        }
        await new Promise(res => setTimeout(res, Math.round(1000 / rate)));
      }
      offset += rows.length;
      filas += rows.length;
      lotesHechos++;
      if (rows.length < 100) { sedeTerminada = true; break; }
    }

    // [AUDITORÍA 27/11 — ORDEN DE PERSISTENCIA] Se muta el Map ANTES de guardar:
    // antes el archivo quedaba con el offset anterior y un reinicio rebobinaba el job.
    if (sedeTerminada) {
      cursorOffset.delete(locId);
      saveCursor('leads_rp', cursorOffset);
      progreso.push({ sede: sede.name, locId, terminada: true, procesadas: filas });
    } else {
      cursorOffset.set(locId, offset);
      saveCursor('leads_rp', cursorOffset);
      progreso.push({ sede: sede.name, locId, pendiente: true, offset, procesadas: filas });
    }
  }));


  terminadoGlobal = sedes.length > 0 && sedes.every(s => !cursorOffset.has(s.ghl.locationId));
  // [AUDITORÍA 27/11 — BUG DE CURSOR] Mismo defecto que en retag/backfill: el
  // `clear()` sin llaves borraba el offset tras CUALQUIER pasada parcial.
  if (terminadoGlobal) {
    saveCursor('leads_rp', cursorOffset);
    cursorOffset.clear();
  }

  return {
    oneShot: true, terminado: terminadoGlobal, counters, sedes: progreso,
    mensaje: terminadoGlobal ? 'META ALCANZADA: leads Roosevelt/Piura completos. Proceso muerto.' : 'Pasada parcial.'
  };
}

export function getLeadsRpState() {
  return { terminado: terminadoGlobal, cursorOffset: Object.fromEntries(cursorOffset) };
}
