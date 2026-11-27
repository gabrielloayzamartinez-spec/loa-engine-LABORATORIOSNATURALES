#!/usr/bin/env node
/**
 * ==============================================================================
 * RUNNER N2 — TRABAJA LA COLA ATRASADA DEL NIVEL 2 EN TU MÁQUINA
 * ==============================================================================
 * Recorre, por orden de valor, TODA la cartera de vTiger y re-publica cada ficha
 * en GHL (contacto + todos sus CF). Es idempotente: si una ficha ya está bien,
 * reescribirla no rompe nada.
 *
 * ORDEN
 *   1. Compradores de los años recientes (2026 → 2019)
 *   2. Contactos (leads sin venta) de los años recientes (2026 → 2019)
 *   Por sede configurada en el .env (Palacios, Benavides; Roosevelt/Piura si están).
 *
 * GARANTÍAS
 *   · Reanudable: guarda el avance en scratch/runner_n2.json
 *   · Respeta la cuota de cada subcuenta (se pausa si no hay margen)
 *   · Se puede cortar con Ctrl+C: guarda y sale limpio
 *
 * Uso:
 *   node tools/runner_n2.mjs                 # corre hasta terminar (o cuota)
 *   node tools/runner_n2.mjs --limite=50     # fichas por página
 *   node tools/runner_n2.mjs --rate=1.5      # ritmo (llamadas/seg)
 *   node tools/runner_n2.mjs --solo=PALACIOS
 * ==============================================================================
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { SEDES_GATEWAY } from '../src/config/index.js';
import { query, VTIGER_CONTACT_SELECT, VTIGER_FIELDS, VTIGER_SEDES_VALIDAS } from '../src/services/vtigerClient.js';
import { syncVtigerContactDual } from '../src/services/dual_sync_service.js';
import { hayCuotaRealDeFondo } from '../src/utils/ghl_http_client.js';
import { estaPausado } from './runner_control.mjs';

const op = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) op[m[1]] = m[2] === undefined ? true : m[2];
}
const LIMITE = Math.min(Math.max(parseInt(op.limite || '50', 10) || 50, 5), 100);
const RATE = Math.min(Math.max(parseFloat(op.rate || '2') || 2, 0.2), 10);
// La cuota no es el límite (usamos ~4k llamadas/hora de 120k): el límite es la
// latencia de cada ficha (2-3 llamadas). Procesar en paralelo multiplica el caudal.
const CONC = Math.min(Math.max(parseInt(op.concurrencia || '4', 10) || 4, 1), 10);
const SOLO = op.solo ? String(op.solo).toUpperCase() : null;
const ANOS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019];
// --tipo=contactos|compradores permite priorizar el universo que realmente falta
// (p. ej. en Roosevelt/Piura los compradores ya están al 97% y los leads al 10%).
const TIPOS = op.tipo
  ? [String(op.tipo).toLowerCase()].filter(t => ['contactos', 'compradores'].includes(t))
  : ['compradores', 'contactos'];

const DIR = path.join(process.cwd(), 'scratch');
// Estado SEPARADO por sede y tipo cuando se corre en paralelo, para que dos
// procesos no se pisen el cursor.
const ESTADO = path.join(DIR, SOLO
  ? `runner_n2_${SOLO}${op.tipo ? '_' + String(op.tipo).toLowerCase() : ''}.json`
  : 'runner_n2.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pausa = () => sleep(Math.round(1000 / RATE));

// --------------------------------------------------------------------------
// PLAN: sede × tipo × año, con los compradores y los años recientes primero
// --------------------------------------------------------------------------
const sedes = VTIGER_SEDES_VALIDAS
  .filter(s => !SOLO || s === SOLO)
  .filter(s => SEDES_GATEWAY[s]?.ghl?.locationId && SEDES_GATEWAY[s]?.ghl?.apiKey);

const plan = [];
for (const sede of sedes) {
  for (const tipo of TIPOS) {
    for (const ano of ANOS) plan.push({ sede, tipo, ano });
  }
}

function leerEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); }
  catch { return { idx: 0, offset: 0, totales: { ok: 0, fallidos: 0, omitidos: 0 }, desde: new Date().toISOString() }; }
}
function guardar(e) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(ESTADO, JSON.stringify(e, null, 2), 'utf8');
}

const estado = leerEstado();
let cortado = false;
process.on('SIGINT', () => {
  cortado = true;
  console.log('\n[RUNNER] Ctrl+C: guardando avance…');
  guardar(estado);
  console.log(`[RUNNER] Guardado en ${ESTADO}. Se retoma con el mismo comando.`);
  process.exit(0);
});

console.log('='.repeat(78));
console.log(`RUNNER N2 · sedes: ${sedes.join(', ') || 'NINGUNA'} · ${LIMITE} fichas/página · ${RATE}/s`);
console.log(`Pendientes de configurar: ${VTIGER_SEDES_VALIDAS.filter(s => !sedes.includes(s)).join(', ') || 'ninguna'}`);
console.log('='.repeat(78));

if (sedes.length === 0) {
  console.error('[RUNNER] No hay sedes con credenciales en el .env. Agrega GHL_LOCATION_ID_* y GHL_API_KEY_*.');
  process.exit(1);
}

let vueltasVacias = 0;
let pausaAvisada = false;
const inicio = Date.now();

while (estado.idx < plan.length && !cortado) {
  const paso = plan[estado.idx];
  const { sede, tipo, ano } = paso;

  // [PAUSA / REANUDAR] El usuario puede pausar desde otra ventana:
  //   node tools/runner_control.mjs pausar --minutos=60 --motivo="almuerzo"
  // El runner espera sin gastar cuota y sigue solo al reanudar (o al vencer).
  const estadoPausa = estaPausado(sede);
  if (estadoPausa.pausado) {
    if (!pausaAvisada) {
      console.log(`[RUNNER] ⏸ ${sede}: pausado (${estadoPausa.motivo}${estadoPausa.hasta ? ', hasta ' + new Date(estadoPausa.hasta).toLocaleTimeString('es-PE') : ''}). Esperando…`);
      pausaAvisada = true;
    }
    guardar(estado);
    await sleep(20000);
    continue;
  }
  if (pausaAvisada) {
    console.log(`[RUNNER] ▶ ${sede}: reanudado.`);
    pausaAvisada = false;
  }

  const filtroTipo = tipo === 'compradores'
    ? ` AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0`
    : ` AND ${VTIGER_FIELDS.NUM_COMPRAS} = 0`;
  const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts
             WHERE ${VTIGER_FIELDS.SEDE_ACTUAL} = '${sede}'${filtroTipo}
               AND createdtime >= '${ano}-01-01' AND createdtime < '${ano + 1}-01-01'
             ORDER BY id DESC LIMIT ${estado.offset}, ${LIMITE};`;

  let filas = [];
  try {
    filas = await query(q, { context: 'runner-n2' }) || [];
  } catch (err) {
    console.error(`[RUNNER] [${sede} ${tipo} ${ano}] consulta falló: ${err.message}. Se reintenta en 20 s.`);
    await sleep(20000);
    vueltasVacias++;
    if (vueltasVacias > 5) { estado.idx++; estado.offset = 0; vueltasVacias = 0; guardar(estado); }
    continue;
  }

  if (filas.length === 0) {
    console.log(`[RUNNER] ✔ ${sede} · ${tipo} · ${ano} terminado (${estado.offset} fichas recorridas).`);
    estado.idx++;
    estado.offset = 0;
    guardar(estado);
    continue;
  }

  // [CUOTA] Si la subcuenta no tiene margen, se espera sin perder el avance.
  if (!hayCuotaRealDeFondo(sede)) {
    console.log(`[RUNNER] ⏸ ${sede} sin cuota de fondo. Reintento en 60 s (avance guardado).`);
    guardar(estado);
    await sleep(60000);
    continue;
  }

  let ok = 0, fallidos = 0, omitidos = 0;
  // [CONCURRENCIA] Se procesan `CONC` fichas a la vez: la latencia por ficha
  // (2-3 llamadas) era el cuello de botella, no la cuota.
  for (let i = 0; i < filas.length && !cortado; i += CONC) {
    const grupo = filas.slice(i, i + CONC);
    const resultados = await Promise.all(grupo.map(async (v) => {
      try {
        const r = await syncVtigerContactDual(v, { permitirLead: true });
        if (r?.ok) return 'ok';
        if (r?.skipped) return 'omit';
        return 'fail';
      } catch { return 'fail'; }
    }));
    for (const r of resultados) {
      if (r === 'ok') ok++; else if (r === 'omit') omitidos++; else fallidos++;
    }
    await pausa();
  }

  estado.offset += filas.length;
  estado.totales.ok += ok;
  estado.totales.fallidos += fallidos;
  estado.totales.omitidos += omitidos;
  guardar(estado);

  const min = ((Date.now() - inicio) / 60000).toFixed(1);
  const ritmo = Math.round(estado.totales.ok / Math.max(parseFloat(min), 0.1));
  console.log(`[${sede} ${tipo} ${ano}] +${ok} ok · ${omitidos} omit · ${fallidos} fallos | acumulado ${estado.totales.ok} fichas · ${ritmo}/min · offset ${estado.offset}`);
}

guardar(estado);
const min = ((Date.now() - inicio) / 60000).toFixed(1);
console.log('='.repeat(78));
if (estado.idx >= plan.length) {
  console.log(`[RUNNER] ✅ COLA TERMINADA en ${min} min · ${estado.totales.ok} fichas sincronizadas.`);
} else {
  console.log(`[RUNNER] Pausado tras ${min} min · ${estado.totales.ok} fichas · próximo: ${plan[estado.idx]?.sede} ${plan[estado.idx]?.tipo} ${plan[estado.idx]?.ano} (offset ${estado.offset}).`);
}
console.log('='.repeat(78));
process.exit(0);
