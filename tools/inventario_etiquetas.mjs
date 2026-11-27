/**
 * Inventario REAL de etiquetas por subcuenta (lo que existe en GHL hoy).
 * Agrupa por familia para construir vistas de conversaciones.
 */
import 'dotenv/config';
import { SEDES_GATEWAY } from '../src/config/index.js';

const BASE = 'https://services.leadconnectorhq.com';
const SEDES = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];

const FAMILIAS = {
  'CANAL (origen del chat)': /^canal-/,
  'PROVEEDOR (quién trae el lead)': /^prov-/,
  'PÁGINA (fanpage)': /^pagina-/,
  'PRODUCTO (padecimiento)': /^producto-/,
  'ESTADO DEL LEAD': /^(prospecto|compro|cliente|revisar|sin-telefono|venta|nuevo)/,
  'COLA / ATENCIÓN': /^cola-/,
  'OTROS': /.*/
};

for (const sede of SEDES) {
  const loc = SEDES_GATEWAY[sede]?.ghl?.locationId;
  const key = SEDES_GATEWAY[sede]?.ghl?.apiKey;
  if (!loc || !key) { console.log(`[SKIP] ${sede}`); continue; }
  const h = { Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json' };

  let tags = [];
  try {
    const r = await fetch(`${BASE}/locations/${loc}/tags?limit=1000`, { headers: h });
    if (r.ok) {
      const d = await r.json();
      tags = (d.tags || []).map(t => (typeof t === 'string' ? t : t.name)).filter(Boolean);
    } else {
      console.log(`[${sede}] HTTP ${r.status} al listar etiquetas`);
    }
  } catch (e) { console.log(`[${sede}] error: ${e.message}`); }

  console.log(`\n========== ${sede} · ${tags.length} etiquetas ==========`);
  const usadas = new Set();
  for (const [nombre, re] of Object.entries(FAMILIAS)) {
    const lista = tags.filter(t => re.test(t.toLowerCase()) && !usadas.has(t.toLowerCase()));
    lista.forEach(t => usadas.add(t.toLowerCase()));
    if (lista.length === 0) continue;
    console.log(`\n  ${nombre}  (${lista.length})`);
    console.log('    ' + lista.sort().join('\n    '));
  }
}
process.exit(0);
