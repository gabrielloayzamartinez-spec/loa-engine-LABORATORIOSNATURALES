/**
 * COBERTURA REAL POR SUBCUENTA — ¿qué falta sincronizar en cada una?
 *
 * Para cada sede (por OFICINA ACTUAL, cf_3590) y cada año:
 *   · cuenta compradores y contactos,
 *   · muestrea la MITAD del año (donde está el hueco: la punta siempre está al día),
 *   · busca cada teléfono en la subcuenta de esa sede.
 *
 * SOLO LECTURA. Uso: node tools/cobertura_actual.mjs [muestra=20]
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { query, VTIGER_FIELDS } from '../src/services/vtigerClient.js';
import { SEDES_GATEWAY } from '../src/config/index.js';

const SEDES = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];
const ANOS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019];
const N = Math.max(5, parseInt(process.argv[2] || '20', 10));
const BASE = 'https://services.leadconnectorhq.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digitos = v => String(v || '').replace(/\D/g, '');

async function contar(where) {
  try {
    const r = await query(`SELECT COUNT(*) FROM Contacts WHERE ${where};`, { context: 'cobertura', allowAggregate: true });
    return parseInt(r?.[0]?.count || '0', 10);
  } catch { return 0; }
}

async function existe(loc, h, telefonos) {
  for (const d of telefonos) {
    const last10 = d.slice(-10);
    for (let intento = 0; intento < 2; intento++) {
      try {
        const r = await fetch(`${BASE}/contacts/?locationId=${loc}&query=${last10}`, { headers: h });
        if (!r.ok) break;
        const data = await r.json();
        if ((data.contacts || []).some(c => digitos(c.phone).endsWith(last10))) return true;
        break;
      } catch { await sleep(500); }
    }
    await sleep(90);
  }
  return false;
}

const salida = [];
for (const sede of SEDES) {
  const loc = SEDES_GATEWAY[sede]?.ghl?.locationId;
  const key = SEDES_GATEWAY[sede]?.ghl?.apiKey;
  if (!loc || !key) { console.log(`[SKIP] ${sede}: sin credenciales locales`); continue; }
  const h = { Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json' };

  console.log(`\n===== ${sede} =====`);
  let totComp = 0, totLeads = 0, faltanComp = 0, faltanLeads = 0;

  for (const ano of ANOS) {
    const rango = ` AND ${VTIGER_FIELDS.CREATED_TIME} >= '${ano}-01-01' AND ${VTIGER_FIELDS.CREATED_TIME} < '${ano + 1}-01-01'`;
    for (const [tipo, filtro] of [
      ['compradores', ` AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0`],
      ['contactos', ` AND ${VTIGER_FIELDS.NUM_COMPRAS} = 0`]
    ]) {
      const total = await contar(`${VTIGER_FIELDS.SEDE_ACTUAL} = '${sede}'${filtro}${rango}`);
      if (total === 0) continue;

      const offset = Math.max(0, Math.floor(total / 2) - Math.floor(N / 2));
      let filas = [];
      try {
        filas = await query(
          `SELECT id, firstname, lastname, homephone, mobile, phone, otherphone, createdtime
             FROM Contacts
             WHERE ${VTIGER_FIELDS.SEDE_ACTUAL} = '${sede}'${filtro}${rango}
             ORDER BY id DESC LIMIT ${offset}, ${N};`,
          { context: 'cobertura-muestra' }
        ) || [];
      } catch { continue; }

      let revisados = 0, encontrados = 0;
      for (const f of filas) {
        const teles = [f.homephone, f.mobile, f.phone, f.otherphone].map(digitos).filter(d => d.length >= 10);
        if (!teles.length) continue;
        revisados++;
        if (await existe(loc, h, teles)) encontrados++;
      }
      if (revisados === 0) continue;

      const pctFalta = Math.round((1 - encontrados / revisados) * 100);
      const estimado = Math.round(total * pctFalta / 100);
      if (tipo === 'compradores') { totComp += total; faltanComp += estimado; }
      else { totLeads += total; faltanLeads += estimado; }

      console.log(`  ${ano} ${tipo.padEnd(12)} total ${String(total).padStart(6)} | muestra ${encontrados}/${revisados} en GHL | FALTA ~${estimado} (${pctFalta}%)`);
      await sleep(120);
    }
  }
  salida.push({ sede, compradores: totComp, faltanCompradores: faltanComp, contactos: totLeads, faltanContactos: faltanLeads, totalFaltante: faltanComp + faltanLeads });
}

console.log('\n===== RESUMEN =====');
console.table(salida);
const dir = path.join(process.cwd(), 'scratch', 'audit_out');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `cobertura_actual_${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(file, JSON.stringify({ generado: new Date().toISOString(), muestra: N, sedes: salida }, null, 2), 'utf8');
console.log(`[FILE] ${file}`);
process.exit(0);
