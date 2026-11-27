#!/usr/bin/env node
/**
 * ==============================================================================
 * RADAR N1 LOCAL — etiqueta en vivo los chats que entran (sin servidor)
 * ==============================================================================
 * Cada N segundos revisa los contactos MÁS RECIENTES de cada subcuenta y rutea
 * los que están sin etiquetar (o marcados `revisar-ruteo`).
 *
 * Sirve mientras Render está apagado: el webhook de Meta no llega a tu máquina,
 * pero el radar local detecta el contacto nuevo igual (porque ya está en GHL).
 *
 * Uso:
 *   node tools/radar_n1_local.mjs                      (60 s, 4 sedes)
 *   node tools/radar_n1_local.mjs --intervalo=30
 *   node tools/radar_n1_local.mjs --sedes=PALACIOS
 *
 * Obedece la pausa de runner_control (pausar_trabajos.bat).
 * ==============================================================================
 */
import 'dotenv/config';
import { SEDES_GATEWAY } from '../src/config/index.js';
import { routeChatByContact } from '../src/agents/chat_router_agent.js';
import { estaPausado } from './runner_control.mjs';

const op = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) op[m[1]] = m[2] === undefined ? true : m[2];
}
const INTERVALO = Math.min(Math.max(parseInt(op.intervalo || '20', 10) || 20, 10), 600);
const SEDES = (op.sedes ? String(op.sedes).toUpperCase().split(',') : ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'])
  .filter(s => SEDES_GATEWAY[s]?.ghl?.locationId);
const POR_PAGINA = Math.min(Math.max(parseInt(op.limite || '30', 10) || 30, 5), 50);
// [SIN DEMORA] Varias fichas a la vez: un ruteo tarda 2-4 s y si se hace de uno en
// uno, una ráfaga de 20 contactos deja al último esperando más de un minuto.
const CONC = Math.min(Math.max(parseInt(op.concurrencia || '3', 10) || 3, 1), 8);
const BASE = 'https://services.leadconnectorhq.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const yaVistos = new Map(); // contactId -> ts del último intento
const intentos = new Map(); // contactId -> nº de intentos sin lograr proveedor
const MAX_INTENTOS = 6;     // tras 6 vueltas (≈90 s) se deja de reintentar
const COOLDOWN_MS = 10 * 60000;
// [MÉTRICA DE DEMORA] Segundos desde que el contacto nace en GHL hasta quedar
// etiquetado. Es el número que importa: si crece, el radar no da abasto.
const retardos = [];
let retardoMax = 0;
const hora = () => new Date().toLocaleTimeString('es-PE');

function resumenRetardo() {
  if (retardos.length === 0) return 'sin datos';
  const prom = Math.round(retardos.reduce((a, b) => a + b, 0) / retardos.length);
  const orden = [...retardos].sort((a, b) => a - b);
  const p90 = orden[Math.floor(orden.length * 0.9)] || orden[orden.length - 1];
  return `promedio ${prom}s · p90 ${p90}s · máximo ${retardoMax}s (n=${retardos.length})`;
}

console.log('='.repeat(70));
console.log(`RADAR N1 LOCAL · sedes: ${SEDES.join(', ')} · cada ${INTERVALO}s · ${POR_PAGINA} recientes`);
console.log('='.repeat(70));

let vueltas = 0, totalEtiquetados = 0;

while (true) {
  vueltas++;
  for (const sede of SEDES) {
    if (estaPausado(sede).pausado) continue;
    const cfg = SEDES_GATEWAY[sede];
    const h = { Authorization: `Bearer ${cfg.ghl.apiKey}`, Version: '2021-07-28', Accept: 'application/json' };

    let contactos = [];
    try {
      const r = await fetch(`${BASE}/contacts/?locationId=${cfg.ghl.locationId}&limit=${POR_PAGINA}`, { headers: h });
      if (!r.ok) { console.warn(`[${sede}] HTTP ${r.status} al listar`); continue; }
      contactos = (await r.json()).contacts || [];
    } catch (e) { console.warn(`[${sede}] listar: ${e.message}`); continue; }

    const pendientes = contactos.filter(c => {
      const tags = (c.tags || []).map(t => String(t).toLowerCase());
      // [CONTRATO 27/11] Lo único imprescindible es `prov-*`. Antes se exigía
      // también `canal-*`, etiqueta que ya no existe: eso hacía que el radar
      // reprocesara TODA la base en cada vuelta (de ahí los retardos de +180m).
      const tieneProv = tags.some(t => t.startsWith('prov-'));
      if (tieneProv) return false;
      const ultimo = yaVistos.get(c.id) || 0;
      return Date.now() - ultimo > COOLDOWN_MS;
    });

    if (pendientes.length === 0) continue;

    // [SIN DEMORA] Se procesan en tandas de CONC y se mide el retraso real:
    // desde que el contacto se creó en GHL hasta que quedó etiquetado.
    for (let i = 0; i < pendientes.length; i += CONC) {
      const tanda = pendientes.slice(i, i + CONC);
      const res = await Promise.all(tanda.map(async (c) => {
        const alta = c.dateAdded ? new Date(c.dateAdded).getTime() : null;
        try {
          const t0 = Date.now();
          await routeChatByContact(c.id, false, false, { locationId: cfg.ghl.locationId, origen: 'radar-local' });
          const msRuteo = Date.now() - t0;
          const d = await (await fetch(`${BASE}/contacts/${c.id}`, { headers: h })).json();
          const t = (d.contact?.tags || []);
          const prov = t.find(x => x.startsWith('prov-')) || '';
          // [SIN DEMORA REAL] Si el contacto quedó SIN proveedor (conversación aún no
          // indexada), NO se marca como visto: se reintenta en la próxima vuelta (15 s)
          // en vez de esperar 10 minutos. Tras MAX_INTENTOS se deja de insistir.
          if (prov) {
            yaVistos.set(c.id, Date.now());
            intentos.delete(c.id);
          } else {
            const n = (intentos.get(c.id) || 0) + 1;
            intentos.set(c.id, n);
            if (n >= MAX_INTENTOS) { yaVistos.set(c.id, Date.now()); intentos.delete(c.id); }
          }
          totalEtiquetados++;
          const seg = alta ? Math.round((Date.now() - alta) / 1000) : null;
          if (seg !== null) { retardos.push(seg); if (seg > retardoMax) retardoMax = seg; }
          return {
            nombre: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.id,
            canal: t.find(x => x.startsWith('canal-')) || '',
            prov: prov || '—',
            prod: t.find(x => x.startsWith('producto-')) || '',
            page: (t.find(x => x.startsWith('pagina-')) || '').replace('pagina-', ''),
            alta, seg,
            pendiente: !prov,
            msRuteo
          };
        } catch (e) {
          return { nombre: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.id, error: e.message.slice(0, 50), alta };
        }
      }));

      for (const r of res) {
        if (r.error) { console.log(`[${hora()}] [${sede}] ${r.nombre}: ERROR ${r.error}`); continue; }
        const marca = r.seg === null ? '' : (r.seg <= 60 ? ` +${r.seg}s` : r.seg <= 300 ? ` +${Math.round(r.seg / 60)}m` : ` +${Math.round(r.seg / 60)}m ⚠`);
        const estado = r.pendiente ? ' (sin proveedor aún, se reintenta)' : '';
        const ruteo = r.msRuteo ? ` · ruteo ${(r.msRuteo / 1000).toFixed(1)}s` : '';
        console.log(`[${hora()}] [${sede}] ${r.nombre}: ${r.prov} · ${r.page || 'sin página'}${r.prod ? ' · ' + r.prod : ''}${marca}${ruteo}${estado}`);
      }
    }
  }

  if (vueltas % 10 === 0) console.log(`[radar] vuelta ${vueltas} · etiquetados ${totalEtiquetados} · demora: ${resumenRetardo()}`);
  await sleep(INTERVALO * 1000);
}
