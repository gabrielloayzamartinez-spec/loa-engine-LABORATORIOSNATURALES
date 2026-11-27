#!/usr/bin/env node
/**
 * ==============================================================================
 * OPERACIÓN AUTOCORRECTIVA DEL NIVEL 1 — `revisar-ruteo`
 * ==============================================================================
 * Re-rutea los contactos marcados `revisar-ruteo` para que el router:
 *   · complete canal / proveedor / página / producto si faltaban,
 *   · intercambie la etiqueta de proveedor si cambió,
 *   · y RETIRE `revisar-ruteo` cuando el ruteo ya está confirmado.
 *
 * Cada acción queda registrada en un JSON de auditoría con el ANTES y el DESPUÉS.
 *
 * Uso:
 *   node tools/operacion_n1_autocorrectiva.mjs --sede=PALACIOS --ejecutar --paginas=6
 *   node tools/operacion_n1_autocorrectiva.mjs --sede=PALACIOS            (simulación)
 *
 * SOLO la sede indicada. No toca vTiger.
 * ==============================================================================
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { SEDES_GATEWAY } from '../src/config/index.js';
import { routeChatByContact } from '../src/agents/chat_router_agent.js';

const op = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) op[m[1]] = m[2] === undefined ? true : m[2];
}
const SEDE = String(op.sede || 'PALACIOS').toUpperCase();
const PAGINAS = Math.min(Math.max(parseInt(op.paginas || '5', 10) || 5, 1), 40);
const EJECUTAR = Boolean(op.ejecutar);
const BASE = 'https://services.leadconnectorhq.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cfg = SEDES_GATEWAY[SEDE];
if (!cfg?.ghl?.locationId) throw new Error(`Sede ${SEDE} sin credenciales`);
const h = { Authorization: `Bearer ${cfg.ghl.apiKey}`, Version: '2021-07-28', Accept: 'application/json' };

const FAMILIAS = ['canal-', 'prov-', 'pagina-', 'producto-', 'sede-', 'cola-'];
const familias = tags => {
  const t = (tags || []).map(x => String(x).toLowerCase());
  const out = {};
  for (const f of FAMILIAS) out[f] = t.filter(x => x.startsWith(f)).sort();
  return out;
};

// --- Descubrimiento paginado de contactos con la etiqueta --------------------
async function descubrir() {
  const encontrados = [];
  let startAfterId = null, startAfter = null;
  for (let p = 0; p < PAGINAS; p++) {
    const qs = new URLSearchParams({ locationId: cfg.ghl.locationId, limit: '100' });
    if (startAfterId) qs.set('startAfterId', startAfterId);
    if (startAfter) qs.set('startAfter', startAfter);
    const r = await fetch(`${BASE}/contacts/?${qs}`, { headers: h });
    if (!r.ok) { console.warn(`[PAGINA ${p + 1}] HTTP ${r.status}`); break; }
    const d = await r.json();
    const lote = d.contacts || [];
    if (lote.length === 0) break;
    for (const c of lote) {
      if ((c.tags || []).map(t => String(t).toLowerCase()).includes('revisar-ruteo')) encontrados.push(c);
    }
    const ultimo = lote[lote.length - 1];
    startAfterId = ultimo.id;
    startAfter = ultimo.dateAdded ? String(new Date(ultimo.dateAdded).getTime()) : startAfter;
    console.log(`  [página ${p + 1}] ${lote.length} contactos · acumulados con la etiqueta: ${encontrados.length}`);
    if (lote.length < 100) break;
    await sleep(250);
  }
  return encontrados;
}

console.log(`\n=== OPERACIÓN AUTOCORRECTIVA N1 · ${SEDE} · ${PAGINAS} páginas ===`);
console.log(EJECUTAR ? '[MODO] EJECUTAR — escribe en GHL y audita cada acción\n' : '[MODO] SIMULACIÓN — no escribe\n');

const objetivos = await descubrir();
if (objetivos.length === 0) {
  console.log('\n[OK] No hay contactos con `revisar-ruteo` en las páginas revisadas. N1 limpio en esta sede.');
  process.exit(0);
}
console.log(`\nObjetivos: ${objetivos.length} contactos con \`revisar-ruteo\`\n`);

const acciones = [];
let limpiados = 0, mantenidos = 0, mejorados = 0, errores = 0;

for (const c of objetivos) {
  const nombre = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.id;
  const antes = familias(c.tags);
  try {
    const res = await routeChatByContact(c.id, false, !EJECUTAR, { locationId: cfg.ghl.locationId, origen: 'operacion-n1' });

    let despuesTags = res?.payload?.tags || null;
    if (EJECUTAR) {
      const d = await (await fetch(`${BASE}/contacts/${c.id}`, { headers: h })).json();
      despuesTags = d.contact?.tags || [];
    }
    const despues = familias(despuesTags || []);
    const sigue = (despuesTags || []).map(t => String(t).toLowerCase()).includes('revisar-ruteo');

    const ganoCanal = despues['canal-'].length > 0 && antes['canal-'].length === 0;
    const ganoProv = despues['prov-'].length > 0 && antes['prov-'].length === 0;
    const ganoPagina = despues['pagina-'].length > 0 && antes['pagina-'].length === 0;
    if (ganoCanal || ganoProv || ganoPagina) mejorados++;
    if (sigue) mantenidos++; else limpiados++;

    acciones.push({
      contactId: c.id,
      nombre,
      ejecutado: EJECUTAR,
      antes, despues,
      revisarRetirado: !sigue,
      motivoVigente: sigue ? (res?.motivoRevision || 'no determinado') : null,
      gano: { canal: ganoCanal, proveedor: ganoProv, pagina: ganoPagina },
      asesor: res?.asesor || null,
      canal: res?.canal || null,
      pagina: res?.pagina || null,
      proveedor: res?.proveedor || null
    });

    if (sigue) console.log(`  · ${nombre}: SIGUE marcado (${res?.motivoRevision || 'motivo vigente'})`);
    else console.log(`  · ${nombre}: limpio${ganoCanal || ganoProv || ganoPagina ? ' (+etiquetas nuevas)' : ''}`);
  } catch (e) {
    errores++;
    acciones.push({ contactId: c.id, nombre, ejecutado: EJECUTAR, error: e.message.slice(0, 120) });
    console.log(`  · ${nombre}: ERROR ${e.message.slice(0, 70)}`);
  }
  await sleep(EJECUTAR ? 350 : 150);
}

const resumen = { sede: SEDE, modo: EJECUTAR ? 'ejecutado' : 'simulacion', paginas: PAGINAS, objetivos: objetivos.length, limpiados, mejorados, mantenidos, errores, fecha: new Date().toISOString() };
const dir = path.join(process.cwd(), 'scratch', 'audit_out');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `n1_autocorrectiva_${SEDE}_${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify({ resumen, acciones }, null, 2), 'utf8');

console.log('\n=== RESUMEN ===');
console.log(JSON.stringify(resumen, null, 2));
console.log(`[FILE] ${file}`);
process.exit(0);
