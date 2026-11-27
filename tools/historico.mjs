#!/usr/bin/env node
/**
 * ==============================================================================
 * HISTÓRICO POR AÑO — DETECTAR LO QUE FALTA Y SINCRONIZARLO (NIVEL 2)
 * ==============================================================================
 * Para cada sede y cada año responde: ¿cuántos compradores de vTiger NO están en
 * GHL? y luego los sincroniza con TODOS sus CF + historial de órdenes.
 *
 * Dos fases separadas (así se puede medir sin gastar en escrituras):
 *   1. DETECTAR   (solo lectura)  → recorre vTiger por año y busca cada teléfono en
 *                                   GHL. Guarda la lista de faltantes en disco.
 *   2. SINCRONIZAR (escribe)      → toma los faltantes y ejecuta el dual sync
 *                                   (contacto + CF + órdenes).
 *
 * Uso:
 *   node tools/historico.mjs detectar --sede=PALACIOS --ano=2023 [--limite=200]
 *   node tools/historico.mjs sincronizar --sede=PALACIOS --ano=2023 [--limite=50] [--ejecutar]
 *   node tools/historico.mjs estado
 *
 * Reanudable: guarda el avance en scratch/historico/<SEDE>_<ANO>.json
 * ==============================================================================
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { SEDES_GATEWAY } from '../src/config/index.js';
import { query as vtigerQuery, VTIGER_CONTACT_SELECT, VTIGER_FIELDS, VTIGER_SEDES_VALIDAS, sedeClause } from '../src/services/vtigerClient.js';
import { syncVtigerContactDual } from '../src/services/dual_sync_service.js';
import { hayCuotaRealDeFondo, getRepartoCuota } from '../src/utils/ghl_http_client.js';

const argv = process.argv.slice(2);
const fase = (argv[0] || 'estado').toLowerCase();
const op = {};
for (const a of argv.slice(1)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) op[m[1]] = m[2] === undefined ? true : m[2];
}

const SEDE = String(op.sede || '').toUpperCase();
const ANO = parseInt(op.ano || '0', 10);
const LIMITE = Math.min(Math.max(parseInt(op.limite || '50', 10) || 50, 1), 200);
const RATE = Math.min(Math.max(parseFloat(op.rate || '2') || 2, 0.2), 10);
const EJECUTAR = String(op.ejecutar || '').toLowerCase() === 'true';

/**
 * [COMPRADORES ≠ CONTACTOS] Son dos universos distintos y se sincronizan distinto:
 *   compradores → persona que YA compró (spl_num_compras > 0)
 *   contactos   → lead con teléfono y SIN compra (spl_num_compras = 0)
 *   ambos       → todo el padrón
 * El teléfono es la llave: un contacto sin teléfono no es sincronizable.
 */
const TIPO = String(op.tipo || 'compradores').toLowerCase();
function filtroTipo() {
  const campo = VTIGER_FIELDS.NUM_COMPRAS;
  if (TIPO === 'contactos') return ` AND ${campo} = 0`;
  if (TIPO === 'ambos') return '';
  return ` AND ${campo} > 0`;
}
const ETIQUETA_TIPO = TIPO === 'contactos' ? 'contactos (leads sin compra)' : TIPO === 'ambos' ? 'padrón completo' : 'compradores';

/**
 * [SEDE ACTUAL — 27/11] Por defecto se recorre por OFICINA ACTUAL (cf_3590), que es
 * la que manda para la subcuenta destino: 139.562 fichas de Palacios fueron
 * reasignadas a otra oficina. `--por=original` usa la oficina de registro (cf_3451)
 * sólo para comparar/auditar.
 */
const POR = String(op.por || 'actual').toLowerCase() === 'original' ? 'original' : 'actual';
function clausulaSede() {
  const campo = POR === 'original' ? VTIGER_FIELDS.SEDE : VTIGER_FIELDS.SEDE_ACTUAL;
  return `${campo} = '${SEDE}'`;
}
const ETIQUETA_SEDE = POR === 'original' ? 'sede de REGISTRO' : 'sede ACTUAL';
const BASE = 'https://services.leadconnectorhq.com';
const DIR = path.join(process.cwd(), 'scratch', 'historico');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const digitos = v => String(v || '').replace(/\D/g, '');
const pausa = () => sleep(Math.round(1000 / RATE));

function archivo(sede, ano) { return path.join(DIR, `${sede}_${TIPO}_${POR}_${ano}.json`); }
function leer(sede, ano) {
  try { return JSON.parse(fs.readFileSync(archivo(sede, ano), 'utf8')); }
  catch { return { sede, tipo: TIPO, por: POR, ano, offset: 0, revisados: 0, encontrados: 0, faltantes: [], sincronizados: 0, fallidos: 0, desde: new Date().toISOString() }; }
}
function guardar(estado) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(archivo(estado.sede, estado.ano), JSON.stringify(estado, null, 2), 'utf8');
}

function headers(sede) {
  const apiKey = SEDES_GATEWAY[sede]?.ghl?.apiKey;
  const loc = SEDES_GATEWAY[sede]?.ghl?.locationId;
  if (!apiKey || !loc) throw new Error(`La sede ${sede} no tiene credenciales en .env`);
  return { loc, h: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' } };
}

async function existeEnGhl(loc, h, telefonos) {
  for (const d of telefonos) {
    const last10 = d.slice(-10);
    let r = null;
    try {
      r = await fetch(`${BASE}/contacts/?locationId=${loc}&query=${last10}`, { headers: h });
    } catch {
      // Fallo de red puntual: se reintenta UNA vez antes de decidir.
      await sleep(400);
      try { r = await fetch(`${BASE}/contacts/?locationId=${loc}&query=${last10}`, { headers: h }); } catch { continue; }
    }
    if (!r || !r.ok) continue;
    const data = await r.json().catch(() => ({}));
    if ((data.contacts || []).some(c => digitos(c.phone).endsWith(last10))) return true;
    await sleep(80);
  }
  return false;
}

function telefonosDe(v) {
  const out = [];
  for (const x of [v.homephone, v.mobile, v.phone, v.otherphone]) {
    const d = digitos(x);
    if (d.length >= 10) out.push(d);
  }
  return [...new Set(out)];
}

// ------------------------------------------------------------------------------
// FASE 1 — DETECTAR
// ------------------------------------------------------------------------------
async function detectar() {
  if (!VTIGER_SEDES_VALIDAS.includes(SEDE) || !ANO) throw new Error('Indica --sede=... y --ano=AAAA');
  const { loc, h } = headers(SEDE);
  const estado = leer(SEDE, ANO);

  const desde = `${ANO}-01-01`;
  const hasta = `${ANO + 1}-01-01`;
  const q = `SELECT id, firstname, lastname, homephone, mobile, phone, otherphone, createdtime, spl_num_compras
             FROM Contacts
             WHERE ${clausulaSede()}${filtroTipo()}
               AND createdtime >= '${desde}' AND createdtime < '${hasta}'
             ORDER BY id DESC LIMIT ${estado.offset}, ${LIMITE};`;

  const filas = await vtigerQuery(q, { context: 'historico-detectar' }) || [];
  if (filas.length === 0) {
    console.log(`[FIN] ${SEDE} ${ANO} (${ETIQUETA_TIPO}): no hay más filas desde el offset ${estado.offset}.`);
    console.log(`[RESUMEN] revisados=${estado.revisados} encontrados=${estado.encontrados} faltantes=${estado.faltantes.length}`);
    return;
  }

  let faltanAqui = 0;
  for (const v of filas) {
    const teles = telefonosDe(v);
    if (teles.length === 0) continue;
    const existe = await existeEnGhl(loc, h, teles);
    if (!existe) {
      estado.faltantes.push({ id: v.id, nombre: `${v.firstname || ''} ${v.lastname || ''}`.trim(), createdtime: v.createdtime });
      faltanAqui++;
    } else {
      estado.encontrados++;
    }
    estado.revisados++;
    await pausa();
  }

  estado.offset += filas.length;
  guardar(estado);

  const pct = estado.revisados ? Math.round((estado.faltantes.length / estado.revisados) * 100) : 0;
  console.log(`[${SEDE} ${ANO} · ${ETIQUETA_TIPO}] revisados ${estado.revisados} | en GHL ${estado.encontrados} | FALTAN ${estado.faltantes.length} (${pct}%) | este lote: ${faltanAqui} | offset ${estado.offset}`);
  if (filas.length < LIMITE) console.log(`[FIN] ${SEDE} ${ANO}: último lote. Ejecuta la fase sincronizar.`);
}

// ------------------------------------------------------------------------------
// FASE 2 — SINCRONIZAR
// ------------------------------------------------------------------------------
async function sincronizar() {
  if (!VTIGER_SEDES_VALIDAS.includes(SEDE) || !ANO) throw new Error('Indica --sede=... y --ano=AAAA');
  const estado = leer(SEDE, ANO);
  if (estado.faltantes.length === 0) {
    console.log(`[VACÍO] ${SEDE} ${ANO}: no hay faltantes detectados. Corre primero la fase "detectar".`);
    return;
  }

  const pendientes = estado.faltantes.slice(0, LIMITE);
  console.log(`\n=== SINCRONIZAR ${SEDE} ${ANO} — ${pendientes.length} de ${estado.faltantes.length} faltantes (${EJECUTAR ? 'EJECUTANDO' : 'DRY-RUN'}) ===`);

  let ok = 0, omitidos = 0, fallidos = 0, sinCuota = 0;
  const hechos = [];

  for (const f of pendientes) {
    if (!hayCuotaRealDeFondo(SEDE)) { sinCuota++; break; }

    // Se relee la ficha completa: el payload debe ser el estado ACTUAL de vTiger.
    let registro = null;
    try {
      const r = await vtigerQuery(
        `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${SEDE}' AND id = '${String(f.id).replace(/[^A-Za-z0-9]/g, '')}' LIMIT 1;`,
        { context: 'historico-sync' }
      );
      registro = r?.[0] || null;
    } catch { registro = null; }
    if (!registro) { omitidos++; continue; }

    if (!EJECUTAR) { ok++; hechos.push(f.id); await pausa(); continue; }

    try {
      const res = await syncVtigerContactDual(registro, { permitirLead: false });
      if (res?.ok) { ok++; hechos.push(f.id); }
      else if (res?.skipped) omitidos++;
      else fallidos++;
    } catch { fallidos++; }
    await pausa();
  }

  // Se retiran de la lista sólo los que quedaron resueltos Y se escribió de verdad.
  // (En dry-run la lista NO se toca: es la fuente de verdad del faltante.)
  if (EJECUTAR && hechos.length > 0) {
    const resueltos = new Set(hechos);
    estado.faltantes = estado.faltantes.filter(f => !resueltos.has(f.id));
    estado.sincronizados += ok;
    estado.fallidos += fallidos;
    guardar(estado);
  }

  console.log(`[RESULTADO] ok=${ok} omitidos=${omitidos} fallidos=${fallidos} sinCuota=${sinCuota} | quedan ${estado.faltantes.length}`);
  if (!EJECUTAR) console.log('[!] Dry-run: agrega --ejecutar para escribir en GHL.');
  if (sinCuota) console.log('[!] Se detuvo por cuota de la subcuenta. Reintenta más tarde.');
}

// ------------------------------------------------------------------------------
// FASE 3 — ENRIQUECER (re-sincroniza los que YA están, para llenar sus CF)
// ------------------------------------------------------------------------------
/**
 * La diferencia con `sincronizar`: aquí no se usan los "faltantes", se recorre TODO
 * el año y se re-publica cada ficha que existe en GHL. Es lo que llena los campos
 * nuevos (Fecha Creación DATE, Estado de Compra, Fuente Última Orden) y completa
 * fechas/montos en la cartera que ya estaba sincronizada.
 */
async function enriquecer() {
  if (!VTIGER_SEDES_VALIDAS.includes(SEDE) || !ANO) throw new Error('Indica --sede=... y --ano=AAAA');
  const archivoEnrich = path.join(DIR, `${SEDE}_${TIPO}_${POR}_${ANO}_enrich.json`);
  let estado;
  try { estado = JSON.parse(fs.readFileSync(archivoEnrich, 'utf8')); }
  catch { estado = { sede: SEDE, tipo: TIPO, por: POR, ano: ANO, offset: 0, ok: 0, omitidos: 0, fallidos: 0, desde: new Date().toISOString() }; }

  const desde = `${ANO}-01-01`;
  const hasta = `${ANO + 1}-01-01`;
  const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts
             WHERE ${clausulaSede()}${filtroTipo()}
               AND createdtime >= '${desde}' AND createdtime < '${hasta}'
             ORDER BY id DESC LIMIT ${estado.offset}, ${LIMITE};`;

  console.log(`\n=== ENRIQUECER ${SEDE} ${ANO} · ${ETIQUETA_TIPO} (offset ${estado.offset}, ${LIMITE} fichas) ${EJECUTAR ? '' : '· DRY-RUN'} ===`);
  const filas = await vtigerQuery(q, { context: 'historico-enrich' }) || [];
  if (filas.length === 0) { console.log('[FIN] No hay más fichas en este año.'); return; }

  let ok = 0, omitidos = 0, fallidos = 0, sinCuota = 0;
  for (const v of filas) {
    if (!hayCuotaRealDeFondo(SEDE)) { sinCuota++; break; }
    if (!EJECUTAR) { ok++; continue; }
    try {
      const r = await syncVtigerContactDual(v, { permitirLead: true });
      if (r?.ok) ok++;
      else if (r?.skipped) omitidos++;
      else fallidos++;
    } catch { fallidos++; }
    await pausa();
  }

  estado.offset += filas.length;
  estado.ok += ok; estado.omitidos += omitidos; estado.fallidos += fallidos;
  if (EJECUTAR) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(archivoEnrich, JSON.stringify(estado, null, 2), 'utf8');
  }

  console.log(`[RESULTADO] ok=${ok} omitidos=${omitidos} fallidos=${fallidos} sinCuota=${sinCuota} | acumulado ok=${estado.ok} | offset ${estado.offset}`);
  if (!EJECUTAR) console.log('[!] Dry-run: agrega --ejecutar para escribir en GHL.');
}

// ------------------------------------------------------------------------------
// ESTADO
// ------------------------------------------------------------------------------
function estadoGeneral() {
  fs.mkdirSync(DIR, { recursive: true });
  const filas = [];
  // Se leen TODOS los archivos del directorio (compradores, contactos y los antiguos
  // sin tipo) para no ocultar avance ya hecho.
  for (const nombre of fs.readdirSync(DIR)) {
    if (!nombre.endsWith('.json')) continue;
    try {
      const e = JSON.parse(fs.readFileSync(path.join(DIR, nombre), 'utf8'));
      filas.push({
        sede: e.sede,
        tipo: e.tipo || 'compradores',
        ano: e.ano,
        revisados: e.revisados || 0,
        encontrados: e.encontrados || 0,
        faltan: (e.faltantes || []).length,
        sincronizados: e.sincronizados || 0,
        fallidos: e.fallidos || 0,
        offset: e.offset || 0
      });
    } catch { /* archivo corrupto: se ignora */ }
  }
  if (filas.length === 0) { console.log('Sin avances registrados todavía.'); return; }
  filas.sort((a, b) => a.sede.localeCompare(b.sede) || a.tipo.localeCompare(b.tipo) || b.ano - a.ano);
  console.table(filas);
  for (const sede of VTIGER_SEDES_VALIDAS) {
    const cuota = (() => { try { return getRepartoCuota(sede); } catch { return null; } })();
    if (cuota) console.log(`${sede}: fondo consumido ${cuota.consumidoFondo} / disponible ${cuota.restanteDelDia} | puede trabajar: ${cuota.puedeTrabajar}`);
  }
}

try {
  if (fase === 'detectar') await detectar();
  else if (fase === 'sincronizar') await sincronizar();
  else if (fase === 'enriquecer') await enriquecer();
  else if (fase === 'estado') estadoGeneral();
  else { console.log('Fases: detectar | sincronizar | enriquecer | estado'); process.exitCode = 1; }
} catch (err) {
  console.error(`[ERROR] ${err.message}`);
  process.exitCode = 1;
}
