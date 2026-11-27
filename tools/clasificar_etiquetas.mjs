/**
 * CLASIFICA las etiquetas de una subcuenta para borrarlas DESDE LA CONFIGURACIÓN.
 * - CONTRATO: prov-* / pagina-* / estado comercial  → se conservan
 * - PROTEGIDAS: marcadores que usa el motor           → se conservan
 * - BASURA: todo lo demás                             → se puede borrar de la config
 *
 * node tools/clasificar_etiquetas.mjs --sede=PALACIOS [--borrar]
 */
import 'dotenv/config';
import { SEDES_GATEWAY } from '../src/config/index.js';
import { PAGE_MATRIX } from '../src/config/page_matrix.js';
import { etiquetaPagina, etiquetaProveedor, TAGS_PROTEGIDAS, TAGS_ESTADO } from '../src/domain/ghl_tags.js';

const op = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) op[m[1]] = m[2] === undefined ? true : m[2];
}
const SEDE = String(op.sede || 'PALACIOS').toUpperCase();
const BORRAR = Boolean(op.borrar);
const BASE = 'https://services.leadconnectorhq.com';

const cfg = SEDES_GATEWAY[SEDE];
if (!cfg?.ghl?.locationId) throw new Error(`Sede ${SEDE} sin credenciales`);
const h = { Authorization: `Bearer ${cfg.ghl.apiKey}`, Version: '2021-07-28', Accept: 'application/json' };

// [MEJORA 27/11] La lista de lo que se conserva NO se adivina por prefijo: se
// deriva de la MATRIZ de páginas de ESTA sede. Si una página o un proveedor no
// está en la matriz, su etiqueta es basura aunque empiece con `pagina-`/`prov-`.
const paginasReales = new Set();
const provsReales = new Set();
for (const [, v] of Object.entries(PAGE_MATRIX)) {
  if (String(v.sede).toUpperCase() !== SEDE) continue;
  const pt = etiquetaPagina(v.pageName);
  if (pt) paginasReales.add(pt);
  const pv = etiquetaProveedor(v.proveedor);
  if (pv) provsReales.add(pv);
}
// [DEPURACIÓN 27/11] Las etiquetas de estado (compro/cliente/prospecto/convertido)
// ya NO se conservan: el estado vive en el custom field "Estado de Compra".
const estadoReales = new Set();

const r = await fetch(`${BASE}/locations/${cfg.ghl.locationId}/tags`, { headers: h });
if (!r.ok) throw new Error(`HTTP ${r.status} al listar etiquetas`);
const data = await r.json();
const tags = (data.tags || []).map(t => ({ id: t.id || t._id, name: String(t.name || t) }));

const conservar = [], protegidas = [], basura = [];
for (const t of tags) {
  const low = t.name.toLowerCase();
  if (paginasReales.has(low) || provsReales.has(low) || estadoReales.has(low)) { conservar.push(t); continue; }
  if (TAGS_PROTEGIDAS.has(low)) { protegidas.push(t); continue; }
  basura.push(t);
}

console.log(`\n=== ${SEDE} · ${tags.length} etiquetas en la configuración ===`);
console.log(`  SE CONSERVAN (matriz + estado): ${conservar.length}`);
console.log(`  protegidas (las usa el motor): ${protegidas.length}`);
console.log(`  BASURA a borrar: ${basura.length}`);

console.log('\n--- SE CONSERVAN (páginas y proveedores REALES de esta sede) ---');
for (const t of conservar.sort((a, b) => a.name.localeCompare(b.name))) console.log(`  ${t.name}`);

console.log('\n--- PROTEGIDAS (revisar si el workflow sigue activo) ---');
for (const t of protegidas.sort((a, b) => a.name.localeCompare(b.name))) console.log(`  ${t.name}`);

console.log('\n--- SE BORRARÍAN ---');
for (const t of basura.sort((a, b) => a.name.localeCompare(b.name))) console.log(`  ${t.name}  (${t.id})`);

if (BORRAR) {
  console.log('\n[BORRANDO] ...');
  let ok = 0, fail = 0;
  for (const t of basura) {
    if (!t.id) { fail++; continue; }
    try {
      const del = await fetch(`${BASE}/locations/${cfg.ghl.locationId}/tags/${t.id}`, { method: 'DELETE', headers: h });
      if (del.ok) { ok++; } else { fail++; console.log(`  ✗ ${t.name}: HTTP ${del.status}`); }
    } catch (e) { fail++; console.log(`  ✗ ${t.name}: ${e.message}`); }
    await new Promise(res => setTimeout(res, 120));
  }
  console.log(`\n[RESULTADO] borradas ${ok} · fallidas ${fail}`);
} else {
  console.log('\n[!] Simulación. Agrega --borrar para eliminarlas de la configuración.');
}
process.exit(0);
