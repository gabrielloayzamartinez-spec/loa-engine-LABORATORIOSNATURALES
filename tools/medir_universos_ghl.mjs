/**
 * LOS TRES UNIVERSOS DE GHL — medido, no supuesto.
 *
 * En cada subcuenta conviven:
 *   1. CHATS      → nacen en GHL (Messenger/IG/WSP). NUNCA están en vTiger.
 *   2. CONTACTOS  → personas de vTiger sin compra (leads).
 *   3. COMPRADORES→ personas de vTiger con compra.
 *
 * Este script toma una muestra de contactos de GHL y dice cuántos tienen par en
 * vTiger (por teléfono, oficina actual) y cuántos son solo-chat.
 *
 * SOLO LECTURA. node tools/medir_universos_ghl.mjs [muestra=100]
 */
import 'dotenv/config';
import { SEDES_GATEWAY } from '../src/config/index.js';
import { query, VTIGER_CONTACT_SELECT, VTIGER_FIELDS } from '../src/services/vtigerClient.js';

const SEDES = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];
const N = Math.max(20, parseInt(process.argv[2] || '100', 10));
const BASE = 'https://services.leadconnectorhq.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digitos = v => String(v || '').replace(/\D/g, '');

async function buscarVtiger(sede, teles) {
  for (const t of teles) {
    const last10 = t.slice(-10);
    const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.SEDE_ACTUAL} = '${sede}' AND ${VTIGER_FIELDS.HOME_PHONE} = '${last10}' LIMIT 1;`;
    try {
      const r = await query(q, { context: 'universos' });
      if (r?.[0]) return r[0];
    } catch { /* sigue con el siguiente teléfono */ }
    await sleep(60);
  }
  return null;
}

const salida = [];
for (const sede of SEDES) {
  const loc = SEDES_GATEWAY[sede]?.ghl?.locationId;
  const key = SEDES_GATEWAY[sede]?.ghl?.apiKey;
  if (!loc || !key) { console.log(`[SKIP] ${sede}: sin credenciales locales`); continue; }
  const h = { Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json' };

  // Contactos MÁS RECIENTES de la subcuenta (los chats entran por aquí).
  const d = await (await fetch(`${BASE}/contacts/?locationId=${loc}&limit=${Math.min(N, 100)}`, { headers: h })).json();
  const contactos = d.contacts || [];

  let conVtiger = 0, compradores = 0, leads = 0, soloChat = 0, sinTelefono = 0;
  for (const c of contactos) {
    const teles = [c.phone].map(digitos).filter(t => t.length >= 10);
    if (!teles.length) { sinTelefono++; continue; }
    const v = await buscarVtiger(sede, teles);
    if (!v) { soloChat++; continue; }
    conVtiger++;
    if ((parseInt(v.spl_num_compras || '0', 10) || 0) > 0) compradores++;
    else leads++;
    await sleep(80);
  }

  const pct = n => Math.round((n / contactos.length) * 1000) / 10;
  salida.push({
    sede,
    muestra: contactos.length,
    'con par en vTiger': `${conVtiger} (${pct(conVtiger)}%)`,
    '· compradores': compradores,
    '· leads': leads,
    'SOLO CHAT (no está en vTiger)': `${soloChat} (${pct(soloChat)}%)`,
    'sin teléfono': sinTelefono
  });
  console.log(`${sede}: ${contactos.length} contactos → ${conVtiger} con par en vTiger (${compradores} compradores / ${leads} leads), ${soloChat} solo-chat, ${sinTelefono} sin teléfono.`);
}

console.log('');
console.table(salida);
process.exit(0);
