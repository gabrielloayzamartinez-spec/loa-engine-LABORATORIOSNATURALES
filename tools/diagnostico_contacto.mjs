/**
 * DIAGNÓSTICO DE UN CONTACTO — por qué NO se etiqueta.
 * Busca por nombre en las 4 subcuentas, muestra tags/conversaciones y simula el ruteo.
 *
 * node tools/diagnostico_contacto.mjs "Juana Ordoñez"
 */
import 'dotenv/config';
import { SEDES_GATEWAY } from '../src/config/index.js';
import { routeChatByContact } from '../src/agents/chat_router_agent.js';

const BASE = 'https://services.leadconnectorhq.com';
const Q = process.argv[2];
const EJECUTAR = process.argv.includes('--ejecutar');
if (!Q) { console.error('Uso: node tools/diagnostico_contacto.mjs "Nombre Apellido" [--ejecutar]'); process.exit(1); }

const SEDES = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];

for (const sede of SEDES) {
  const cfg = SEDES_GATEWAY[sede];
  if (!cfg?.ghl?.locationId) continue;
  const h = { Authorization: `Bearer ${cfg.ghl.apiKey}`, Version: '2021-07-28', Accept: 'application/json' };

  const r = await fetch(`${BASE}/contacts/?locationId=${cfg.ghl.locationId}&query=${encodeURIComponent(Q)}`, { headers: h });
  if (!r.ok) continue;
  const d = await r.json();
  const lista = d.contacts || [];
  if (lista.length === 0) continue;

  for (const c of lista.slice(0, 3)) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${sede} · ${c.firstName || ''} ${c.lastName || ''} (${c.id})`);
    console.log(`  teléfono : ${c.phone || '(sin teléfono)'}`);
    console.log(`  source   : ${c.source || '—'}`);
    console.log(`  alta     : ${c.dateAdded ? String(c.dateAdded).slice(0, 19) : '—'}`);
    console.log(`  etiquetas: ${(c.tags || []).join(', ') || '(NINGUNA)'}`);

    // Conversaciones: ¿hay mensajes reales de Messenger?
    try {
      const cv = await fetch(`${BASE}/conversations/search?locationId=${cfg.ghl.locationId}&contactId=${c.id}`, { headers: h });
      const dv = await cv.json();
      const convs = dv.conversations || [];
      console.log(`  conversaciones: ${convs.length}`);
      for (const conv of convs.slice(0, 3)) {
        console.log(`    · ${conv.lastMessageType || '—'} · ${String(conv.lastMessageBody || '').slice(0, 60)}`);
      }
    } catch (e) { console.log(`  conversaciones: error ${e.message}`); }

    // Simulación del ruteo
    try {
      const res = await routeChatByContact(c.id, false, !EJECUTAR, { locationId: cfg.ghl.locationId, origen: 'diagnostico' });
      if (res?.dryRun) {
        const tags = (res.payload?.tags || []);
        console.log(`  SIMULACIÓN → canal=${res.canal || '—'} prov=${res.proveedor || '—'} pagina=${res.pagina || '—'} producto=${res.tratamiento || '—'}`);
        console.log(`  etiquetas que escribiría: ${tags.join(', ') || '(ninguna)'}`);
      } else if (EJECUTAR) {
        const d2 = await (await fetch(`${BASE}/contacts/${c.id}`, { headers: h })).json();
        const t2 = (d2.contact?.tags || []);
        console.log(`  EJECUTADO → etiquetas ahora: ${t2.join(', ') || '(ninguna)'}`);
        console.log(`  canal=${(t2.find(x => x.startsWith('canal-')) || '—')} prov=${(t2.find(x => x.startsWith('prov-')) || '—')} pagina=${(t2.find(x => x.startsWith('pagina-')) || '—')} producto=${(t2.find(x => x.startsWith('producto-')) || '—')}`);
      } else {
        console.log(`  SIMULACIÓN → sin cambios (salida temprana). Resultado: ${res === undefined ? 'undefined' : JSON.stringify(res)}`);
      }
    } catch (e) { console.log(`  SIMULACIÓN → ERROR ${e.message.slice(0, 80)}`); }
  }
}
process.exit(0);
