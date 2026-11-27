/**
 * ¿Cuántos contactos tienen Oficina Actual (cf_3590) y cuántos fueron reasignados?
 * SOLO LECTURA.
 *
 * NOTA: vTiger rechaza comparar un campo contra cadena vacía en un COUNT
 * ("Unknown Error while processing request"), así que el % de vacíos se mide en
 * una MUESTRA y se extrapola.
 */
import 'dotenv/config';
import { query, VTIGER_FIELDS } from '../src/services/vtigerClient.js';

const SEDES = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function contar(where) {
  try {
    const r = await query(`SELECT COUNT(*) FROM Contacts WHERE ${where};`, { context: 'sede-actual', allowAggregate: true });
    return parseInt(r?.[0]?.count || '0', 10);
  } catch { return null; }
}

const filas = [];
for (const sede of SEDES) {
  const total = await contar(`${VTIGER_FIELDS.SEDE} = '${sede}'`);
  const actualEnSede = await contar(`${VTIGER_FIELDS.SEDE_ACTUAL} = '${sede}'`);
  const interseccion = await contar(`${VTIGER_FIELDS.SEDE} = '${sede}' AND ${VTIGER_FIELDS.SEDE_ACTUAL} = '${sede}'`);

  // Muestra: % sin oficina actual y % reasignado a otra sede.
  let muestra = [];
  try {
    muestra = await query(
      `SELECT id, cf_3451, cf_3590 FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${sede}' ORDER BY id DESC LIMIT 200;`,
      { context: 'sede-actual-muestra' }
    ) || [];
  } catch { muestra = []; }

  let vacios = 0, otras = 0;
  for (const m of muestra) {
    const actual = String(m.cf_3590 || '').trim().toUpperCase();
    if (!actual) vacios++;
    else if (actual !== sede) otras++;
  }
  const pctVacios = muestra.length ? vacios / muestra.length : 0;
  const sinActual = total != null ? Math.round(total * pctVacios) : null;
  const reasignadosFuera = (total != null && interseccion != null && sinActual != null)
    ? Math.max(0, total - interseccion - sinActual)
    : null;

  filas.push({
    sede,
    'total (cf_3451)': total,
    'oficina actual = sede': actualEnSede,
    'intersección': interseccion,
    'muestra': muestra.length,
    'sin actual %': Math.round(pctVacios * 1000) / 10,
    'sin actual (est.)': sinActual,
    'reasignados a otra sede': reasignadosFuera
  });
  await sleep(200);
}

console.table(filas);
process.exit(0);
