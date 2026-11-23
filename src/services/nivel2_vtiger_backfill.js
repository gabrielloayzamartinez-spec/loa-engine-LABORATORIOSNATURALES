/**
 * Nivel 2 — Backfills vTiger -> GHL ONE-SHOT (servidor).
 * Modos:
 *   - 'fecha'              : DATE 'Fecha Creacion (Fecha)' para 2019-2025 (createdtime)
 *   - 'ultima_interaccion' : DATE 'Ultima Interaccion (Fecha)' (modifiedtime)
 * Una sola vida: offset por sede, al llegar al final (meta) muere.
 */
import { query as vtigerQuery, VTIGER_FIELDS } from './vtigerClient.js';
import { getActiveSedes, getGhlHeaders } from '../config/index.js';
import { ghlFetch } from '../utils/ghl_http_client.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

const FIELD_ID_FECHA = {
  '5NqOaPYqWyIw2FPBfoRg': 'BjRhSD5vPaQzLAzS8DSD',   // Palacios
  'QXcNBK6XCgpQaZ81Z8pv': '16K68thlRzHVmCszqTtG',   // Benavides
  'SETlaGKhBpbqfBSzzpIB': 'VjLfeS7UdCv8XUeqkeeT',   // Roosevelt
  '9J4pKs5f7OcaokdhyurW': '6QhWVxjRsDFCJwpl8jDv',   // Piura
};
const FIELD_ID_ULTIMA = {
  '5NqOaPYqWyIw2FPBfoRg': 'l7k03GV4Duq4yTNdgAji',
  'QXcNBK6XCgpQaZ81Z8pv': '9HJTBkmutURRa3zCpZIw',
  'SETlaGKhBpbqfBSzzpIB': 'ww9eLqAYSsACNGiSEw5W',
  '9J4pKs5f7OcaokdhyurW': '1rETT0jIdVpihwWZ12Fd',
};

let cursorOffset = new Map(); // locId -> offset en vTiger
let terminadoGlobal = false;

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

async function upsertFecha(locId, phone, fecha, fieldId) {
  const headers = getGhlHeaders({ locationId: locId });
  const gh = { ...headers, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };
  const r = await ghlFetch(`${GHL_BASE}/contacts/upsert`, {
    method: 'POST', headers: gh,
    body: JSON.stringify({ locationId: locId, phone, customFields: [{ id: fieldId, value: fecha }] })
  }, 1, 'Nivel2-VtigerBackfill');
  return (r.status === 200 || r.status === 201);
}

/**
 * @param {{ modo: 'fecha'|'ultima_interaccion', anoDesde?: number, anoHasta?: number, rate?: number, lotes?: number }} opts
 */
export async function runVtigerBackfill({ modo = 'fecha', anoDesde = 2019, anoHasta = 2025, rate = 6, lotes = 20 } = {}) {
  const sedes = getActiveSedes().filter(s => !s.isPaused && s.ghl?.locationId);
  const fieldMap = modo === 'fecha' ? FIELD_ID_FECHA : FIELD_ID_ULTIMA;
  const vtField = modo === 'fecha' ? VTIGER_FIELDS.CREATED_TIME : VTIGER_FIELDS.MODIFIED_TIME;
  const counters = { total: 0, ok: 0, skip: 0, fail: 0 };
  const progreso = [];

  for (const sede of sedes) {
    const locId = sede.ghl.locationId;
    const fieldId = fieldMap[locId];
    if (!fieldId) { progreso.push({ sede: sede.name, locId, error: 'sin field id' }); continue; }

    let offset = cursorOffset.get(locId) || 0;
    let filas = 0;
    let lotesHechos = 0;
    let sedeTerminada = false;

    while (lotesHechos < lotes) {
      let where;
      if (modo === 'fecha') {
        where = `cf_3590 = '${sede.name}' AND createdtime >= '${anoDesde}-01-01' AND createdtime < '${anoHasta + 1}-01-01'`;
      } else {
        where = `cf_3590 = '${sede.name}'`;
      }
      const q = `SELECT id, phone, mobile, homephone, ${vtField} FROM Contacts WHERE ${where} LIMIT ${offset}, 100;`;
      const rows = await vtigerQuery(q, { context: 'nivel2-vtiger-backfill' }) || [];
      if (!rows.length) { sedeTerminada = true; break; }

      for (const x of rows) {
        counters.total++;
        const phone = normPhone(x.phone, x.mobile, x.homephone);
        const fecha = String(x[vtField] || '').slice(0, 10);
        if (!phone || !fecha || fecha.length < 10) { counters.skip++; continue; }
        const ok = await upsertFecha(locId, phone, fecha, fieldId);
        if (ok) counters.ok++; else counters.fail++;
        await new Promise(r => setTimeout(r, Math.round(1000 / rate)));
      }
      offset += rows.length;
      filas += rows.length;
      lotesHechos++;
      if (rows.length < 100) { sedeTerminada = true; break; }
    }

    if (sedeTerminada) {
      cursorOffset.delete(locId);
      progreso.push({ sede: sede.name, locId, terminada: true, procesadas: filas });
    } else {
      cursorOffset.set(locId, offset);
      progreso.push({ sede: sede.name, locId, pendiente: true, offset, procesadas: filas });
    }
  }

  terminadoGlobal = sedes.length > 0 && sedes.every(s => !cursorOffset.has(s.ghl.locationId));
  if (terminadoGlobal) cursorOffset.clear();

  return {
    oneShot: true,
    modo,
    terminado: terminadoGlobal,
    counters,
    sedes: progreso,
    mensaje: terminadoGlobal ? 'META ALCANZADA: backfill completo. El proceso murió.' : 'Pasada parcial: queda pendiente.'
  };
}

export function getVtigerBackfillState() {
  return { terminado: terminadoGlobal, cursorOffset: Object.fromEntries(cursorOffset) };
}
