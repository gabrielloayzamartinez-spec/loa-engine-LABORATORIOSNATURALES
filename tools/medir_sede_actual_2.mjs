/**
 * Compradores y contactos contados por SEDE ACTUAL (cf_3590) vs sede original (cf_3451),
 * y % de registros antiguos sin oficina actual.
 * SOLO LECTURA.
 */
import 'dotenv/config';
import { query, VTIGER_FIELDS } from '../src/services/vtigerClient.js';

const SEDES = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function contar(where) {
  try {
    const r = await query(`SELECT COUNT(*) FROM Contacts WHERE ${where};`, { context: 'sede-actual-2', allowAggregate: true });
    return parseInt(r?.[0]?.count || '0', 10);
  } catch { return null; }
}

const filas = [];
for (const sede of SEDES) {
  filas.push({
    sede,
    'compradores x ORIGINAL': await contar(`${VTIGER_FIELDS.SEDE} = '${sede}' AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0`),
    'compradores x ACTUAL': await contar(`${VTIGER_FIELDS.SEDE_ACTUAL} = '${sede}' AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0`),
    'contactos x ACTUAL': await contar(`${VTIGER_FIELDS.SEDE_ACTUAL} = '${sede}' AND ${VTIGER_FIELDS.NUM_COMPRAS} = 0`)
  });
  await sleep(200);
}
console.table(filas);

// ¿Los registros ANTIGUOS tienen oficina actual? (muestra por año)
console.log('\n=== Muestra: % sin oficina actual, por año (Palacios, 100 por año) ===');
for (const ano of [2019, 2020, 2021, 2022, 2023]) {
  try {
    const filasAno = await query(
      `SELECT id, cf_3451, cf_3590 FROM Contacts
        WHERE ${VTIGER_FIELDS.SEDE} = 'PALACIOS'
          AND createdtime >= '${ano}-01-01' AND createdtime < '${ano + 1}-01-01'
        ORDER BY id DESC LIMIT 100;`,
      { context: 'sede-actual-anos' }
    ) || [];
    const vacios = filasAno.filter(f => !String(f.cf_3590 || '').trim()).length;
    console.log(`${ano}: ${vacios}/100 sin oficina actual (${vacios}%)`);
  } catch (e) { console.log(`${ano}: ERROR ${e.message}`); }
  await sleep(150);
}
process.exit(0);
