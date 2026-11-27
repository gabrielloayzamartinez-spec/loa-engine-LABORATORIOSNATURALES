/**
 * Mide el universo real: COMPRADORES vs CONTACTOS (leads sin compra) y cuántos
 * de esos contactos tienen teléfono (los únicos sincronizables: el teléfono es la
 * llave única del motor).
 *
 * SOLO LECTURA. node tools/medir_universo.mjs
 */
import 'dotenv/config';
import { query, VTIGER_FIELDS } from '../src/services/vtigerClient.js';

const SEDES = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];
const ANOS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function contar(where) {
  const r = await query(`SELECT COUNT(*) FROM Contacts WHERE ${where};`, { context: 'universo', allowAggregate: true });
  return parseInt(r?.[0]?.count || '0', 10);
}

const salida = [];
for (const sede of SEDES) {
  const base = `${VTIGER_FIELDS.SEDE} = '${sede}'`;
  const total = await contar(base);
  const compradores = await contar(`${base} AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0`);
  const leads = await contar(`${base} AND ${VTIGER_FIELDS.NUM_COMPRAS} = 0`);
  const cero = await contar(`${base} AND ${VTIGER_FIELDS.NUM_COMPRAS} = '0'`);

  // Muestra de leads: ¿cuántos tienen teléfono? (el teléfono es la llave del motor)
  const muestra = await query(
    `SELECT id, firstname, lastname, homephone, mobile, phone, otherphone, createdtime
       FROM Contacts WHERE ${base} AND ${VTIGER_FIELDS.NUM_COMPRAS} = 0
       ORDER BY id DESC LIMIT 100;`,
    { context: 'universo-muestra' }
  ) || [];

  let conTelefono = 0;
  for (const m of muestra) {
    const t = [m.homephone, m.mobile, m.phone, m.otherphone]
      .map(x => String(x || '').replace(/\D/g, ''))
      .filter(d => d.length >= 10);
    if (t.length) conTelefono++;
  }
  const pctTel = muestra.length ? Math.round((conTelefono / muestra.length) * 100) : 0;
  const leadsSincronizables = Math.round(leads * (pctTel / 100));

  salida.push({
    sede,
    total,
    compradores,
    leads,
    'leads con num=0 (texto)': cero,
    'muestra leads': muestra.length,
    'con teléfono': `${conTelefono}/${muestra.length} (${pctTel}%)`,
    'leads sincronizables (est.)': leadsSincronizables
  });
  await sleep(200);
}

console.table(salida);

const totalCompradores = salida.reduce((a, s) => a + s.compradores, 0);
const totalLeads = salida.reduce((a, s) => a + s.leads, 0);
const totalSincro = salida.reduce((a, s) => a + s['leads sincronizables (est.)'], 0);
console.log(`\n[GLOBAL] compradores=${totalCompradores} · leads=${totalLeads} · leads con teléfono (est.)=${totalSincro} · total a sincronizar≈${totalCompradores + totalSincro}`);

// Distribución por año de los CONTACTOS (leads) de Palacios, para planificar tandas.
console.log('\n=== PALACIOS — contactos (leads) por año ===');
const porAno = [];
for (const ano of ANOS) {
  const filtro = ` AND createdtime >= '${ano}-01-01' AND createdtime < '${ano + 1}-01-01'`;
  const n = await contar(`${VTIGER_FIELDS.SEDE} = 'PALACIOS' AND ${VTIGER_FIELDS.NUM_COMPRAS} = 0${filtro}`);
  porAno.push({ ano, leads: n });
  await sleep(150);
}
console.table(porAno);
process.exit(0);
