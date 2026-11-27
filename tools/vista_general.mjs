#!/usr/bin/env node
/**
 * ==============================================================================
 * VISTA GENERAL — "los ojos" en la bandeja de una subcuenta de GHL
 * ==============================================================================
 * Muestra TODAS las conversaciones de la subcuenta ordenadas por último mensaje,
 * como las ve un usuario de GHL: quién escribe, por qué canal, con qué etiquetas
 * de proveedor/página y qué dijo.
 *
 * Uso:
 *   node tools/vista_general.mjs                        (Palacios, 25 conversaciones)
 *   node tools/vista_general.mjs --sede=BENAVIDES --limite=40
 *   node tools/vista_general.mjs --canal=messenger       (filtra por canal)
 *   node tools/vista_general.mjs --watch=30              (refresca cada 30 s)
 *   node tools/vista_general.mjs --sin-leer              (solo con mensajes sin leer)
 * ==============================================================================
 */
import 'dotenv/config';
import { SEDES_GATEWAY } from '../src/config/index.js';

const op = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) op[m[1]] = m[2] === undefined ? true : m[2];
}
const SEDE = String(op.sede || 'PALACIOS').toUpperCase();
const LIMITE = Math.min(Math.max(parseInt(op.limite || '25', 10) || 25, 5), 100);
const WATCH = op.watch ? Math.max(parseInt(op.watch, 10) || 30, 5) : 0;
const CANAL = op.canal ? String(op.canal).toLowerCase() : null;
const SOLO_SIN_LEER = Boolean(op['sin-leer']);
// [VISTA PERSONALIZADA] --prov=ernesto --tratamiento=diabetes --canal=messenger
const PROV_FILTRO = op.prov ? String(op.prov).toLowerCase().replace(/^prov-/, '').split(',').map(s => `prov-${s.trim()}`) : null;
const TRAT_FILTRO = op.tratamiento ? String(op.tratamiento).toLowerCase().split(',').map(s => s.trim().replace(/^producto-/, '')).filter(Boolean) : null;
// [ANS] Minutos de espera a partir de los cuales se marca la conversación.
// La urgencia se mide con el tiempo real de respuesta, no con etiquetas subjetivas.
const ANS_MIN = Math.max(parseInt(op.ans || '15', 10) || 15, 1);

const BASE = 'https://services.leadconnectorhq.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cfg = SEDES_GATEWAY[SEDE];
if (!cfg?.ghl?.locationId) throw new Error(`Sede ${SEDE} sin credenciales en .env`);
const h = { Authorization: `Bearer ${cfg.ghl.apiKey}`, Version: '2021-07-28', Accept: 'application/json' };

const CANALES = {
  TYPE_FACEBOOK: 'Messenger',
  TYPE_INSTAGRAM: 'Instagram',
  TYPE_WHATSAPP: 'WhatsApp',
  TYPE_SMS: 'SMS',
  TYPE_EMAIL: 'Email',
  TYPE_CALL: 'Llamada',
  TYPE_ACTIVITY_OPPORTUNITY: 'Actividad',
  TYPE_ACTIVITY_CONTACT: 'Actividad'
};

function hora(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  const hoy = new Date();
  const mismoDia = d.toDateString() === hoy.toDateString();
  return mismoDia
    ? d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
}

async function pintar() {
  // Diccionario de campos: se necesita el ID de "Tratamiento comprado" para filtrar.
  let idTratamiento = null;
  if (TRAT_FILTRO) {
    try {
      const dic = await (await fetch(`${BASE}/locations/${cfg.ghl.locationId}/customFields`, { headers: h })).json();
      idTratamiento = (dic.customFields || []).find(f => /tratamiento/i.test(String(f.name)) && !/orden/i.test(String(f.name)))?.id || null;
    } catch { /* se filtra solo por proveedor */ }
  }

  const r = await fetch(`${BASE}/conversations/search?locationId=${cfg.ghl.locationId}&limit=${Math.min(LIMITE * 3, 100)}&sortBy=last_message_date&sort=desc`, { headers: h });
  if (!r.ok) { console.error(`HTTP ${r.status} al leer conversaciones`); return; }
  const data = await r.json();
  let convs = data.conversations || [];
  if (SOLO_SIN_LEER) convs = convs.filter(c => (c.unreadCount || 0) > 0);
  if (CANAL) {
    const map = { messenger: 'TYPE_FACEBOOK', instagram: 'TYPE_INSTAGRAM', whatsapp: 'TYPE_WHATSAPP', sms: 'TYPE_SMS', email: 'TYPE_EMAIL' };
    const tipo = map[CANAL] || CANAL.toUpperCase();
    convs = convs.filter(c => String(c.lastMessageType || '').toUpperCase().includes(tipo.replace('TYPE_', '')));
  }

  // [FILTRO POR PROVEEDOR / TRATAMIENTO] Se aplica después de traer el contacto,
  // porque el proveedor es una etiqueta y el tratamiento un custom field.
  const aplicarFiltros = (c) => {
    const i = info.get(c.id) || {};
    if (PROV_FILTRO && !PROV_FILTRO.includes(String(i.prov || '').toLowerCase())) return false;
    if (TRAT_FILTRO) {
      const t = String(i.tratamiento || '').toLowerCase();
      if (!TRAT_FILTRO.some(x => t.includes(x))) return false;
    }
    return true;
  };

  // Nombre y etiquetas del contacto (en tandas de 5 para no saturar).
  const info = new Map();
  for (let i = 0; i < convs.length; i += 5) {
    const tanda = convs.slice(i, i + 5);
    const res = await Promise.all(tanda.map(async c => {
      try {
        const d = await (await fetch(`${BASE}/contacts/${c.contactId}`, { headers: h })).json();
        const ct = d.contact || {};
        const tags = (ct.tags || []).map(t => String(t));
        const cf = ct.customFields || [];
        const tratamiento = String(
          cf.find(x => x.id === idTratamiento)?.value ?? cf.find(x => x.id === idTratamiento)?.field_value ?? ''
        ).trim();

        // [ANS] Último mensaje: si es del lead (inbound) está esperando respuesta.
        let espera = null;
        try {
          const mv = await (await fetch(`${BASE}/conversations/${c.id}/messages?limit=1`, { headers: h })).json();
          const arr = mv.messages?.messages || (Array.isArray(mv.messages) ? mv.messages : []);
          const ult = arr[0];
          if (ult) {
            const min = Math.max(0, Math.round((Date.now() - new Date(ult.dateAdded).getTime()) / 60000));
            if (String(ult.direction).toLowerCase() === 'inbound') espera = min;
          }
        } catch { /* sin dato de espera */ }

        return [c.id, {
          nombre: `${ct.firstName || ''} ${ct.lastName || ''}`.trim() || '(sin nombre)',
          tel: ct.phone || '',
          prov: tags.find(t => t.toLowerCase().startsWith('prov-')) || '',
          page: tags.find(t => t.toLowerCase().startsWith('pagina-')) || '',
          tratamiento,
          espera
        }];
      } catch { return [c.id, { nombre: '(error)', tel: '', prov: '', page: '', tratamiento: '', espera: null }]; }
    }));
    for (const [k, v] of res) info.set(k, v);
    await sleep(120);
  }

  // [VISTA PERSONALIZADA] proveedor + tratamiento, y recorte al límite pedido.
  if (PROV_FILTRO || TRAT_FILTRO) convs = convs.filter(aplicarFiltros);
  convs = convs.slice(0, LIMITE);

  const porCanal = {};
  let sinLeer = 0;
  for (const c of convs) {
    const canal = CANALES[String(c.lastMessageType || '').toUpperCase()] || c.lastMessageType || '—';
    porCanal[canal] = (porCanal[canal] || 0) + 1;
    sinLeer += (c.unreadCount || 0);
  }

  console.log('\n' + '='.repeat(118));
  console.log(`BANDEJA GENERAL · ${SEDE} · ${convs.length} conversaciones · sin leer: ${sinLeer}`);
  console.log(`por canal: ${Object.entries(porCanal).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`);
  console.log('='.repeat(118));
  console.log('HORA          CANAL       CONTACTO                PROVEEDOR        TRATAMIENTO    PÁGINA                       ANS       ÚLTIMO MENSAJE');
  console.log('-'.repeat(138));

  for (const c of convs) {
    const i = info.get(c.id) || {};
    const canal = (CANALES[String(c.lastMessageType || '').toUpperCase()] || c.lastMessageType || '—').padEnd(11).slice(0, 11);
    const nombre = (i.nombre || '').padEnd(22).slice(0, 22);
    const prov = (i.prov || '—').padEnd(16).slice(0, 16);
    const trat = (i.tratamiento || '—').padEnd(14).slice(0, 14);
    const page = (i.page || '—').replace('pagina-', '').padEnd(28).slice(0, 28);
    const cuerpo = String(c.lastMessageBody || '').replace(/\s+/g, ' ').slice(0, 26);
    const noLeido = (c.unreadCount || 0) > 0 ? ` [${c.unreadCount}]` : '';
    // [ANS] Minutos que lleva esperando el lead. Vacío = la última palabra es nuestra.
    const e = i.espera;
    const ans = (e === null || e === undefined) ? ''.padEnd(9) : (e >= ANS_MIN ? `!${e}m`.padEnd(9) : `${e}m`.padEnd(9));
    console.log(`${hora(c.lastMessageDate)}  ${canal} ${nombre} ${prov} ${trat} ${page} ${ans} ${cuerpo}${noLeido}`);
  }
  console.log('-'.repeat(118));
  const conProv = convs.filter(c => (info.get(c.id)?.prov || '')).length;
  const conPage = convs.filter(c => (info.get(c.id)?.page || '')).length;
  console.log(`cobertura en esta vista: proveedor ${conProv}/${convs.length} · página ${conPage}/${convs.length}`);
}

await pintar();
if (WATCH) {
  console.log(`\n[watch] refrescando cada ${WATCH}s · Ctrl+C para salir`);
  while (true) { await sleep(WATCH * 1000); await pintar(); }
}
process.exit(0);
