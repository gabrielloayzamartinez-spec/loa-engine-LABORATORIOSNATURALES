/**
 * ¿Cuántos contactos DISTINTOS cambian por día en vTiger? (para dimensionar el N3)
 * SOLO LECTURA.
 */
import 'dotenv/config';
import { query, VTIGER_FIELDS } from '../src/services/vtigerClient.js';

const SEDES = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function intentar(q) {
  try {
    const r = await query(q, { context: 'delta', allowAggregate: true });
    return r?.[0] || null;
  } catch (e) { return { error: e.message }; }
}

const filas = [];
for (const sede of SEDES) {
  const base = `${VTIGER_FIELDS.SEDE_ACTUAL} = '${sede}' AND modifiedtime >= '2026-11-26 00:00:00'`;
  const total = await intentar(`SELECT COUNT(*) FROM Contacts WHERE ${base};`);
  const distintos = await intentar(`SELECT COUNT(DISTINCT id) FROM Contacts WHERE ${base};`);
  const compradores = await intentar(`SELECT COUNT(*) FROM Contacts WHERE ${base} AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0;`);
  filas.push({
    sede,
    'cambios 24h': total?.count ?? total?.error ?? '?',
    'contactos distintos': distintos?.count ?? distintos?.error ?? '?',
    'de ellos compradores': compradores?.count ?? compradores?.error ?? '?'
  });
  await sleep(200);
}
console.table(filas);
process.exit(0);
