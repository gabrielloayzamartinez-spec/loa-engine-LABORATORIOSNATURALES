/**
 * AUDITORÍA DE FRONTERA — ¿en qué etapa se quedó la sincronización vTiger→GHL?
 *
 * Responde, por subcuenta y de lo MÁS NUEVO a lo MÁS ANTIGUO:
 *   · cuántos compradores hay en vTiger por año,
 *   · en qué contacto (id + fecha) quedó el cursor del backfill,
 *   · qué % de una muestra por año EXISTE en GHL,
 *   · de los que existen, qué % está COMPLETO (14 campos del estándar + etiquetas).
 *
 * SOLO LECTURA. Uso: node tools/audit_frontera_sync.mjs [muestraPorAno=6]
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { query as vtigerQuery, VTIGER_CONTACT_SELECT, VTIGER_FIELDS, sedeClause } from '../src/services/vtigerClient.js';

const BASE = 'https://services.leadconnectorhq.com';
const SEDES = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];
const LOC = { PALACIOS: '5NqOaPYqWyIw2FPBfoRg', BENAVIDES: 'QXcNBK6XCgpQaZ81Z8pv', ROOSEVELT: 'SETlaGKhBpbqfBSzzpIB', PIURA: '9J4pKs5f7OcaokdhyurW' };
const MUESTRA = Math.max(2, parseInt(process.argv[2] || '6', 10));
const ANOS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const vacio = v => v === undefined || v === null || ['', '--', 'null', 'undefined', '0.00000'].includes(String(v).trim());

/** 14 campos del estándar comercial (los que el negocio exige al comprador). */
const CAMPOS = [
  { k: 'sede', v: r => r.cf_3451, ghl: ['sede asignada', 'sede tienda compra'] },
  { k: 'tratamiento', v: r => r.cf_2610, ghl: ['tratamiento comprado'] },
  { k: 'canal', v: r => r.cf_3507, ghl: ['canal captacion', 'origen lead'] },
  { k: 'campana', v: r => r.cf_3472, ghl: ['utm campaign', 'campana meta'] },
  { k: 'proveedor', v: r => r.cf_2572, ghl: ['proveedor'] },
  { k: 'sexo', v: r => r.cf_2821, ghl: ['sexo'] },
  { k: 'etapa', v: r => r.cf_994, ghl: ['etapa comercial'] },
  { k: 'estado', v: r => r.cf_1876, ghl: ['estado comercial'] },
  { k: 'contactNo', v: r => r.contact_no, ghl: ['contact no'] },
  { k: 'totalCompras', v: r => r.spl_num_compras, ghl: ['total compras'] },
  { k: 'fechaUltima', v: r => r.spl_fecha_ultima_compra, ghl: ['fecha ultima compra', 'fecha compra'] },
  { k: 'fechaPrimera', v: r => r.spl_fecha_primera_compra, ghl: ['fecha primera compra'] },
  { k: 'precioVenta', v: r => r.cf_3392, ghl: ['precio venta'] },
  { k: 'idCliente', v: r => r.id, ghl: ['id cliente'] }
];

function headers(sede) {
  return { Authorization: `Bearer ${process.env[`GHL_API_KEY_${sede}`]}`, Version: '2021-07-28', Accept: 'application/json' };
}

async function contar(sede, extra = '') {
  const q = `SELECT COUNT(*) FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${sede}'${extra};`;
  const r = await vtigerQuery(q, { context: 'frontera-count', allowAggregate: true });
  return parseInt(r?.[0]?.count || '0', 10);
}

async function offsetDeProduccion() {
  try {
    const r = await fetch('https://loa-engine-laboratoriosnaturales.onrender.com/api/sync/estado');
    const d = await r.json();
    return { porSede: d?.sedes || {}, resumen: d?.resumen || {} };
  } catch { return { porSede: {}, resumen: {} }; }
}

async function buscarGhl(sede, telefonos) {
  const h = headers(sede);
  for (const tel of telefonos) {
    const last10 = tel.slice(-10);
    const r = await fetch(`${BASE}/contacts/?locationId=${LOC[sede]}&query=${last10}`, { headers: h });
    if (!r.ok) continue;
    const d = await r.json();
    const lista = d.contacts || [];
    const hit = lista.find(c => String(c.phone || '').replace(/\D/g, '').endsWith(last10));
    if (!hit) { await sleep(90); continue; }
    const rr = await fetch(`${BASE}/contacts/${hit.id}`, { headers: h });
    if (!rr.ok) return hit;
    const dd = await rr.json();
    return dd.contact || hit;
  }
  return null;
}

/** Teléfonos candidatos, en la MISMA prioridad que usa el motor (homephone primero). */
function telefonosDe(r) {
  const out = [];
  for (const v of [r.homephone, r.mobile, r.phone, r.otherphone]) {
    const d = String(v || '').replace(/\D/g, '');
    if (d.length >= 10 && d.length <= 15) out.push(d);
  }
  return [...new Set(out)];
}

async function auditarSede(sede, estadoProd) {
  const loc = LOC[sede];
  const h = headers(sede);

  const dic = await (await fetch(`${BASE}/locations/${loc}/customFields`, { headers: h })).json();
  const nombrePorId = new Map((dic.customFields || []).map(f => [f.id, f.name]));

  const totalCompradores = await contar(sede, ` AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0`);
  const offset = parseInt(estadoProd?.porSede?.[sede]?.procesados || '0', 10);

  // Frontera exacta: la fila en la posición `offset` recorriendo de más nuevo a más antiguo.
  let frontera = null;
  if (offset > 0) {
    const q = `SELECT id, createdtime, spl_fecha_ultima_compra FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${sede}' AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0 ORDER BY id DESC LIMIT ${offset}, 1;`;
    const r = await vtigerQuery(q, { context: 'frontera-cut' });
    frontera = r?.[0] || null;
  }
  const qNuevo = `SELECT id, createdtime FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${sede}' AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0 ORDER BY id DESC LIMIT 1;`;
  const qViejo = `SELECT id, createdtime FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${sede}' AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0 ORDER BY id ASC LIMIT 1;`;
  const nuevo = (await vtigerQuery(qNuevo, { context: 'frontera-nuevo' }))?.[0] || null;
  const viejo = (await vtigerQuery(qViejo, { context: 'frontera-viejo' }))?.[0] || null;

  // Por año (del más nuevo al más antiguo): total, muestra, presencia y completitud.
  const porAno = [];
  for (const ano of [...ANOS].reverse()) {
    const desde = `${ano}-01-01`;
    const hasta = `${ano + 1}-01-01`;
    const filtro = ` AND createdtime >= '${desde}' AND createdtime < '${hasta}'`;
    const compradores = await contar(sede, ` AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0${filtro}`);
    if (compradores === 0) { porAno.push({ ano, compradores: 0 }); continue; }

    // Muestra del MEDIO del año (no los más nuevos del año): evita sesgo hacia el
    // inicio del rango y hace la estimación representativa.
    const salto = Math.max(0, Math.floor((compradores - MUESTRA) / 2));
    const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${sede}' AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0${filtro} ORDER BY id DESC LIMIT ${salto}, ${MUESTRA};`;
    const filas = await vtigerQuery(q, { context: 'frontera-muestra' }) || [];

    let encontrados = 0, completos = 0, conTelefono = 0;
    const huecos = {};
    for (const r of filas) {
      const telefonos = telefonosDe(r);
      if (telefonos.length === 0) continue;
      conTelefono++;
      const g = await buscarGhl(sede, telefonos);
      await sleep(120);
      if (!g) continue;
      encontrados++;
      const valores = new Map((g.customFields || []).map(f => [norm(nombrePorId.get(f.id) || ''), f.value]));
      let faltan = 0;
      for (const c of CAMPOS) {
        if (vacio(c.v(r))) continue;                       // vTiger no lo tiene: no es hueco nuestro
        const gv = c.ghl.map(n => valores.get(norm(n))).find(x => !vacio(x));
        if (vacio(gv)) { faltan++; huecos[c.k] = (huecos[c.k] || 0) + 1; }
      }
      if (faltan === 0) completos++;
    }
    const pctEnGhl = conTelefono ? Math.round(encontrados / conTelefono * 100) : 0;
    porAno.push({
      ano, compradores, muestreados: filas.length, conTelefono, encontrados,
      pctEnGhl,
      faltantesEstimados: Math.round(compradores * (1 - pctEnGhl / 100)),
      completos,
      pctCompletos: encontrados ? Math.round(completos / encontrados * 100) : 0,
      huecosTop: Object.entries(huecos).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k}:${n}`)
    });
  }

  // GHL: total real + duplicados por teléfono en la primera página de 100.
  const totalGhl = (await (await fetch(`${BASE}/contacts/?locationId=${loc}&limit=1`, { headers: h })).json())?.meta?.total ?? null;
  const primera = await (await fetch(`${BASE}/contacts/?locationId=${loc}&limit=100`, { headers: h })).json();
  const telefonos = (primera.contacts || []).map(c => String(c.phone || '').replace(/\D/g, '')).filter(Boolean);
  const dup = telefonos.length - new Set(telefonos).size;

  return {
    sede, totalGhl, totalCompradoresVtiger: totalCompradores, offsetBackfill: offset,
    frontera, nuevo, viejo,
    porAno,
    duplicadosPrimeraPagina: { contactos: (primera.contacts || []).length, telefonos: telefonos.length, repetidos: dup }
  };
}

const estadoProd = await offsetDeProduccion();
console.log(`[SYNC] resumen producción: ${JSON.stringify(estadoProd.resumen)}`);

const salida = [];
for (const sede of SEDES) {
  console.log(`\n[..] ${sede} …`);
  try {
    const r = await auditarSede(sede, estadoProd);
    salida.push(r);
    console.log(`[OK] ${sede}: vTiger compradores=${r.totalCompradoresVtiger} | GHL total=${r.totalGhl} | offset=${r.offsetBackfill} | frontera=${r.frontera?.id} (${String(r.frontera?.createdtime || '').slice(0, 10)})`);
    console.log(`     años: ${r.porAno.map(a => `${a.ano}:${a.compradores}${a.pctEnGhl !== undefined ? `(GHL ${a.pctEnGhl}%, completos ${a.pctCompletos}%, faltan~${a.faltantesEstimados})` : ''}`).join(' | ')}`);
  } catch (e) {
    console.error(`[FAIL] ${sede}: ${e.message}`);
    salida.push({ sede, error: e.message });
  }
}

const dir = path.join(process.cwd(), 'scratch', 'audit_out');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `frontera_sync_${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(file, JSON.stringify({ generado: new Date().toISOString(), muestra: MUESTRA, estadoProduccion: estadoProd, sedes: salida }, null, 2), 'utf8');
console.log(`\n[FILE] ${file}`);
