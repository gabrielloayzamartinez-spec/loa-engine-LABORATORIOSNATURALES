#!/usr/bin/env node
/**
 * ==============================================================================
 * LIMPIADOR DE ETIQUETAS — deja SOLO prov-* y pagina-* (+ estado comercial)
 * ==============================================================================
 * Recorre los contactos de una subcuenta, calcula el contrato y hace UN PUT por
 * contacto SOLO si hay algo que retirar. No llama al router ni a vTiger: es una
 * limpieza de etiquetas, 1 llamada por contacto.
 *
 * Uso:
 *   node tools/limpiar_etiquetas.mjs --sede=PALACIOS --paginas=3            (simulación)
 *   node tools/limpiar_etiquetas.mjs --sede=PALACIOS --paginas=3 --ejecutar
 *   node tools/limpiar_etiquetas.mjs --sede=PALACIOS --paginas=20 --ejecutar --solo-con-basura
 * ==============================================================================
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { SEDES_GATEWAY } from '../src/config/index.js';
import { esEtiquetaDelContrato, TAGS_ESTADO } from '../src/domain/ghl_tags.js';

const op = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) op[m[1]] = m[2] === undefined ? true : m[2];
}
const SEDE = String(op.sede || 'PALACIOS').toUpperCase();
const PAGINAS = Math.min(Math.max(parseInt(op.paginas || '5', 10) || 5, 1), 5000);
const EJECUTAR = Boolean(op.ejecutar);
// [CAUDAL] Varios PUT en paralelo: 1 llamada por contacto, pero en tandas.
const CONC = Math.min(Math.max(parseInt(op.concurrencia || '6', 10) || 6, 1), 20);
const BASE = 'https://services.leadconnectorhq.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cfg = SEDES_GATEWAY[SEDE];
if (!cfg?.ghl?.locationId) throw new Error(`Sede ${SEDE} sin credenciales`);
const h = { Authorization: `Bearer ${cfg.ghl.apiKey}`, Version: '2021-07-28', Accept: 'application/json' };

console.log(`\n=== LIMPIAR ETIQUETAS · ${SEDE} · ${PAGINAS} páginas ===`);
console.log(EJECUTAR ? '[MODO] EJECUTAR\n' : '[MODO] SIMULACIÓN\n');

let revisados = 0, conBasura = 0, limpiados = 0, errores = 0;
const retiradas = {};

// [REANUDABLE] Guarda el cursor para que un corte no obligue a empezar de cero.
const dirEstado = path.join(process.cwd(), 'scratch');
const fileEstado = path.join(dirEstado, `limpieza_cursor_${SEDE}.json`);
let startAfterId = null, startAfter = null;
if (!op.reiniciar) {
  try {
    const e = JSON.parse(fs.readFileSync(fileEstado, 'utf8'));
    startAfterId = e.startAfterId || null;
    startAfter = e.startAfter || null;
    console.log(`[CURSOR] continúa desde ${startAfterId || 'el inicio'}`);
  } catch { /* primera vez */ }
}
const guardarCursor = () => {
  try {
    fs.mkdirSync(dirEstado, { recursive: true });
    fs.writeFileSync(fileEstado, JSON.stringify({ sede: SEDE, startAfterId, startAfter, revisados, limpiados, fecha: new Date().toISOString() }, null, 2), 'utf8');
  } catch { /* sin cursor */ }
};

for (let p = 0; p < PAGINAS; p++) {
  const qs = new URLSearchParams({ locationId: cfg.ghl.locationId, limit: '100' });
  if (startAfterId) qs.set('startAfterId', startAfterId);
  if (startAfter) qs.set('startAfter', startAfter);
  const r = await fetch(`${BASE}/contacts/?${qs}`, { headers: h });
  if (!r.ok) { console.warn(`[página ${p + 1}] HTTP ${r.status}`); break; }
  const d = await r.json();
  const lote = d.contacts || [];
  if (!lote.length) break;

  for (const c of lote) {
    revisados++;
    const tags = (c.tags || []).map(t => String(t));
    const basura = tags.filter(t => !esEtiquetaDelContrato(t));
    if (basura.length === 0) continue;
    conBasura++;
    for (const b of basura) retiradas[b.toLowerCase()] = (retiradas[b.toLowerCase()] || 0) + 1;
  }

  // [CONCURRENCIA] Se limpian en tandas de CONC para no tardar horas.
  if (EJECUTAR) {
    const pendientes = lote.filter(c => (c.tags || []).some(t => !esEtiquetaDelContrato(String(t))));
    for (let i = 0; i < pendientes.length; i += CONC) {
      const tanda = pendientes.slice(i, i + CONC);
      await Promise.all(tanda.map(async (c) => {
        const tags = (c.tags || []).map(t => String(t));
        const limpias = tags.filter(t => esEtiquetaDelContrato(t));
        try {
          const put = await fetch(`${BASE}/contacts/${c.id}`, {
            method: 'PUT',
            headers: { ...h, 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: limpias })
          });
          if (put.ok) { limpiados++; return true; }
          errores++; return false;
        } catch { errores++; return false; }
      }));
    }
  }

  const u = lote[lote.length - 1];
  startAfterId = u.id;
  startAfter = u.dateAdded ? String(new Date(u.dateAdded).getTime()) : startAfter;
  guardarCursor();
  console.log(`  [página ${p + 1}] revisados ${revisados} · con basura ${conBasura} · ${EJECUTAR ? 'limpiados ' + limpiados : ''} ${errores ? 'errores ' + errores : ''}`);
  if (lote.length < 100) break;
  await sleep(120);
}

const top = Object.entries(retiradas).sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log('\n--- ETIQUETAS MÁS RETIRADAS ---');
for (const [t, n] of top) console.log(`  ${String(n).padStart(5)}  ${t}`);

const resumen = { sede: SEDE, modo: EJECUTAR ? 'ejecutado' : 'simulacion', revisados, conBasura, limpiados, errores, fecha: new Date().toISOString() };
const dir = path.join(process.cwd(), 'scratch', 'audit_out');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `limpieza_etiquetas_${SEDE}_${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify({ resumen, retiradas }, null, 2), 'utf8');
console.log('\n' + JSON.stringify(resumen, null, 2));
console.log(`[FILE] ${file}`);
process.exit(0);
