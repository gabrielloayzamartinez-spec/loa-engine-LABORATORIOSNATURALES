/**
 * Mapea DÓNDE están los huecos: muestrea varios puntos del año y dice, en cada uno,
 * cuántos de los contactos están en GHL. Así se ve si el faltante es un bloque
 * (ids consecutivos que se saltaron) o está repartido.
 *
 * SOLO LECTURA. node tools/mapear_huecos.mjs PALACIOS 2023 contactos
 */
import 'dotenv/config';
import { query, VTIGER_FIELDS } from '../src/services/vtigerClient.js';
import { SEDES_GATEWAY } from '../src/config/index.js';

const SEDE = (process.argv[2] || 'PALACIOS').toUpperCase();
const ANO = parseInt(process.argv[3] || '2023', 10);
const TIPO = (process.argv[4] || 'contactos').toLowerCase();
const BASE = 'https://services.leadconnectorhq.com';
const N = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digitos = v => String(v || '').replace(/\D/g, '');

const loc = SEDES_GATEWAY[SEDE].ghl.locationId;
const h = { Authorization: `Bearer ${SEDES_GATEWAY[SEDE].ghl.apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
const filtroTipo = TIPO === 'contactos' ? ` AND ${VTIGER_FIELDS.NUM_COMPRAS} = 0` : ` AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0`;
const rango = ` AND ${VTIGER_FIELDS.CREATED_TIME} >= '${ANO}-01-01' AND ${VTIGER_FIELDS.CREATED_TIME} < '${ANO + 1}-01-01'`;

const r = await query(`SELECT COUNT(*) FROM Contacts WHERE ${VTIGER_FIELDS.SEDE_ACTUAL} = '${SEDE}'${filtroTipo}${rango};`, { context: 'mapa', allowAggregate: true });
const total = parseInt(r?.[0]?.count || '0', 10);
console.log(`${SEDE} ${ANO} ${TIPO}: total ${total}`);

const puntos = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.98].map(p => Math.max(0, Math.floor(total * p) - Math.floor(N / 2)));
const filas = [];

for (const offset of puntos) {
  let muestra = [];
  try {
    muestra = await query(
      `SELECT id, firstname, lastname, homephone, mobile, phone, otherphone, createdtime
         FROM Contacts WHERE ${VTIGER_FIELDS.SEDE_ACTUAL} = '${SEDE}'${filtroTipo}${rango}
         ORDER BY id DESC LIMIT ${offset}, ${N};`,
      { context: 'mapa-muestra' }
    ) || [];
  } catch { continue; }
  if (!muestra.length) continue;

  let ok = 0, revisados = 0;
  for (const f of muestra) {
    const teles = [f.homephone, f.mobile, f.phone, f.otherphone].map(digitos).filter(d => d.length >= 10);
    if (!teles.length) continue;
    revisados++;
    let hallado = false;
    for (const t of teles) {
      const last10 = t.slice(-10);
      try {
        const resp = await fetch(`${BASE}/contacts/?locationId=${loc}&query=${last10}`, { headers: h });
        if (resp.status === 429) { await sleep(1200); continue; }
        const d = await resp.json();
        if ((d.contacts || []).some(c => digitos(c.phone).endsWith(last10))) { hallado = true; break; }
      } catch { /* reintento abajo */ }
      await sleep(120);
    }
    if (hallado) ok++;
    await sleep(120);
  }
  const pct = revisados ? Math.round(ok / revisados * 100) : 0;
  filas.push({
    posicion: `${Math.round(offset / total * 100)}%`,
    offset,
    idMuestra: muestra[0]?.id,
    fecha: String(muestra[0]?.createdtime || '').slice(0, 10),
    enGhl: `${ok}/${revisados}`,
    pct
  });
  console.log(`  offset ${String(offset).padStart(6)} (${Math.round(offset / total * 100)}%) id≈${muestra[0]?.id} ${String(muestra[0]?.createdtime || '').slice(0, 10)} -> ${ok}/${revisados} (${pct}%)`);
}

console.table(filas);
process.exit(0);
