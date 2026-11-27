/**
 * MAPA PÁGINA → PROVEEDOR → DUEÑO  y  ANUNCIO → PÁGINA → PROVEEDOR (datos vivos).
 *
 * 1) Imprime la matriz de páginas (la fuente de verdad del ruteo).
 * 2) Toma los contactos más recientes de cada sede y muestra, para cada uno:
 *    anuncio (ad id), campaña (la que resuelve Meta), página, proveedor y dueño.
 */
import 'dotenv/config';
import { SEDES_GATEWAY } from '../src/config/index.js';
import { PAGE_MATRIX } from '../src/config/page_matrix.js';

const BASE = 'https://services.leadconnectorhq.com';
const SEDES = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];
const N = Math.max(3, parseInt(process.argv[2] || '5', 10));
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('='.repeat(96));
console.log('MATRIZ DE PÁGINAS (la decide el ruteo: gana la página del último mensaje)');
console.log('='.repeat(96));
const filas = Object.entries(PAGE_MATRIX).map(([pageId, v]) => ({
  pageId,
  página: v.pageName,
  sede: v.sede,
  proveedor: v.proveedor,
  dueño: v.ownerKey || (v.sinDueno ? '(sin dueño)' : '—')
}));
console.table(filas);

for (const sede of SEDES) {
  const cfg = SEDES_GATEWAY[sede];
  if (!cfg?.ghl?.locationId) continue;
  const h = { Authorization: `Bearer ${cfg.ghl.apiKey}`, Version: '2021-07-28', Accept: 'application/json' };

  const r = await fetch(`${BASE}/contacts/?locationId=${cfg.ghl.locationId}&limit=${N}`, { headers: h });
  const contactos = (r.ok ? (await r.json()).contacts : []) || [];

  console.log(`\n${'='.repeat(96)}`);
  console.log(`ANUNCIO → PÁGINA → PROVEEDOR  ·  ${sede} (${contactos.length} más recientes)`);
  console.log('='.repeat(96));

  const out = [];
  for (const c of contactos) {
    const tags = (c.tags || []).map(t => String(t));
    const lower = tags.map(t => t.toLowerCase());
    const prov = tags.find(t => t.toLowerCase().startsWith('prov-')) || '—';
    const page = tags.find(t => t.toLowerCase().startsWith('pagina-')) || '—';
    const canal = tags.find(t => t.toLowerCase().startsWith('canal-')) || '—';
    const prod = tags.find(t => t.toLowerCase().startsWith('producto-')) || '—';

    const d = await (await fetch(`${BASE}/contacts/${c.id}`, { headers: h })).json();
    const cf = d.contact?.customFields || [];
    const val = nombres => {
      const f = cf.find(x => nombres.some(n => String(x.id || '').toLowerCase() === n));
      return f?.value || f?.field_value || '';
    };
    // Los CF se resuelven por nombre en el mapa de la sede; se busca por coincidencia de nombre
    const dic = await (await fetch(`${BASE}/locations/${cfg.ghl.locationId}/customFields`, { headers: h })).json();
    const porId = new Map((dic.customFields || []).map(x => [x.id, String(x.name || '').toLowerCase()]));
    const leer = fragmento => {
      const f = cf.find(x => String(porId.get(x.id) || '').includes(fragmento));
      return f?.value || f?.field_value || '';
    };

    out.push({
      contacto: `${c.firstName || ''} ${c.lastName || ''}`.trim().slice(0, 24),
      anuncio: String(leer('ad id') || leer('id anuncio') || '—').slice(0, 20),
      campaña: String(leer('utm campaign') || leer('campaña') || '—').slice(0, 34),
      página: page.replace('pagina-', ''),
      proveedor: prov.replace('prov-', ''),
      canal: canal.replace('canal-', ''),
      producto: prod.replace('producto-', '')
    });
    await sleep(150);
  }
  console.table(out);
}
process.exit(0);
