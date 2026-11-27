#!/usr/bin/env node
/**
 * ==============================================================================
 * LABORATORIO DEL NIVEL 1 — simula el ruteo SIN tocar GHL
 * ==============================================================================
 * Corre el mismo `routeChatByContact` que usa producción, en modo DRY-RUN, y
 * muestra exactamente qué haría con un contacto:
 *   · etiquetas que ENTRAN y que SALEN
 *   · CF que escribiría
 *   · asesor asignado / canal / página / proveedor
 *   · si marcaría "revisar-ruteo" (y por qué)
 *
 * USO
 *   node tools/lab_n1.mjs --contacto=<idGhl>
 *   node tools/lab_n1.mjs --sede=PALACIOS --muestra=10
 *   node tools/lab_n1.mjs --sede=PALACIOS --muestra=20 --json=scratch/n1_audit.json
 *
 * SOLO LECTURA sobre GHL (el PUT no se ejecuta en dry-run).
 * ==============================================================================
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { routeChatByContact } from '../src/agents/chat_router_agent.js';
import { SEDES_GATEWAY } from '../src/config/index.js';

const op = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) op[m[1]] = m[2] === undefined ? true : m[2];
}
const SEDE = String(op.sede || '').toUpperCase();
const MUESTRA = Math.min(Math.max(parseInt(op.muestra || '10', 10) || 10, 1), 40);
const JSON_OUT = op.json ? String(op.json) : null;
const BASE = 'https://services.leadconnectorhq.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function headersDe(sede) {
  const key = SEDES_GATEWAY[sede]?.ghl?.apiKey;
  if (!key) throw new Error(`La sede ${sede} no tiene credenciales en .env`);
  return { Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json' };
}

const FAMILIAS = ['canal-', 'prov-', 'sede-', 'pagina-', 'producto-', 'cola-'];

function resumirTags(payload) {
  const tags = (payload?.tags || []).map(t => String(t).toLowerCase());
  const porFamilia = {};
  for (const f of FAMILIAS) porFamilia[f] = tags.filter(t => t.startsWith(f));
  return { total: tags.length, porFamilia, tags };
}

async function simular(contactId, sede) {
  const r = await routeChatByContact(contactId, false, true, {
    locationId: SEDES_GATEWAY[sede]?.ghl?.locationId,
    origen: 'laboratorio'
  });
  return r;
}

// ---------------------------------------------------------------------------
// MODO 1: un contacto
// ---------------------------------------------------------------------------
if (op.contacto) {
  const sede = SEDE || 'PALACIOS';
  const id = String(op.contacto);
  const h = headersDe(sede);

  const antes = await (await fetch(`${BASE}/contacts/${id}`, { headers: h })).json();
  const c = antes.contact || {};
  console.log(`\n=== SIMULACIÓN N1 · ${c.firstName || ''} ${c.lastName || ''} (${id}) · ${sede} ===`);
  console.log('ANTES:');
  console.log('  teléfono :', c.phone || '(sin teléfono)');
  console.log('  source   :', c.source || '—');
  console.log('  etiquetas:', (c.tags || []).join(', ') || '(ninguna)');

  const r = await simular(id, sede);
  if (!r?.dryRun) {
    console.log('\n[RESULTADO] El router no llegó a calcular un payload (gate de salida temprana).');
    console.log('Devuelto:', JSON.stringify(r));
    process.exit(0);
  }

  const despues = resumirTags(r.payload);
  const antesTags = new Set((c.tags || []).map(t => String(t).toLowerCase()));
  const despuesTags = new Set(despues.tags);
  const entran = [...despuesTags].filter(t => !antesTags.has(t));
  const salen = [...antesTags].filter(t => !despuesTags.has(t));

  console.log('\nDESPUÉS (lo que escribiría):');
  console.log('  asesor    :', r.asesor || '(sin dueño)');
  console.log('  canal     :', r.canal || '—');
  console.log('  página    :', r.pagina || '—');
  console.log('  proveedor :', r.proveedor || '—');
  console.log('  origen    :', r.origen || '—');
  console.log('  adId      :', r.adId || '—');
  console.log('  revisar   :', r.revisarRuteo ? `SÍ (${r.motivoRevision})` : 'no');
  console.log('  etiquetas :', despues.tags.join(', ') || '(ninguna)');
  for (const f of FAMILIAS) console.log(`    ${f.padEnd(10)}`, despues.porFamilia[f].join(', ') || '—');
  console.log('\nCAMBIOS:');
  console.log('  + entran:', entran.join(', ') || '—');
  console.log('  - salen  :', salen.join(', ') || '—');
  console.log('  CF escritos:', (r.payload.customFields || []).length);

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify({ antes: c, resultado: r, entran, salen }, null, 2), 'utf8');
    console.log(`\n[FILE] ${JSON_OUT}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// MODO 2: muestra por sede (auditoría de anomalías)
// ---------------------------------------------------------------------------
if (!SEDES_GATEWAY[SEDE]?.ghl?.locationId) throw new Error('Indica --sede=PALACIOS|BENAVIDES|ROOSEVELT|PIURA');
const h = headersDe(SEDE);
const loc = SEDES_GATEWAY[SEDE].ghl.locationId;

const lista = await (await fetch(`${BASE}/contacts/?locationId=${loc}&limit=${MUESTRA}`, { headers: h })).json();
const contactos = lista.contacts || [];
console.log(`\n=== LABORATORIO N1 · ${SEDE} · ${contactos.length} contactos ===\n`);

const filas = [];
const anomalias = { sinCanal: 0, sinPagina: 0, revisarRuteo: 0, sinProv: 0, sinDueno: 0, sinTags: 0, error: 0 };

for (const c of contactos) {
  let r = null;
  try { r = await simular(c.id, SEDE); }
  catch (e) { anomalias.error++; filas.push({ nombre: `${c.firstName || ''} ${c.lastName || ''}`.trim(), estado: 'ERROR: ' + e.message.slice(0, 40) }); continue; }

  if (!r?.dryRun) {
    const detalle = r === undefined ? 'sin cambios (salida temprana UNCHANGED)' : JSON.stringify(r).slice(0, 60);
    filas.push({ nombre: `${c.firstName || ''} ${c.lastName || ''}`.trim(), estado: detalle });
    continue;
  }

  const tags = resumirTags(r.payload);
  const tiene = pref => tags.porFamilia[pref].length > 0;
  if (!tiene('canal-')) anomalias.sinCanal++;
  if (!tiene('pagina-')) anomalias.sinPagina++;
  if (!tiene('prov-')) anomalias.sinProv++;
  if (r.revisarRuteo) anomalias.revisarRuteo++;
  if (!r.asesor) anomalias.sinDueno++;
  if (tags.total === 0) anomalias.sinTags++;

  filas.push({
    nombre: `${c.firstName || ''} ${c.lastName || ''}`.trim().slice(0, 22) || c.id,
    tel: c.phone ? 'sí' : 'no',
    canal: tags.porFamilia['canal-'].join(',') || '—',
    prov: tags.porFamilia['prov-'].join(',') || '—',
    pagina: tags.porFamilia['pagina-'].join(',') || '—',
    asesor: r.asesor || '—',
    revisar: r.revisarRuteo ? `SÍ: ${r.motivoRevision}` : '',
    tags: tags.total
  });
  await sleep(250);
}

console.table(filas);
console.log('\n--- ANOMALÍAS ---');
console.log(JSON.stringify(anomalias, null, 2));

if (JSON_OUT) {
  fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify({ sede: SEDE, muestra: contactos.length, anomalias, filas }, null, 2), 'utf8');
  console.log(`\n[FILE] ${JSON_OUT}`);
}
process.exit(0);
