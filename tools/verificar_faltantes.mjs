/**
 * Verificación puntual: toma los ids marcados como "faltantes" por una medición
 * anterior y comprueba, uno por uno y con reintentos, si están en GHL.
 */
import 'dotenv/config';
import fs from 'fs';
import { query, VTIGER_CONTACT_SELECT, VTIGER_FIELDS } from '../src/services/vtigerClient.js';
import { SEDES_GATEWAY } from '../src/config/index.js';

const SEDE = (process.argv[2] || 'PALACIOS').toUpperCase();
const ARCHIVO = process.argv[3] || 'scratch/historico/PALACIOS_contactos_actual_2023.json';
const N = parseInt(process.argv[4] || '10', 10);
const BASE = 'https://services.leadconnectorhq.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digitos = v => String(v || '').replace(/\D/g, '');

const loc = SEDES_GATEWAY[SEDE].ghl.locationId;
const h = { Authorization: `Bearer ${SEDES_GATEWAY[SEDE].ghl.apiKey}`, Version: '2021-07-28', Accept: 'application/json' };

const estado = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
const ids = estado.faltantes.slice(0, N).map(f => f.id);
console.log(`Verificando ${ids.length} ids de ${ARCHIVO} en la subcuenta ${SEDE}…\n`);

let encontrados = 0;
for (const id of ids) {
  const filas = await query(
    `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.ID} = '${String(id).replace(/[^A-Za-z0-9]/g, '')}' AND ${VTIGER_FIELDS.SEDE_ACTUAL} = '${SEDE}' LIMIT 1;`,
    { context: 'verificar-faltante' }
  ) || [];
  const v = filas[0];
  if (!v) { console.log(`  ${id}: NO existe en vTiger para ${SEDE}`); continue; }

  const teles = [v.homephone, v.mobile, v.phone, v.otherphone].map(digitos).filter(d => d.length >= 10);
  let hallado = false, detalle = '';
  for (const t of teles) {
    const last10 = t.slice(-10);
    for (let i = 0; i < 3 && !hallado; i++) {
      try {
        const r = await fetch(`${BASE}/contacts/?locationId=${loc}&query=${last10}`, { headers: h });
        if (r.status === 429) { await sleep(1500); continue; }
        const d = await r.json();
        const hit = (d.contacts || []).find(c => digitos(c.phone).endsWith(last10));
        if (hit) { hallado = true; detalle = `phone=${last10} ghl=${hit.id}`; }
        break;
      } catch { await sleep(600); }
    }
    if (hallado) break;
    await sleep(120);
  }
  if (hallado) encontrados++;
  console.log(`  ${id} ${(v.firstname || '') + ' ' + (v.lastname || '')} teles=${teles.length} -> ${hallado ? 'EN GHL ' + detalle : 'NO ENCONTRADO'}`);
  await sleep(200);
}
console.log(`\n[RESULTADO] ${encontrados}/${ids.length} de los marcados como faltantes SÍ están en GHL.`);
process.exit(0);
