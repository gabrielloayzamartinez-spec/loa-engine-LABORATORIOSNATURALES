#!/usr/bin/env node
/**
 * RASTREO DIRIGIDO — PIURA: anuncios prendidos y su cadena completa.
 *
 * 1. Toma los contactos más recientes de la subcuenta de Piura.
 * 2. Extrae el Ad ID de cada uno (custom field).
 * 3. Pregunta a Meta por CADA anuncio: nombre, estado (ACTIVO/PAUSADO) y campaña.
 * 4. Agrupa: anuncio → campaña → contactos que trajo.
 *
 * Uso: node tools/rastreo_anuncios_sede.mjs --sede=PIURA --paginas=2
 */
import 'dotenv/config';
import { SEDES_GATEWAY, META_CONFIG } from '../src/config/index.js';

const op = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) op[m[1]] = m[2] === undefined ? true : m[2];
}
const SEDE = String(op.sede || 'PIURA').toUpperCase();
const PAGINAS = Math.min(Math.max(parseInt(op.paginas || '2', 10) || 2, 1), 10);
const BASE = 'https://services.leadconnectorhq.com';
const VER = META_CONFIG?.graphApiVersion || 'v20.0';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cfg = SEDES_GATEWAY[SEDE];
if (!cfg?.ghl?.locationId) throw new Error(`Sede ${SEDE} sin credenciales GHL`);
const token = cfg?.meta?.accessToken;
const h = { Authorization: `Bearer ${cfg.ghl.apiKey}`, Version: '2021-07-28', Accept: 'application/json' };

// --- 1. Campos: encontrar el del Ad ID -------------------------------------
const dic = await (await fetch(`${BASE}/locations/${cfg.ghl.locationId}/customFields`, { headers: h })).json();
const campos = dic.customFields || [];
const porId = new Map(campos.map(c => [c.id, String(c.name || '').toLowerCase()]));
const esAdId = c => /ad id|id anuncio|adid/.test(String(c.name || '').toLowerCase());

// --- 2. Contactos recientes ------------------------------------------------
const contactos = [];
let startAfterId = null, startAfter = null;
for (let p = 0; p < PAGINAS; p++) {
  const qs = new URLSearchParams({ locationId: cfg.ghl.locationId, limit: '100' });
  if (startAfterId) qs.set('startAfterId', startAfterId);
  if (startAfter) qs.set('startAfter', startAfter);
  const r = await fetch(`${BASE}/contacts/?${qs}`, { headers: h });
  if (!r.ok) break;
  const lote = (await r.json()).contacts || [];
  if (!lote.length) break;
  contactos.push(...lote);
  const u = lote[lote.length - 1];
  startAfterId = u.id;
  startAfter = u.dateAdded ? String(new Date(u.dateAdded).getTime()) : startAfter;
  if (lote.length < 100) break;
  await sleep(200);
}

// --- 3. Ad ID por contacto -------------------------------------------------
const porAnuncio = new Map();
let sinAd = 0, sinTags = 0, noMeta = 0;
for (const c of contactos) {
  const tags = (c.tags || []).map(t => String(t).toLowerCase());
  const tieneCanal = tags.some(t => t.startsWith('canal-'));
  const tieneProv = tags.some(t => t.startsWith('prov-'));
  if (!tieneCanal || !tieneProv) sinTags++;

  // [FILTRO META] Solo tiene sentido preguntar el Ad ID a los contactos que
  // llegaron por publicidad. Los leads de vTiger (prospecto-vtiger) no tienen
  // anuncio y consultarlos uno por uno gasta cuota sin aportar nada.
  const esDeMeta = tags.includes('meta-ads') || tags.includes('facebook-messenger')
    || tags.includes('canal-messenger') || tags.includes('canal-fb-msgr');
  if (!esDeMeta) { noMeta++; continue; }

  const det = await (await fetch(`${BASE}/contacts/${c.id}`, { headers: h })).json();
  const cf = det.contact?.customFields || [];
  const campoAd = cf.find(x => esAdId({ name: porId.get(x.id) || '' }));
  const adId = String(campoAd?.value ?? campoAd?.field_value ?? '').trim();
  if (!/^\d{8,}$/.test(adId)) { sinAd++; continue; }

  if (!porAnuncio.has(adId)) porAnuncio.set(adId, { adId, contactos: [], paginas: new Set(), provs: new Set() });
  const reg = porAnuncio.get(adId);
  reg.contactos.push(`${c.firstName || ''} ${c.lastName || ''}`.trim());
  const pg = tags.find(t => t.startsWith('pagina-')); if (pg) reg.paginas.add(pg.replace('pagina-', ''));
  const pv = tags.find(t => t.startsWith('prov-')); if (pv) reg.provs.add(pv.replace('prov-', ''));
  await sleep(120);
}

// --- 4. Meta: estado de cada anuncio ---------------------------------------
const filas = [];
for (const reg of porAnuncio.values()) {
  let meta = null;
  if (token) {
    try {
      const url = `https://graph.facebook.com/${VER}/${reg.adId}?fields=name,effective_status,status,campaign{name},adset{name}&access_token=${token}`;
      const r = await fetch(url);
      const d = await r.json();
      if (!d.error) meta = d;
      else meta = { error: d.error.message };
    } catch (e) { meta = { error: e.message }; }
  }
  filas.push({
    anuncio: reg.adId,
    nombre: String(meta?.name || '—').slice(0, 28),
    estado: meta?.effective_status || (meta?.error ? 'sin acceso' : '—'),
    campaña: String(meta?.campaign?.name || '—').slice(0, 32),
    conjunto: String(meta?.adset?.name || '—').slice(0, 22),
    página: [...reg.paginas].join(',') || '—',
    proveedor: [...reg.provs].join(',') || '—',
    contactos: reg.contactos.length
  });
  await sleep(200);
}

filas.sort((a, b) => b.contactos - a.contactos);
console.log('='.repeat(110));
console.log(`RASTREO ${SEDE} · ${contactos.length} contactos revisados · ${porAnuncio.size} anuncios distintos`);
console.log(`activos: ${filas.filter(f => /ACTIVE|ACTIVO/.test(f.estado)).length} · pausados: ${filas.filter(f => /PAUSED|PAUSADO/.test(f.estado)).length} · sin Ad ID: ${sinAd} · sin etiquetar: ${sinTags}`);
console.log('='.repeat(110));
console.table(filas);

const activos = filas.filter(f => /ACTIVE|ACTIVO/.test(f.estado));
if (activos.length) {
  console.log('\n--- ANUNCIOS PRENDIDOS AHORA ---');
  for (const a of activos) console.log(`  · ${a.nombre} | ${a.campaña} | ${a.página} | prov=${a.proveedor} | ${a.contactos} contactos recientes`);
}
process.exit(0);
