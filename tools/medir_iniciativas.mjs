/**
 * INICIATIVAS POR PÁGINA — ¿esta página trae Messenger o Formularios?
 * Mide con datos reales: toma contactos de cada etiqueta `pagina-*` y lee el
 * custom field "Canal Captación" (FORM / FB-MSGR / WHATSAPP…).
 */
import 'dotenv/config';
import { SEDES_GATEWAY } from '../src/config/index.js';
import { PAGE_MATRIX } from '../src/config/page_matrix.js';
import { etiquetaPagina } from '../src/domain/ghl_tags.js';

const BASE = 'https://services.leadconnectorhq.com';
const SEDES = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];
const N = 6;
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const sede of SEDES) {
  const cfg = SEDES_GATEWAY[sede];
  if (!cfg?.ghl?.locationId) continue;
  const h = { Authorization: `Bearer ${cfg.ghl.apiKey}`, Version: '2021-07-28', Accept: 'application/json' };

  const dic = await (await fetch(`${BASE}/locations/${cfg.ghl.locationId}/customFields`, { headers: h })).json();
  const canalId = (dic.customFields || []).find(f => /canal captaci|canal_captacion/i.test(String(f.name)))?.id;

  const paginas = Object.entries(PAGE_MATRIX).filter(([, v]) => v.sede === sede);
  console.log(`\n===== ${sede} =====`);

  for (const [pageId, info] of paginas) {
    const tag = etiquetaPagina(info.pageName);
    // Contactos recientes de la sede; se filtra por la etiqueta de página.
    let muestra = [];
    try {
      const r = await fetch(`${BASE}/contacts/?locationId=${cfg.ghl.locationId}&limit=100`, { headers: h });
      const d = await r.json();
      muestra = (d.contacts || []).filter(c => (c.tags || []).map(t => String(t).toLowerCase()).includes(tag)).slice(0, N);
    } catch { /* sigue */ }

    const conteo = {};
    for (const c of muestra) {
      const det = await (await fetch(`${BASE}/contacts/${c.id}`, { headers: h })).json();
      const cf = det.contact?.customFields || [];
      const v = String(cf.find(x => x.id === canalId)?.value || cf.find(x => x.id === canalId)?.field_value || '').toUpperCase();
      const canal = v.includes('FORM') ? 'FORM' : v.includes('MSGR') || v.includes('MESSENGER') ? 'FB-MSGR' : v.includes('WHATSAPP') || v.includes('WSP') ? 'WHATSAPP' : v ? v : '(vacío)';
      conteo[canal] = (conteo[canal] || 0) + 1;
      await sleep(80);
    }
    const resumen = Object.entries(conteo).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' ') || 'sin muestra';
    console.log(`  ${info.pageName.padEnd(30)} ${info.proveedor.padEnd(11)} → ${resumen}`);
  }
}
process.exit(0);
