import { GHL_CONFIG } from '../config/index.js';
import { findVTigerContact } from '../services/vtiger_api_service.js';

const { apiKey, locationId } = GHL_CONFIG;
const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

async function inspectContact(query) {
  console.log(`\n======================================================`);
  console.log(`🔎 BUSCANDO CONTACTO EN GHL: "${query}"`);
  console.log(`======================================================`);

  const searchUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&query=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, { headers: HEADERS });
  const data = await res.json();
  const contact = data.contacts?.[0];

  if (!contact) {
    console.log(`❌ No se encontró contacto con query "${query}"`);
    return;
  }

  console.log(`ID: ${contact.id}`);
  console.log(`Nombre: ${contact.firstName || ''} ${contact.lastName || ''}`);
  console.log(`Teléfono: ${contact.phone || 'Sin teléfono'}`);
  console.log(`Source (Fuente): ${contact.source}`);
  console.log(`AssignedTo: ${contact.assignedTo}`);
  console.log(`DateAdded: ${contact.dateAdded}`);
  console.log(`DateUpdated: ${contact.dateUpdated}`);
  console.log(`Tags (${contact.tags?.length || 0}):`, contact.tags);

  console.log(`\n📋 Custom Fields de GHL:`);
  for (const cf of contact.customFields || []) {
    console.log(`  - [${cf.id}]: "${cf.value}"`);
  }

  // Conversación reciente
  console.log(`\n💬 Buscando conversación...`);
  const convRes = await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&contactId=${contact.id}`, { headers: HEADERS });
  const convData = await convRes.json();
  const conv = convData.conversations?.[0];
  if (conv) {
    console.log(`Conversación ID: ${conv.id}`);
    const msgRes = await fetch(`https://services.leadconnectorhq.com/conversations/${conv.id}/messages?limit=5`, { headers: HEADERS });
    const msgData = await msgRes.json();
    const msgs = msgData.messages?.messages || [];
    console.log(`Últimos ${msgs.length} mensajes:`);
    for (const m of msgs) {
      console.log(`  • [${m.dateAdded}] [${m.direction}]: ${String(m.body || '').slice(0, 80)}`);
    }
  } else {
    console.log(`Sin conversación registrada.`);
  }

  // vTiger
  console.log(`\n🏢 Consultando vTiger...`);
  try {
    const v = await findVTigerContact(contact);
    if (v) {
      console.log(`vTiger ID: ${v.id}`);
      console.log(`vTiger cf_1876 (Tiene Venta?): ${v.cf_1876}`);
      console.log(`vTiger cf_994 (Status): ${v.cf_994}`);
      console.log(`vTiger cf_2610 (Producto/Campaña): ${v.cf_2610}`);
      console.log(`vTiger spl_num_compras: ${v.spl_num_compras}`);
      console.log(`vTiger spl_fecha_primera_compra: ${v.spl_fecha_primera_compra}`);
      console.log(`vTiger spl_fecha_ultima_compra: ${v.spl_fecha_ultima_compra}`);
    } else {
      console.log(`vTiger: Contacto no existe en vTiger.`);
    }
  } catch (e) {
    console.log(`Error vTiger: ${e.message}`);
  }
}

async function run() {
  await inspectContact('Alfredo Lopez');
  await inspectContact('Marisol Degollado');
}

run();
