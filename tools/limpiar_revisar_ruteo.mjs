#!/usr/bin/env node
/**
 * ==============================================================================
 * LIMPIAR `revisar-ruteo` — purga la etiqueta de los contactos ya bien ruteados
 * ==============================================================================
 * Esa etiqueta se puso a mansalva cuando el router abortaba por "sin asesor".
 * Ya corregido: ahora el ruteo se completa por etiquetas y, al re-rutear, el
 * propio router retira `revisar-ruteo`.
 *
 * Uso:
 *   node tools/limpiar_revisar_ruteo.mjs --sede=PALACIOS              (simulación)
 *   node tools/limpiar_revisar_ruteo.mjs --sede=PALACIOS --ejecutar
 *   node tools/limpiar_revisar_ruteo.mjs --sede=PALACIOS --limite=200 --ejecutar
 * ==============================================================================
 */
import 'dotenv/config';
import { SEDES_GATEWAY } from '../src/config/index.js';
import { routeChatByContact } from '../src/agents/chat_router_agent.js';

const op = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) op[m[1]] = m[2] === undefined ? true : m[2];
}
const SEDE = String(op.sede || 'PALACIOS').toUpperCase();
const LIMITE = Math.min(Math.max(parseInt(op.limite || '50', 10) || 50, 1), 200);
const EJECUTAR = Boolean(op.ejecutar);
const BASE = 'https://services.leadconnectorhq.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cfg = SEDES_GATEWAY[SEDE];
if (!cfg?.ghl?.locationId) throw new Error(`Sede ${SEDE} sin credenciales`);
const h = { Authorization: `Bearer ${cfg.ghl.apiKey}`, Version: '2021-07-28', Accept: 'application/json' };

// Búsqueda por etiqueta: GHL no filtra por tag en /contacts, así que se pagina y
// se filtra en memoria (solo la primera página de `limite`).
const r = await fetch(`${BASE}/contacts/?locationId=${cfg.ghl.locationId}&limit=100`, { headers: h });
const data = await r.json();
const contactos = (data.contacts || []).filter(c => (c.tags || []).map(t => String(t).toLowerCase()).includes('revisar-ruteo'));

console.log(`\n=== LIMPIAR revisar-ruteo · ${SEDE} · ${contactos.length} de ${(data.contacts || []).length} contactos en la página ===`);
console.log(EJECUTAR ? '[MODO] EJECUTAR (escribe en GHL)\n' : '[MODO] SIMULACIÓN (no escribe)\n');

if (contactos.length === 0) {
  console.log('No hay contactos con la etiqueta en esta página. Prueba con --limite más alto o revisa otra sede.');
  process.exit(0);
}

let limpiados = 0, mantenidos = 0, errores = 0;
for (const c of contactos.slice(0, LIMITE)) {
  const nombre = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.id;
  try {
    const res = await routeChatByContact(c.id, false, !EJECUTAR, { locationId: cfg.ghl.locationId, origen: 'limpieza-revisar' });
    if (EJECUTAR) {
      // Tras el ruteo real, se verifica si la etiqueta desapareció.
      const d = await (await fetch(`${BASE}/contacts/${c.id}`, { headers: h })).json();
      const sigue = (d.contact?.tags || []).map(t => String(t).toLowerCase()).includes('revisar-ruteo');
      if (sigue) { mantenidos++; console.log(`  ${nombre}: SIGUE con revisar-ruteo (motivo vigente)`); }
      else { limpiados++; console.log(`  ${nombre}: etiqueta retirada`); }
    } else {
      const tags = (res?.payload?.tags || []).map(t => String(t).toLowerCase());
      const seguiria = tags.includes('revisar-ruteo');
      console.log(`  ${nombre}: ${seguiria ? 'seguiría marcado (' + (res?.motivoRevision || '?') + ')' : 'quedaría LIMPIO'}`);
      if (!seguiria) limpiados++; else mantenidos++;
    }
  } catch (e) {
    errores++;
    console.log(`  ${nombre}: ERROR ${e.message.slice(0, 60)}`);
  }
  await sleep(400);
}

console.log(`\n[RESULTADO] ${EJECUTAR ? 'limpiados' : 'quedarían limpios'}: ${limpiados} · con motivo vigente: ${mantenidos} · errores: ${errores}`);
if (!EJECUTAR) console.log('[!] Simulación. Agrega --ejecutar para aplicarlo.');
process.exit(0);
