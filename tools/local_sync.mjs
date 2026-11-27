#!/usr/bin/env node
/**
 * ==============================================================================
 * LOA ENGINE — HERRAMIENTA LOCAL (tu máquina ⇄ APIs de GHL y vTiger)
 * ==============================================================================
 * Permite AUDITAR una muestra real y REPLICAR la sincronización desde local,
 * sin depender de Render. Todo lo que escribe pide `--ejecutar`: por defecto
 * simula (dry-run) y no toca GHL.
 *
 * COMANDOS
 *   node tools/local_sync.mjs estado
 *       ¿Están las 4 sedes configuradas en TU .env? ¿Cuánta cuota queda?
 *
 *   node tools/local_sync.mjs auditar --sede=PALACIOS --muestra=25
 *       Lee N contactos de GHL y verifica: 14 CF comerciales, etiquetas, teléfono
 *       válido para SMS, si existe en vTiger y si sus PEDIDOS están reflejados
 *       (Historial, Precio venta, Último Producto, Fecha Última Compra…).
 *       SOLO LECTURA.
 *
 *   node tools/local_sync.mjs pedidos --sede=PALACIOS --muestra=5
 *       Muestra, para N compradores de vTiger, qué datos de sus órdenes se
 *       publicarían en GHL (sin escribir).
 *
 *   node tools/local_sync.mjs sincronizar --sede=PALACIOS --limite=10 [--ejecutar]
 *       Sincroniza N compradores (contacto + historial de órdenes) desde vTiger.
 *       Sin --ejecutar solo simula y reporta qué haría.
 *
 * OPCIONES
 *   --sede=PALACIOS|BENAVIDES|ROOSEVELT|PIURA
 *   --location=<locationId>   (solo auditoría: si tu .env no tiene el de esa sede)
 *   --muestra=N  --limite=N   --json=<archivo>  --con-pedidos=false
 *
 * REQUISITOS: .env con GHL_API_KEY_<SEDE>, GHL_LOCATION_ID_<SEDE>, VTIGER_*.
 * IMPORTANTE: no correr `sincronizar --ejecutar` mientras Render está escribiendo
 * en la misma subcuenta (se duplicaría el trabajo y el consumo de cuota).
 * ==============================================================================
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { SEDES_GATEWAY, getActiveSedes } from '../src/config/index.js';
import { getRepartoCuota, getCuotaRealEstado, hayCuotaRealDeFondo, PRESUPUESTO_FONDO_DIARIO } from '../src/utils/ghl_http_client.js';
import { query as vtigerQuery, VTIGER_CONTACT_SELECT, VTIGER_FIELDS, VTIGER_SEDES_VALIDAS, phoneClauses, sedeClause } from '../src/services/vtigerClient.js';
import { getVtigerConfigStatus } from '../src/services/vtigerClient.js';
import { fetchOrdersForContact, normalizeOrder, sortOrdersDesc, buildOrderEnrichmentFields } from '../src/services/vtiger_order_history_service.js';
import { obtenerMapaCamposGhl, normalizarNombreCampo } from '../src/services/ghl_fields_map.js';
import { clasificarCliente } from '../src/domain/segmentacion.js';
import { normalizeTreatment } from '../src/domain/clinical_vocabulary.js';

const BASE = 'https://services.leadconnectorhq.com';

// ------------------------------------------------------------------------------
// ARGUMENTOS
// ------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const comando = (argv[0] || 'estado').toLowerCase();
const op = {};
for (const a of argv.slice(1)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) op[m[1]] = m[2] === undefined ? true : m[2];
}
const SEDE = String(op.sede || '').toUpperCase();
const MUESTRA = Math.min(Math.max(parseInt(op.muestra || '20', 10) || 20, 1), 300);
const LIMITE = Math.min(Math.max(parseInt(op.limite || '10', 10) || 10, 1), 500);
const CON_PEDIDOS = String(op['con-pedidos'] ?? 'true').toLowerCase() !== 'false';
const EJECUTAR = String(op.ejecutar || '').toLowerCase() === 'true';
const JSON_OUT = op.json ? String(op.json) : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const vacio = v => v === undefined || v === null || ['', '--', 'null', 'undefined', '0.00000'].includes(String(v).trim());
const digitos = v => String(v || '').replace(/\D/g, '');

// ------------------------------------------------------------------------------
// LOS 14 CAMPOS DEL ESTÁNDAR + ATRIBUCIÓN + PEDIDO
// ------------------------------------------------------------------------------
const CAMPOS_CONTACTO = [
  { k: 'Sede Asignada', ghl: ['sede asignada', 'sede tienda compra'] },
  { k: 'Tratamiento comprado', ghl: ['tratamiento comprado'] },
  { k: 'Canal Captación', ghl: ['canal captacion'] },
  { k: 'Campaña', ghl: ['campana meta', 'utm campaign'] },
  { k: 'Proveedor', ghl: ['proveedor'] },
  { k: 'Sexo', ghl: ['sexo'] },
  { k: 'Etapa Comercial', ghl: ['etapa comercial'] },
  { k: 'Estado Comercial', ghl: ['estado comercial'] },
  { k: 'Contact No', ghl: ['contact no'] },
  { k: 'Total Compras', ghl: ['total compras'] },
  { k: 'Fecha Última Compra', ghl: ['fecha ultima compra', 'fecha compra'] },
  { k: 'Fecha Primera Compra', ghl: ['fecha primera compra'] },
  { k: 'Precio Venta', ghl: ['precio venta'] },
  { k: 'ID Cliente', ghl: ['id cliente'] },
  // [SEGMENTACIÓN] Campos que alimentan las Listas Inteligentes de campañas.
  { k: 'Estado de Compra', ghl: ['estado de compra'] },
  { k: 'Fuente Última Orden', ghl: ['fuente ultima orden'] },
  { k: 'Fecha Creación (DATE)', ghl: ['fecha creacion fecha'] }
];
const CAMPOS_PEDIDO = [
  { k: 'Historial Completo', ghl: ['historial completo'] },
  { k: 'Último Producto', ghl: ['ultimo producto'] },
  { k: 'Estado de Entrega', ghl: ['estado de entrega'] },
  { k: 'Forma de Pago', ghl: ['forma de pago'] },
  { k: 'Transportista', ghl: ['transportista'] }
];
const FAMILIAS_TAG = ['canal-', 'prov-', 'sede-', 'pagina-', 'producto-'];

// ------------------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------------------
function headersDe(sede) {
  const apiKey = SEDES_GATEWAY[sede]?.ghl?.apiKey;
  if (!apiKey) return null;
  return { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
}

function locationDe(sede) {
  return SEDES_GATEWAY[sede]?.ghl?.locationId || (op.location ? String(op.location) : null);
}

async function ghl(url, h) {
  const r = await fetch(url, { headers: h });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url.replace(/\?.*/, '')}`);
  return r.json();
}

function leerCampo(valores, alias) {
  for (const a of alias) {
    const v = valores.get(normalizarNombreCampo(a));
    if (!vacio(v)) return String(v);
  }
  return '';
}

/** Teléfono válido para SMS en EE.UU. (10 dígitos NANP o 11 con 1). */
function telefonoValido(tel) {
  const d = digitos(tel);
  if (d.length === 10) return '23456789'.includes(d[0]);
  if (d.length === 11 && d.startsWith('1')) return '23456789'.includes(d[1]);
  return false;
}

// ------------------------------------------------------------------------------
// 1. ESTADO / PREPARACIÓN DEL ENTORNO LOCAL
// ------------------------------------------------------------------------------
async function cmdEstado() {
  const vtiger = getVtigerConfigStatus();
  console.log('\n=== ENTORNO LOCAL ===');
  console.log(`vTiger: ${vtiger.configured ? 'CONFIGURADO (' + vtiger.urlHost + ')' : 'NO CONFIGURADO — faltan: ' + (vtiger.missing || []).join(', ')}`);

  const filas = [];
  for (const sede of VTIGER_SEDES_VALIDAS) {
    const cfg = SEDES_GATEWAY[sede] || {};
    const loc = cfg?.ghl?.locationId || '';
    const key = Boolean(cfg?.ghl?.apiKey);
    const cuota = (() => { try { return getRepartoCuota(sede); } catch { return null; } })();
    filas.push({
      sede,
      locationId: loc || '(FALTA en .env)',
      apiKey: key ? 'sí' : '(FALTA)',
      listo: Boolean(loc && key),
      fondoConsumido: cuota?.consumidoFondo ?? '—',
      fondoRestante: cuota?.restanteDelDia ?? '—',
      puedeTrabajar: cuota?.puedeTrabajar ?? '—'
    });
  }
  console.table(filas);

  console.log(`\nPresupuesto diario de fondo (GHL): ${PRESUPUESTO_FONDO_DIARIO} llamadas.`);
  const faltan = filas.filter(f => !f.listo).map(f => f.sede);
  if (faltan.length) {
    console.log(`\n[!] Faltan credenciales locales para: ${faltan.join(', ')}.`);
    console.log('    Agrega en .env: GHL_LOCATION_ID_<SEDE>=... y GHL_API_KEY_<SEDE>=...');
  }
  console.log('\n[i] Si Render está corriendo, NO uses `sincronizar --ejecutar` al mismo tiempo.');
}

// ------------------------------------------------------------------------------
// 2. AUDITORÍA DE UNA MUESTRA (contactos + pedidos + SMS)
// ------------------------------------------------------------------------------
async function cmdAuditar() {
  if (!VTIGER_SEDES_VALIDAS.includes(SEDE)) throw new Error('Indica --sede=PALACIOS|BENAVIDES|ROOSEVELT|PIURA');
  const loc = locationDe(SEDE);
  const h = headersDe(SEDE);
  if (!loc || !h) throw new Error(`La sede ${SEDE} no tiene credenciales en .env (o usa --location=<id>)`);

  const mapa = await obtenerMapaCamposGhl(loc, h);
  const nombrePorId = new Map([...mapa.porId.entries()]);
  const paginas = Math.ceil(MUESTRA / 100);

  console.log(`\n=== AUDITORÍA ${SEDE} — muestra de ${MUESTRA} contactos (SOLO LECTURA) ===`);
  const contactos = [];
  let url = `${BASE}/contacts/?locationId=${loc}&limit=100`;
  for (let p = 0; p < paginas && url; p++) {
    const d = await ghl(url, h);
    contactos.push(...(d.contacts || []));
    url = d?.meta?.nextPageUrl || null;
    await sleep(120);
  }
  const muestra = contactos.slice(0, MUESTRA);

  const filas = [];
  const faltantesPorCampo = {};
  const faltantesPedido = {};
  let smsListos = 0, conTagsOk = 0, enVtiger = 0, conPedidos = 0, pedidosReflejados = 0;
  const telefonos = new Set();
  let duplicados = 0;

  for (const c of muestra) {
    const valores = new Map((c.customFields || []).map(f => [normalizarNombreCampo(nombrePorId.get(f.id) || ''), f.value]));
    const tags = (c.tags || []).map(t => String(t).toLowerCase());
    const tel = digitos(c.phone);

    if (telefonos.has(tel) && tel) duplicados++;
    if (tel) telefonos.add(tel);

    const faltan = CAMPOS_CONTACTO.filter(campo => vacio(leerCampo(valores, campo.ghl))).map(x => x.k);
    for (const f of faltan) faltantesPorCampo[f] = (faltantesPorCampo[f] || 0) + 1;

    const tagsOk = FAMILIAS_TAG.every(fam => tags.some(t => t.startsWith(fam)));
    if (tagsOk) conTagsOk++;

    const esComprador = !vacio(leerCampo(valores, ['total compras'])) && Number(digitos(leerCampo(valores, ['total compras']))) > 0
      || String(leerCampo(valores, ['estado de compra'])).toLowerCase().includes('comprador');

    // vTiger: ¿existe esta ficha? (por teléfono, la llave del motor)
    let vTiger = null;
    let errorVtiger = null;
    if (tel.length >= 10) {
      try {
        // vTiger NO admite paréntesis en el WHERE: se prueba campo por campo.
        for (const clausula of phoneClauses(tel)) {
          const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${SEDE}'${clausula} LIMIT 1;`;
          const r = await vtigerQuery(q, { context: 'local-audit' });
          if (r?.[0]) { vTiger = r[0]; break; }
        }
      } catch (e) { errorVtiger = e.message; }
      await sleep(80);
    }
    if (vTiger) enVtiger++;

    // Pedidos: ¿el historial de vTiger está reflejado en GHL?
    let infoPedidos = null;
    if (CON_PEDIDOS && vTiger && esComprador) {
      try {
        const ordenes = sortOrdersDesc((await fetchOrdersForContact(vTiger.id, SEDE)).map(normalizeOrder));
        if (ordenes.length > 0) {
          conPedidos++;
          const faltanPedido = CAMPOS_PEDIDO.filter(campo => vacio(leerCampo(valores, campo.ghl))).map(x => x.k);
          for (const f of faltanPedido) faltantesPedido[f] = (faltantesPedido[f] || 0) + 1;
          // El total de la última orden debe ser el "Precio venta" en GHL.
          const precioGhl = parseFloat(digitos(leerCampo(valores, ['precio venta'])) || '0') || 0;
          const totalUltima = Number(ordenes[0].total || 0);
          const precioOk = totalUltima > 0 ? Math.abs(precioGhl - totalUltima) < 1 : null;
          if (precioOk) pedidosReflejados++;
          infoPedidos = { ordenes: ordenes.length, ultima: totalUltima, precioGhl, precioOk, faltan: faltanPedido };
        }
      } catch { infoPedidos = { error: 'no se pudieron leer órdenes' }; }
      await sleep(80);
    }

    const smsOk = telefonoValido(tel) && !vacio(leerCampo(valores, ['tiene telefono'])) && !faltan.includes('Sede Asignada') && !faltan.includes('Tratamiento comprado');
    if (smsOk) smsListos++;

    // [TRES UNIVERSOS] En GHL conviven chats, contactos y compradores. Un contacto
    // sin teléfono es un CHAT de Messenger: no es una ficha de vTiger y no cuenta
    // como hueco de sincronización.
    let tipo = 'LEAD GHL';
    if (!telefonoValido(tel)) tipo = 'CHAT (sin teléfono)';
    else if (vTiger) tipo = String(vTiger.spl_num_compras || '0') !== '0' ? 'COMPRADOR' : 'CONTACTO (vTiger)';

    filas.push({
      nombre: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.id,
      idGhl: c.id,
      tipo,
      telOkSms: telefonoValido(tel) ? 'sí' : 'no',
      cfFaltantes: faltan.length,
      tagsOk: tagsOk ? 'sí' : 'no',
      enVtiger: vTiger ? `sí (${vTiger.spl_num_compras || 0} compras)` : (errorVtiger ? `error: ${errorVtiger.slice(0, 30)}` : 'NO'),
      pedidos: infoPedidos ? `${infoPedidos.ordenes} (últ. ${infoPedidos.ultima})` : (esComprador ? 'sin órdenes' : '—'),
      precioOk: infoPedidos?.precioOk === undefined || infoPedidos?.precioOk === null ? '—' : (infoPedidos.precioOk ? 'sí' : 'NO'),
      faltan: faltan.slice(0, 5).join(', ') || '—'
    });
  }

  console.table(filas);

  const pct = n => Math.round((n / muestra.length) * 1000) / 10;
  const cuenta = t => filas.filter(f => f.tipo === t).length;
  const resumen = {
    sede: SEDE,
    contactosMuestreados: muestra.length,
    universos: {
      chats: `${cuenta('CHAT (sin teléfono)')} (${pct(cuenta('CHAT (sin teléfono)'))}%)`,
      contactos: cuenta('CONTACTO (vTiger)'),
      compradores: cuenta('COMPRADOR'),
      'leads solo-GHL': cuenta('LEAD GHL')
    },
    telefonoValidoSms: `${filas.filter(f => f.telOkSms === 'sí').length}/${muestra.length} (${pct(filas.filter(f => f.telOkSms === 'sí').length)}%)`,
    listosParaSms: `${smsListos}/${muestra.length} (${pct(smsListos)}%)`,
    etiquetasCompletas: `${conTagsOk}/${muestra.length} (${pct(conTagsOk)}%)`,
    existenEnVtiger: `${enVtiger}/${muestra.length} (${pct(enVtiger)}%)`,
    compradoresConPedidosEnVtiger: conPedidos,
    precioVentaCoincideConUltimaOrden: `${pedidosReflejados}/${conPedidos}`,
    telefonosDuplicadosEnMuestra: duplicados,
    faltantesPorCampoContacto: faltantesPorCampo,
    faltantesPorCampoPedido: faltantesPedido
  };
  console.log('\n--- RESUMEN ---');
  console.log(JSON.stringify(resumen, null, 2));

  if (JSON_OUT) {
    const p = path.resolve(JSON_OUT);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ generado: new Date().toISOString(), resumen, filas }, null, 2), 'utf8');
    console.log(`\n[FILE] ${p}`);
  }
}

// ------------------------------------------------------------------------------
// 3. QUÉ SE PUBLICARÍA DE LOS PEDIDOS (sin escribir)
// ------------------------------------------------------------------------------
async function cmdPedidos() {
  if (!VTIGER_SEDES_VALIDAS.includes(SEDE)) throw new Error('Indica --sede=...');
  const loc = locationDe(SEDE);
  const h = headersDe(SEDE);
  if (!loc || !h) throw new Error(`La sede ${SEDE} no tiene credenciales en .env`);
  const mapa = await obtenerMapaCamposGhl(loc, h);
  const ids = {};
  for (const [id, nombre] of mapa.porId.entries()) ids[normalizarNombreCampo(nombre)] = id;
  const nombrePorId = new Map(mapa.porId);

  console.log(`\n=== PEDIDOS: qué se publicaría en ${SEDE} (SOLO LECTURA) ===`);
  const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.NUM_COMPRAS} > 0${sedeClause(SEDE)} ORDER BY id DESC LIMIT ${MUESTRA};`;
  const compradores = await vtigerQuery(q, { context: 'local-pedidos' }) || [];

  const filas = [];
  let enGhl = 0, completos = 0, precioOkTotal = 0;
  for (const v of compradores) {
    const ordenes = sortOrdersDesc((await fetchOrdersForContact(v.id, SEDE)).map(normalizeOrder));
    if (!ordenes.length) continue;
    const ultima = ordenes[0];
    const enriquecidos = buildOrderEnrichmentFields(ultima, {
      totalCompras: ids['total compras'], estadoComercial: ids['estado comercial'],
      estadoEntrega: ids['estado de entrega'], conformidad: ids['conformidad'],
      formaPago: ids['forma de pago'], transportista: ids['transportista'],
      tracking: ids['tracking'], ultimoProducto: ids['ultimo producto'],
      sexo: ids['sexo'], precioVenta: ids['precio venta']
    }, ordenes.length);

    // ¿Cómo está HOY ese comprador en GHL?
    const tel = digitos(v.homephone || v.mobile || v.phone || v.otherphone);
    let estadoGhl = 'NO EXISTE';
    let cfFaltan = [], pedidoFaltan = [], precioOk = '—';
    if (tel.length >= 10) {
      try {
        const s = await ghl(`${BASE}/contacts/?locationId=${loc}&query=${tel.slice(-10)}`, h);
        const hit = (s.contacts || []).find(c => digitos(c.phone).endsWith(tel.slice(-10)));
        if (hit) {
          enGhl++;
          const det = await ghl(`${BASE}/contacts/${hit.id}`, h);
          const g = det.contact || hit;
          const valores = new Map((g.customFields || []).map(f => [normalizarNombreCampo(nombrePorId.get(f.id) || ''), f.value]));
          cfFaltan = CAMPOS_CONTACTO.filter(campo => vacio(leerCampo(valores, campo.ghl))).map(x => x.k);
          pedidoFaltan = CAMPOS_PEDIDO.filter(campo => vacio(leerCampo(valores, campo.ghl))).map(x => x.k);
          const precioGhl = parseFloat(String(leerCampo(valores, ['precio venta']) || '0').replace(/[^0-9.]/g, '')) || 0;
          const total = Number(ultima.total || 0);
          const coincide = total > 0 ? Math.abs(precioGhl - total) < 1 : null;
          precioOk = coincide === null ? '—' : (coincide ? 'sí' : 'NO');
          if (coincide) precioOkTotal++;
          // "COMPLETO" exige además que el precio refleje la última orden.
          estadoGhl = (cfFaltan.length === 0 && pedidoFaltan.length === 0 && coincide !== false) ? 'COMPLETO' : 'INCOMPLETO';
          if (estadoGhl === 'COMPLETO') completos++;
        }
      } catch { estadoGhl = 'ERROR CONSULTA'; }
      await sleep(120);
    }

    filas.push({
      nombre: `${v.firstname || ''} ${v.lastname || ''}`.trim(),
      vTigerId: v.id,
      ordenes: ordenes.length,
      segmento: clasificarCliente({ numCompras: ordenes.length }).fuenteUltimaOrden || '—',
      ultimaFecha: ultima.fecha || '—',
      ultimoProducto: (ultima.producto || '—').slice(0, 22),
      totalUltima: ultima.total,
      ghl: estadoGhl,
      cfFaltan: cfFaltan.length,
      pedidoFaltan: pedidoFaltan.length,
      precioOk,
      camposQueSeEscribirian: enriquecidos.length
    });
    await sleep(100);
  }
  console.table(filas);
  const total = filas.length || 1;
  console.log(`\n[RESUMEN] compradores con órdenes: ${filas.length} | en GHL: ${enGhl} (${Math.round(enGhl / total * 100)}%) | completos: ${completos} (${Math.round(completos / total * 100)}%) | precio coincide: ${precioOkTotal}`);
  console.log(`[i] Cada comprador con órdenes recibe ${filas[0]?.camposQueSeEscribirian ?? 0} campos + nota de historial.`);
}

// ------------------------------------------------------------------------------
// 4. SINCRONIZAR (dry-run por defecto)
// ------------------------------------------------------------------------------
async function cmdSincronizar() {
  if (!VTIGER_SEDES_VALIDAS.includes(SEDE)) throw new Error('Indica --sede=...');
  const loc = locationDe(SEDE);
  const h = headersDe(SEDE);
  if (!loc || !h) throw new Error(`La sede ${SEDE} no tiene credenciales en .env`);

  console.log(`\n=== SINCRONIZAR ${SEDE} — ${LIMITE} compradores (${EJECUTAR ? 'EJECUTANDO' : 'DRY-RUN'}) ===`);
  const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.NUM_COMPRAS} > 0${sedeClause(SEDE)} ORDER BY id DESC LIMIT ${LIMITE};`;
  const compradores = await vtigerQuery(q, { context: 'local-sync' }) || [];

  if (!EJECUTAR) {
    console.log('[DRY-RUN] Se revisará qué haría, sin escribir en GHL.');
    const filas = [];
    for (const v of compradores) {
      const tel = digitos(v.homephone || v.mobile || v.phone || v.otherphone);
      const r = await fetch(`${BASE}/contacts/?locationId=${loc}&query=${tel.slice(-10)}`, { headers: h });
      const d = await r.json().catch(() => ({}));
      const existe = (d.contacts || []).some(c => digitos(c.phone).endsWith(tel.slice(-10)));
      filas.push({
        nombre: `${v.firstname || ''} ${v.lastname || ''}`.trim(),
        vTigerId: v.id,
        tel: tel ? `+${tel}` : '(sin teléfono)',
        enGhl: existe ? 'sí' : 'NO (se crearía)',
        compras: v.spl_num_compras,
        accion: !tel ? 'omitir (sin teléfono)' : existe ? 'actualizar' : 'crear'
      });
      await sleep(120);
    }
    console.table(filas);
    console.log(`\n[!] Para escribir de verdad: agrega --ejecutar`);
    console.log('[!] No lo ejecutes mientras Render esté sincronizando la misma subcuenta.');
    return;
  }

  const { syncVtigerContactDual } = await import('../src/services/dual_sync_service.js');
  let ok = 0, omitidos = 0, fallidos = 0, sinCuota = 0;
  for (const v of compradores) {
    if (!hayCuotaRealDeFondo(SEDE)) { sinCuota++; continue; }
    try {
      const r = await syncVtigerContactDual(v);
      if (r?.ok) ok++; else if (r?.skipped) omitidos++; else fallidos++;
    } catch { fallidos++; }
    await sleep(300);
  }
  console.log(`\n[RESULTADO] ok=${ok} omitidos=${omitidos} fallidos=${fallidos} sinCuota=${sinCuota}`);
  if (sinCuota) console.log('[!] Se detuvo por cuota: vuelve a correrlo cuando la subcuenta tenga margen.');
}

// ------------------------------------------------------------------------------
// 5. COBERTURA: ¿todo lo que vTiger tiene está reflejado y coincide en GHL?
// ------------------------------------------------------------------------------
const normTexto = v => String(v ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
const normNum = v => { const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n.toFixed(2) : ''; };
const normFecha = v => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{12,}$/.test(s)) { const d = new Date(Number(s)); return isNaN(d) ? '' : d.toISOString().slice(0, 10); }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
};

/** Campos comparables vTiger → GHL (los que alimentan las Listas Inteligentes).
 *  Se comparan con la MISMA normalización que usa el motor, para no contar como
 *  "diferencia" algo que sólo cambió de forma (p. ej. 'Tetosterona' → 'Potencia'). */
const normProv = v => {
  const s = String(v ?? '').trim().toUpperCase();
  return /PIKALEX|PIKALES/.test(s) ? 'CLICK2RING' : s;
};
function camposComparables(v, compras) {
  return [
    // [SEDE ACTUAL] El valor esperado es la OFICINA ACTUAL (cf_3590), que es la que
    // se publica en "Sede Asignada". Comparar contra cf_3451 marcaba diferencias
    // falsas en todas las fichas reasignadas.
    { nombre: 'Sede', vt: v.cf_3590 || v.cf_3451, ghl: ['sede asignada', 'sede tienda compra'], f: v2 => String(v2 ?? '').trim().toUpperCase() },
    { nombre: 'Tratamiento', vt: v.cf_2610, ghl: ['tratamiento comprado'], f: v2 => normalizeTreatment(String(v2 || '')) || '' },
    { nombre: 'Canal', vt: v.cf_3507, ghl: ['canal captacion'], f: v2 => String(v2 ?? '').trim().toUpperCase() },
    { nombre: 'Campaña', vt: v.cf_3472, ghl: ['utm campaign', 'campana meta'], f: normTexto },
    { nombre: 'Proveedor', vt: v.cf_2572, ghl: ['proveedor'], f: normProv },
    { nombre: 'Sexo', vt: v.cf_2821, ghl: ['sexo'], f: v2 => String(v2 ?? '').trim().toUpperCase() },
    { nombre: 'Etapa', vt: v.cf_994, ghl: ['etapa comercial'], f: v2 => String(v2 ?? '').trim().toUpperCase() },
    { nombre: 'Estado', vt: v.cf_1876, ghl: ['estado comercial'], f: v2 => String(v2 ?? '').trim().toUpperCase() },
    { nombre: 'Contact No', vt: v.contact_no, ghl: ['contact no'], f: normTexto },
    { nombre: 'Total Compras', vt: v.spl_num_compras, ghl: ['total compras'], f: normNum },
    { nombre: 'Fecha Última', vt: v.spl_fecha_ultima_compra, ghl: ['fecha ultima compra', 'fecha compra'], f: normFecha },
    { nombre: 'Fecha Primera', vt: v.spl_fecha_primera_compra, ghl: ['fecha primera compra'], f: normFecha },
    { nombre: 'Total Histórico', vt: v.cf_3392, ghl: ['total historico gastado usd'], f: normNum },
    { nombre: 'ID Cliente', vt: v.id, ghl: ['id cliente'], f: normTexto },
    { nombre: 'Asesor', vt: v.wcf_acf_atf_3390, ghl: ['asesor asignado'], f: normTexto },
    { nombre: 'Fecha Creación (DATE)', vt: String(v.createdtime || '').slice(0, 10), ghl: ['fecha creacion fecha'], f: normFecha },
    { nombre: 'Estado de Compra', vt: compras > 0 ? 'Comprador' : 'No Comprador', ghl: ['estado de compra'], f: normTexto },
    // [RECOMPRA] La señal que dispara las campañas de re-orden.
    { nombre: 'Fuente Última Orden', vt: compras >= 2 ? 'Mi Re-Orden' : (compras === 1 ? 'Primera Compra' : ''), ghl: ['fuente ultima orden'], f: normTexto }
  ];
}

async function cmdCobertura() {
  if (!VTIGER_SEDES_VALIDAS.includes(SEDE)) throw new Error('Indica --sede=...');
  const loc = locationDe(SEDE);
  const h = headersDe(SEDE);
  if (!loc || !h) throw new Error(`La sede ${SEDE} no tiene credenciales en .env`);
  const mapa = await obtenerMapaCamposGhl(loc, h);
  const nombrePorId = new Map(mapa.porId);

  // [TIPO] compradores (con compra) o contactos (leads SIN venta) — son campañas
  // distintas: una es recompra, la otra prospección.
  const TIPO_COB = String(op.tipo || 'compradores').toLowerCase();
  const filtroTipo = TIPO_COB === 'contactos'
    ? ` AND ${VTIGER_FIELDS.NUM_COMPRAS} = 0`
    : ` AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0`;

  console.log(`\n=== COBERTURA vTiger → GHL (${SEDE}, ${MUESTRA} ${TIPO_COB}, sede ACTUAL) — SOLO LECTURA ===`);
  const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.SEDE_ACTUAL} = '${SEDE}'${filtroTipo} ORDER BY id DESC LIMIT ${MUESTRA};`;
  const compradores = await vtigerQuery(q, { context: 'local-cobertura' }) || [];

  const stats = {};
  const detalle = [];
  for (const v of compradores) {
    const compras = parseInt(v.spl_num_compras || '0', 10) || 0;
    const tel = digitos(v.homephone || v.mobile || v.phone || v.otherphone);
    if (tel.length < 10) continue;

    let g = null;
    try {
      const s = await ghl(`${BASE}/contacts/?locationId=${loc}&query=${tel.slice(-10)}`, h);
      const hit = (s.contacts || []).find(c => digitos(c.phone).endsWith(tel.slice(-10)));
      if (hit) { const d = await ghl(`${BASE}/contacts/${hit.id}`, h); g = d.contact || hit; }
    } catch { /* sin par en GHL */ }
    await sleep(120);

    if (!g) { detalle.push({ nombre: `${v.firstname} ${v.lastname}`.trim(), estado: 'NO EXISTE EN GHL' }); continue; }

    const valores = new Map((g.customFields || []).map(f => [normalizarNombreCampo(nombrePorId.get(f.id) || ''), f.value]));
    const fila = { nombre: `${v.firstname || ''} ${v.lastname || ''}`.trim(), difieren: 0, faltan: 0 };
    for (const campo of camposComparables(v, compras)) {
      const esperado = campo.f(campo.vt);
      if (!esperado) continue;                       // vTiger no tiene el dato: no se evalúa
      const ghlValor = campo.ghl.map(n => valores.get(normalizarNombreCampo(n))).find(x => !vacio(x));
      const obtenido = campo.f(ghlValor);
      const st = stats[campo.nombre] || (stats[campo.nombre] = { evaluados: 0, coinciden: 0, difieren: 0, vacios: 0 });
      st.evaluados++;
      if (!obtenido) { st.vacios++; fila.faltan++; }
      else if (obtenido === esperado) { st.coinciden++; }
      else { st.diferen = (st.diferen || 0); st.difieren++; fila.difieren++; }
    }
    detalle.push(fila);
  }

  console.table(detalle);

  const filas = Object.entries(stats).map(([campo, s]) => ({
    campo,
    evaluados: s.evaluados,
    coincidePct: s.evaluados ? Math.round((s.coinciden / s.evaluados) * 100) : 0,
    vacioPct: s.evaluados ? Math.round((s.vacios / s.evaluados) * 100) : 0,
    difierePct: s.evaluados ? Math.round((s.difieren / s.evaluados) * 100) : 0
  })).sort((a, b) => a.coincidePct - b.coincidePct);

  console.log('\n--- COINCIDENCIA POR CAMPO (peor primero) ---');
  console.table(filas);
  const totalEval = filas.reduce((a, f) => a + f.evaluados, 0);
  const totalCoin = Object.values(stats).reduce((a, s) => a + s.coinciden, 0);
  console.log(`\n[GLOBAL] ${totalCoin}/${totalEval} comparaciones coinciden (${totalEval ? Math.round(totalCoin / totalEval * 100) : 0}%).`);
  console.log('[i] "vacío" = el campo no está en GHL; "difiere" = tiene otro valor (quedó viejo).');
}

// ------------------------------------------------------------------------------
// MAIN
// ------------------------------------------------------------------------------
try {
  if (comando === 'estado') await cmdEstado();
  else if (comando === 'auditar') await cmdAuditar();
  else if (comando === 'pedidos') await cmdPedidos();
  else if (comando === 'cobertura') await cmdCobertura();
  else if (comando === 'sincronizar') await cmdSincronizar();
  else {
    console.log('Comandos: estado | auditar | pedidos | cobertura | sincronizar');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\n[ERROR] ${err.message}`);
  process.exitCode = 1;
}
