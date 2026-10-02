/**
 * ==============================================================================
 * LOA ENGINE - HISTORIAL DE ÓRDENES vTiger -> GHL (DETALLE COMERCIAL)
 * ==============================================================================
 * QUÉ AÑADE ESTE MÓDULO:
 * Hasta ahora GHL recibía sólo el RESUMEN del cliente (total_compras,
 * fecha_ultima_compra, precio_venta). El detalle real de cada pedido vive en el
 * módulo `SalesOrder` de vTiger (151 campos verificados en vivo) e incluye:
 * nº de orden, fecha, estado, monto, producto, cantidad, tratamiento, proveedor,
 * vendedor, campaña, transportista, guía de rastreo y estado de entrega.
 *
 * DÓNDE QUEDA VISIBLE (decisión del negocio):
 *   - **Nota en la tarjeta del contacto**: legible por el asesor en GHL. Es
 *     IDEMPOTENTE: se ACTUALIZA en cada ciclo, no se duplica. Un cliente con 18
 *     compras tiene UNA nota con sus 18 órdenes.
 *   - **Campo `vTiger Historial Completo`** (LARGE_TEXT, ya existente): versión
 *     estructurada para filtros y automatizaciones.
 *
 * REGLA DE AISLAMIENTO (innegociable):
 *   - Cuenta Empresa (macro): recibe el historial GLOBAL del cliente (todas las
 *     sedes), porque su propósito es la analítica de empresa.
 *   - Subcuenta de sede: recibe ÚNICAMENTE las órdenes de SU sede. Un asesor de
 *     Benavides nunca ve la compra que ese cliente hizo en Palacios.
 *
 * ESTRATEGIA DE AGUA FRÍA (rate limit):
 *   Las órdenes se piden EN LOTE por `contact_id` (una consulta para N contactos)
 *   en lugar de una consulta por contacto. Y no se implementa limitador propio:
 *   `ghlFetch` ya pasa por el TokenBucketQueue global con backoff por subcuenta.
 * ==============================================================================
 */

import { queryVTiger } from './vtiger_api_service.js';
import { SEDES_GATEWAY, getActiveSedes } from '../config/index.js';
import { sanitizeForVtigerQuery } from '../utils/sanitize.js';
import { recordAuditEvent } from './audit_logger.js';
import { getGhlHeaders } from '../config/index.js';
import { ghlFetch } from '../utils/ghl_http_client.js';
import { getStateStore } from './state/state_store.js';
import { resolveCustomFieldIds, isCentralConfigured } from './dual_sync_service.js';
import { readSecret } from '../config/secrets.js';

const CENTRAL_LOCATION_ID = readSecret('GHL_LOCATION_ID_CENTRAL');
const CENTRAL_API_KEY = readSecret('GHL_API_KEY_CENTRAL');

/** Marca única de las notas gestionadas por el motor (idempotencia). */
export const MARCADOR_NOTA = '[LOA-ORDER-HISTORY]';

/** Tope de órdenes que se detallan en la nota (evita notas gigantes). */
const MAX_ORDENES_EN_NOTA = 30;

// ------------------------------------------------------------------------------
// 1. LECTURA DEL DETALLE DE ÓRDENES EN vTIGER
// ------------------------------------------------------------------------------
/**
 * Trae las órdenes de UN contacto. Se acota por `contact_id` y declara la sede
 * heredada: `SalesOrder` no posee `cf_3451`, su aislamiento viene del contacto.
 */
export async function fetchOrdersForContact(contactId, sedeActiva) {
  const safeId = sanitizeForVtigerQuery(contactId, 40);
  if (!safeId) return [];
  try {
    return await queryVTiger(
      `SELECT * FROM SalesOrder WHERE contact_id = '${safeId}';`,
      sedeActiva,
      { inheritedSede: sedeActiva }
    );
  } catch (err) {
    console.warn(`[Order History] [WARN] Órdenes de ${contactId} no disponibles: ${err.message}`);
    return [];
  }
}

/**
 * Trae las órdenes de VARIOS contactos.
 *
 * NOTA DE IMPLEMENTACIÓN (verificada en vivo):
 *  - vTiger NO soporta la cláusula `IN (...)`: se resolvió con comparaciones
 *    `OR` encadenadas, que sí funcionan (probado: 2 contactos -> 20 filas).
 *  - Se limita el número de contactos por consulta para no generar sentencias
 *    desmesuradas ni timeouts en el Webservice.
 *
 * @param {string[]} contactIds
 * @param {string} sedeActiva
 * @returns {Promise<Map<string, Array>>} contactId -> órdenes
 */
export async function fetchOrdersBatch(contactIds = [], sedeActiva = '') {
  const ids = contactIds
    .map(id => sanitizeForVtigerQuery(id, 40))
    .filter(Boolean)
    .slice(0, 40);
  const mapa = new Map();
  if (ids.length === 0) return mapa;

  const condiciones = ids.map(id => `contact_id = '${id}'`).join(' OR ');
  try {
    const ordenes = await queryVTiger(
      `SELECT * FROM SalesOrder WHERE ${condiciones};`,
      sedeActiva,
      { inheritedSede: sedeActiva }
    );
    for (const o of (ordenes || [])) {
      const key = String(o.contact_id || '').trim();
      if (!mapa.has(key)) mapa.set(key, []);
      mapa.get(key).push(o);
    }
  } catch (err) {
    console.warn(`[Order History] [WARN] Lote de órdenes no disponible (${sedeActiva}): ${err.message}`);
  }
  return mapa;
}

// ------------------------------------------------------------------------------
// 2. NORMALIZACIÓN DE UNA ORDEN A UN MODELO ESTABLE
// ------------------------------------------------------------------------------
/**
 * Convierte una fila cruda de SalesOrder (151 campos) en un modelo estable.
 * Los nombres de campo están verificados contra la instancia real.
 */
export function normalizeOrder(o = {}) {
  const num = (v) => {
    const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  return {
    id: o.id || '',
    numeroOrden: o.salesorder_no || '',
    asunto: o.subject || '',
    fecha: String(o.createdtime || '').slice(0, 10),
    estado: o.sostatus || '',
    estadoPago: o.cf_1057 || '',
    fechaEntrega: o.cf_1063 || '',
    total: num(o.hdnGrandTotal ?? o.cf_3304),
    tratamiento: o.cf_1069 || '',
    producto: o.cf_3156 || o.subject || '',
    cantidad: num(o.cf_3298) || num(o.quantity) || 1,
    proveedor: o.cf_2606 || '',
    vendedor: o.cf_2713 || '',
    campana: o.cf_3490 || '',
    canal: o.cf_3513 || '',
    transportista: o.cf_890 || o.carrier || '',
    guia: extraerGuia(o.cf_1045 || o.cf_1051),
    estadoEntrega: o.cf_882 || '',
    conformidad: o.cf_886 || '',
    ciudad: o.cf_876 || '',
    estadoGeo: o.cf_1053 || o.cf_922 || '',
    zip: o.cf_872 || '',
    direccion: o.cf_870 || '',
    formaPago: o.cf_902 || '',
    procesadorPago: o.cf_912 || '',
    // [FASE 4] SEXO: vTiger lo guarda en la ORDEN (cf_862 = Hombre/Mujer/TERCER),
    // NO en el contacto. Aqui se rescata para publicarlo al campo Sexo del contacto.
    sexo: o.cf_862 || '',
    notas: String(o.comment || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
  };
}

function extraerGuia(url = '') {
  const m = String(url).match(/tLabels=([A-Za-z0-9]+)/);
  return m ? m[1] : '';
}

/** Ordena de la más reciente a la más antigua. */
export function sortOrdersDesc(ordenes = []) {
  return [...ordenes].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
}

// ------------------------------------------------------------------------------
// 3. FORMATOS DE SALIDA (nota legible + campo estructurado)
// ------------------------------------------------------------------------------
/**
 * Genera el cuerpo de la nota de la tarjeta del contacto.
 * @param {string} nombreCliente
 * @param {Array} ordenes ya normalizadas
 * @param {string} sedeEtiqueta 'GLOBAL (todas las sedes)' o el sedeId
 */
export function buildOrderHistoryNote(nombreCliente = '', ordenes = [], sedeEtiqueta = '') {
  const total = ordenes.reduce((s, o) => s + (o.total || 0), 0);
  const lineas = [];

  lineas.push(`${MARCADOR_NOTA} HISTORIAL DE COMPRAS - vTiger CRM`);
  lineas.push('=========================================');
  lineas.push(`Cliente: ${nombreCliente || '(sin nombre)'}`);
  lineas.push(`Alcance: ${sedeEtiqueta || 'N/D'}`);
  lineas.push(`Ordenes: ${ordenes.length} | Total acumulado: $${total.toFixed(2)} USD`);
  if (ordenes.length > 0) {
    lineas.push(`Ultima compra: ${ordenes[0].fecha || 'N/D'} | Primera: ${ordenes[ordenes.length - 1].fecha || 'N/D'}`);
  }
  lineas.push('');
  lineas.push(`DETALLE (${Math.min(ordenes.length, MAX_ORDENES_EN_NOTA)} mas recientes):`);

  for (const o of ordenes.slice(0, MAX_ORDENES_EN_NOTA)) {
    lineas.push('');
    lineas.push(`- Orden ${o.numeroOrden || o.id} | ${o.fecha} | $${(o.total || 0).toFixed(2)}`);
    if (o.producto) lineas.push(`  Producto: ${o.producto} (x${o.cantidad})`);
    if (o.tratamiento) lineas.push(`  Tratamiento: ${o.tratamiento}`);
    if (o.estado || o.estadoPago) lineas.push(`  Estado: ${o.estado || '-'} | Pago: ${o.estadoPago || '-'}`);
    if (o.proveedor || o.vendedor) lineas.push(`  Proveedor: ${o.proveedor || '-'} | Vendedor: ${o.vendedor || '-'}`);
    if (o.campana) lineas.push(`  Campana: ${o.campana}`);
    if (o.guia) lineas.push(`  Guia: ${o.guia}${o.estadoEntrega ? ` (${o.estadoEntrega})` : ''}`);
    if (o.formaPago) lineas.push(`  Pago: ${o.formaPago}${o.procesadorPago ? ` / ${o.procesadorPago}` : ''}`);
  }

  if (ordenes.length > MAX_ORDENES_EN_NOTA) {
    lineas.push('');
    lineas.push(`... y ${ordenes.length - MAX_ORDENES_EN_NOTA} ordenes mas (ver vTiger CRM).`);
  }

  lineas.push('');
  lineas.push('Sincronizado por LOA Engine - solo lectura desde vTiger');
  return lineas.join('\n');
}

/**
 * Genera la versión estructurada (campo LARGE_TEXT) para filtros y automatizaciones.
 */
export function buildOrderHistoryField(ordenes = []) {
  const total = ordenes.reduce((s, o) => s + (o.total || 0), 0);
  const resumen = {
    ordenes: ordenes.length,
    total: Number(total.toFixed(2)),
    ultimaCompra: ordenes[0]?.fecha || null,
    primeraCompra: ordenes[ordenes.length - 1]?.fecha || null,
    detalle: ordenes.slice(0, MAX_ORDENES_EN_NOTA).map(o => ({
      n: o.numeroOrden || o.id,
      f: o.fecha,
      m: Number((o.total || 0).toFixed(2)),
      p: o.producto || '',
      t: o.tratamiento || '',
      e: o.estado || ''
    }))
  };
  return JSON.stringify(resumen);
}

// ------------------------------------------------------------------------------
// 4. ESCRITURA EN GHL: NOTA IDEMPOTENTE + CAMPO
// ------------------------------------------------------------------------------
/**
 * Crea o ACTUALIZA la nota de historial del contacto.
 * Idempotencia: busca una nota con `MARCADOR_NOTA` y la actualiza; si no existe,
 * la crea. Así un cliente con 18 compras no acumula 18 notas.
 */
export async function upsertOrderHistoryNote(contactId, cuerpo, headers) {
  const base = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;
  try {
    const res = await ghlFetch(base, { headers }, 1, 'Order History');
    if (res.status !== 200) return { ok: false, status: res.status, error: 'no se pudieron leer las notas' };

    const data = await res.json();
    const existente = (data.notes || []).find(n => String(n.body || '').startsWith(MARCADOR_NOTA));

    if (existente?.id) {
      const put = await ghlFetch(`${base}/${existente.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ body: cuerpo })
      }, 1, 'Order History');
      return { ok: put.status === 200, status: put.status, noteId: existente.id, updated: true };
    }

    const post = await ghlFetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: cuerpo })
    }, 1, 'Order History');
    const creada = await post.json().catch(() => ({}));
    return { ok: post.status === 200 || post.status === 201, status: post.status, noteId: creada?.note?.id || null, created: true };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

/** Escribe el campo estructurado de historial en el contacto. */
export async function writeOrderHistoryField(contactId, valor, headers, fieldId) {
  if (!fieldId) return { ok: false, error: 'campo de historial no resuelto' };
  try {
    const res = await ghlFetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ customFields: [{ id: fieldId, field_value: valor }] })
    }, 1, 'Order History');
    return { ok: res.status === 200, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

/**
 * Escribe VARIOS custom fields en el contacto con UNA sola llamada.
 * Se usa para el enriquecimiento de la ultima orden (Fase 3 + 4): una sola
 * escritura en lugar de una por campo, para no multiplicar las llamadas a GHL.
 */
export async function writeContactFields(contactId, campos = [], headers) {
  if (!contactId || !campos.length) return { ok: false, skipped: true, reason: 'sin campos' };
  try {
    const res = await ghlFetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ customFields: campos })
    }, 1, 'Order History');
    return { ok: res.status === 200, status: res.status, escritos: campos.length };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

/**
 * [FASE 3 + 4] Construye los custom fields de la ULTIMA orden para publicarlos como
 * campos FILTRABLES. Hoy esos datos viven solo dentro de la nota de texto, por eso
 * no se podian usar en Smart Lists. Se publican:
 *   - estado de entrega, conformidad, forma de pago, transportista, tracking
 *   - ultimo producto (para remarketing)
 *   - sexo (rescatado de la orden cf_862, que es donde vTiger lo guarda)
 *
 * @param {object} ultimaOrden orden normalizada (la mas reciente)
 * @param {object} fieldIds     mapa { logico: fieldId } ya resuelto de la location
 * @returns {Array} custom fields listos para el PUT
 */
export function buildOrderEnrichmentFields(ultimaOrden = {}, fieldIds = {}) {
  const campos = [];
  const push = (logico, valor) => {
    const id = fieldIds[logico];
    const v = valor === undefined || valor === null ? '' : String(valor).trim();
    if (id && v) campos.push({ id, field_value: v });
  };
  push('estadoEntrega', ultimaOrden.estadoEntrega);
  push('conformidad', ultimaOrden.conformidad);
  push('formaPago', ultimaOrden.formaPago);
  push('transportista', ultimaOrden.transportista);
  push('tracking', ultimaOrden.guia);
  push('ultimoProducto', ultimaOrden.producto);
  push('sexo', ultimaOrden.sexo);
  return campos;
}

/**
 * Busca en GHL el contacto por teléfono dentro de una location.
 *
 * CORRECCIÓN VERIFICADA EN VIVO: `/contacts/search` responde **HTTP 400** en esta
 * cuenta, por lo que la búsqueda devolvía `null` siempre y el motor concluía
 * "el contacto no existe" aunque sí existiera (comprobado por GET por ID).
 * El endpoint correcto es `/contacts/?locationId=...&query=...`.
 */
async function findContactIdByPhone(locationId, phone, headers) {
  const limpio = String(phone || '').replace(/\D/g, '');
  if (!locationId || limpio.length < 7) return null;
  try {
    const res = await ghlFetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&query=${limpio}`,
      { headers }, 1, 'Order History'
    );
    if (res.status !== 200) {
      console.warn(`[Order History] [SEARCH-WARN] Búsqueda de contacto devolvió HTTP ${res.status} en ${locationId}.`);
      return null;
    }
    const data = await res.json();
    const contactos = data.contacts || [];
    // Coincidencia por los últimos 10 dígitos (NANP) para tolerar formatos.
    const match = contactos.find(x => String(x.phone || '').replace(/\D/g, '').endsWith(limpio.slice(-10)));
    return match?.id || null;
  } catch (err) {
    console.warn(`[Order History] [SEARCH-WARN] ${err.message}`);
    return null;
  }
}

// ------------------------------------------------------------------------------
// 6. BACKFILL DE HISTORIAL COMPLETO (reanudable, por sede, con respiro de rate limit)
// ------------------------------------------------------------------------------
const backfillStore = getStateStore('order_history_backfill');
const CURSOR_KEY = 'cursor_v1';

/** Estado del backfill (para /api/health y diagnóstico). */
export async function getBackfillStatus() {
  const estado = await backfillStore.get(CURSOR_KEY, null);
  return estado || {
    completo: false,
    porSede: {},
    ultimaEjecucion: null,
    totales: { contactos: 0, conOrdenes: 0, ordenes: 0, errores: 0 }
  };
}

/**
 * Ejecuta un lote de backfill del historial de órdenes.
 *
 * DISEÑO:
 *  - Procesa POR SEDE, avanzando con un cursor persistente (reanudable).
 *  - Trae las órdenes EN LOTE por `contact_id` (una consulta vTiger por lote de
 *    hasta 120 contactos), no una por contacto: reduce drásticamente los viajes.
 *  - Sólo considera contactos con compras y teléfono (el teléfono es la llave de
 *    emparejamiento con GHL).
 *  - Escribe: nota idempotente + campo estructurado, en la sede y (si está
 *    configurada) en la Cuenta Empresa con el historial global.
 *
 * @param {object} opts
 * @param {number} [opts.tamanoLote=50]   contactos por lote y por sede
 * @param {number} [opts.maxLotes=1]      lotes a procesar en esta ejecución
 * @param {number} [opts.pausaMs=400]     pausa entre contactos (respiro de API)
 * @param {string[]} [opts.sedes]         sedes a procesar
 */
export async function runOrderHistoryBackfill({
  tamanoLote = 50,
  maxLotes = 1,
  pausaMs = 400,
  sedes = null
} = {}) {
  const sedesObjetivo = (sedes && sedes.length ? sedes : getActiveSedes().map(s => s.sedeId))
    .map(s => String(s).toUpperCase())
    .filter(s => SEDES_GATEWAY[s]?.isConfigured);

  const estado = await getBackfillStatus();
  const inicio = Date.now();
  const resumen = { lotes: 0, contactos: 0, conOrdenes: 0, ordenes: 0, notas: 0, errores: 0, porSede: {} };

  for (const sede of sedesObjetivo) {
    const cursorSede = estado.porSede[sede]?.offset || 0;
    resumen.porSede[sede] = { desdeOffset: cursorSede, procesados: 0 };
  }

  for (let lote = 0; lote < maxLotes; lote++) {
    let procesadosEnLote = 0;

    for (const sede of sedesObjetivo) {
      const offset = estado.porSede[sede]?.offset || 0;
      const limite = Math.min(Math.max(parseInt(tamanoLote, 10) || 50, 1), 150);

      // Sólo clientes con compras y con teléfono (llave de emparejamiento con GHL)
      const q = `SELECT id, firstname, lastname, phone, mobile, homephone, cf_3451, spl_num_compras, spl_fecha_ultima_compra FROM Contacts WHERE spl_num_compras > 0${sedeClause(sede)} ORDER BY modifiedtime DESC LIMIT ${offset}, ${limite};`;

      let contactos = [];
      try {
        contactos = await queryVTiger(q, sede);
      } catch (err) {
        console.error(`[Order Backfill] [ERROR] Consulta fallida en ${sede}: ${err.message}`);
        resumen.errores++;
        continue;
      }

      if (contactos.length === 0) {
        estado.porSede[sede] = { ...(estado.porSede[sede] || {}), offset, completo: true, ultimaEjecucion: new Date().toISOString() };
        console.log(`[Order Backfill] [${sede}] Sin más contactos. Sede completada en offset ${offset}.`);
        continue;
      }

      // Órdenes en LOTE para todo el bloque
      const conTelefono = contactos.filter(c => String(c.homephone || c.mobile || c.phone || '').replace(/\D/g, '').length >= 7);
      const ordenesMap = await fetchOrdersBatch(conTelefono.map(c => c.id), sede);

      for (const vContact of conTelefono) {
        try {
          const r = await syncContactOrderHistory({ vContact, ordenesPorContacto: ordenesMap });
          resumen.contactos++;
          if (!r.skipped && r.ordenes > 0) {
            resumen.conOrdenes++;
            resumen.ordenes += r.ordenes;
            if (r.operativa?.nota?.ok) resumen.notas++;
          }
          resumen.porSede[sede].procesados++;
        } catch (err) {
          resumen.errores++;
          recordAuditEvent({ type: 'ORDER_HISTORY_CONTACT_FAIL', severity: 'warn', sede, vTigerId: vContact.id, message: err.message });
        }
        if (pausaMs > 0) await new Promise(r => setTimeout(r, pausaMs));
      }

      estado.porSede[sede] = {
        offset: offset + contactos.length,
        ultimaEjecucion: new Date().toISOString(),
        ultimoLote: contactos.length,
        completo: contactos.length < limite
      };
      procesadosEnLote += contactos.length;

      console.log(`[Order Backfill] [${sede}] Lote procesado: ${contactos.length} contactos (offset -> ${offset + contactos.length}).`);
    }

    resumen.lotes++;
    // Persistir el cursor tras cada lote: el proceso puede reanudarse sin repetir.
    estado.ultimaEjecucion = new Date().toISOString();
    estado.totales = {
      contactos: (estado.totales?.contactos || 0) + resumen.contactos,
      conOrdenes: (estado.totales?.conOrdenes || 0) + resumen.conOrdenes,
      ordenes: (estado.totales?.ordenes || 0) + resumen.ordenes,
      errores: (estado.totales?.errores || 0) + resumen.errores
    };
    estado.completo = sedesObjetivo.every(s => estado.porSede[s]?.completo);
    await backfillStore.set(CURSOR_KEY, estado);

    if (procesadosEnLote === 0) break; // nada más que hacer
  }

  resumen.ms = Date.now() - inicio;
  resumen.completo = estado.completo;
  recordAuditEvent({ type: 'ORDER_HISTORY_BACKFILL', severity: resumen.errores > 0 ? 'warn' : 'info', ...resumen });
  console.log(`[Order Backfill] [DONE] ${JSON.stringify(resumen)}`);
  return resumen;
}

/** Reinicia el cursor para volver a recorrer todo desde cero. */
export async function resetOrderHistoryBackfill() {
  await backfillStore.set(CURSOR_KEY, {
    completo: false,
    porSede: {},
    ultimaEjecucion: null,
    totales: { contactos: 0, conOrdenes: 0, ordenes: 0, errores: 0 }
  });
  console.log('[Order Backfill] [RESET] Cursor reiniciado.');
}

// ------------------------------------------------------------------------------
// 5. SINCRONIZACIÓN POR CONTACTO (con aislamiento por sede)
// ------------------------------------------------------------------------------
/**
 * Publica el historial de órdenes de UN contacto.
 *
 * @param {object} params
 * @param {object} params.vContact registro de vTiger (con phone/homephone, cf_3451)
 * @param {Map<string,Array>} [params.ordenesPorContacto] órdenes ya traídas en lote
 * @returns {Promise<object>} resultado
 */
export async function syncContactOrderHistory({ vContact, ordenesPorContacto = null, contactIdSede = null, contactIdMacro = null }) {
  const sedeId = String(vContact.cf_3451 || '').toUpperCase().trim();
  const sedeConf = SEDES_GATEWAY[sedeId];
  if (!sedeConf) return { ok: false, skipped: true, reason: 'sede no reconocida' };

  const phone = String(vContact.homephone || vContact.mobile || vContact.phone || '').replace(/\D/g, '');
  if (phone.length < 7) return { ok: false, skipped: true, reason: 'sin teléfono' };

  const nombre = `${vContact.firstname || ''} ${vContact.lastname || ''}`.trim();

  // Órdenes de la sede del contacto
  let ordenes = ordenesPorContacto?.get(String(vContact.id))
    || await fetchOrdersForContact(vContact.id, sedeId);
  if (ordenes.length === 0) return { ok: true, skipped: true, reason: 'sin órdenes', ordenes: 0 };

  const normalizadas = sortOrdersDesc(ordenes.map(normalizeOrder));
  const resultado = { ok: true, sede: sedeId, ordenes: normalizadas.length, operativa: null, macro: null };

  // ===== SUBCUENTA DE LA SEDE: solo sus propias órdenes =====
  const sedeHeaders = getGhlHeaders({ locationId: sedeConf.ghl.locationId });
  // [CRÍTICO] Se prefiere el id que devolvió el upsert. La BÚSQUEDA por teléfono
  // de GHL tiene retraso de indexación: consultarla justo después de crear el
  // contacto devuelve 0 resultados, y el historial se perdía. Con el id directo
  // no hay dependencia del índice.
  const contactoId = contactIdSede || await findContactIdByPhone(sedeConf.ghl.locationId, phone, sedeHeaders);
  if (contactIdSede) console.log(`[Order History] [ID-DIRECTO] Se usa el id del upsert en la sede (${contactIdSede}) en lugar de buscar.`);

  if (contactoId) {
    const cuerpo = buildOrderHistoryNote(nombre, normalizadas, sedeId);
    const nota = await upsertOrderHistoryNote(contactoId, cuerpo, sedeHeaders);

    // Campo LARGE_TEXT "vTiger Historial Completo" (LARGE_TEXT verificado en vivo).
    const fields = await resolveCustomFieldIds(sedeConf.ghl.locationId, sedeHeaders);
    const historialFieldId = fields.historialCompleto;
    const campo = historialFieldId
      ? await writeOrderHistoryField(contactoId, buildOrderHistoryField(normalizadas), sedeHeaders, historialFieldId)
      : { ok: false, error: 'campo de historial no presente en esta location' };

    // [FASE 3 + 4] Enriquecimiento con los datos de la ULTIMA orden como campos
    // filtrables + sexo rescatado de la orden. Una sola escritura multi-campo.
    const enrichment = buildOrderEnrichmentFields(normalizadas[0], fields);
    const enrique = enrichment.length
      ? await writeContactFields(contactoId, enrichment, sedeHeaders)
      : { ok: false, skipped: true, reason: 'sin campos de enriquecimiento resueltos' };

    resultado.operativa = { contactId: contactoId, nota, campo, enrique };
    recordAuditEvent({
      type: nota.ok ? 'ORDER_HISTORY_SEDE_OK' : 'ORDER_HISTORY_SEDE_FAIL',
      severity: nota.ok ? 'info' : 'warn',
      sede: sedeId,
      contactId: contactoId,
      ordenes: normalizadas.length,
      notaActualizada: Boolean(nota.updated),
      notaCreada: Boolean(nota.created),
      status: nota.status,
      camposEnriquecidos: enrichment.length
    });
  } else {
    resultado.operativa = { contactId: null, reason: 'el contacto no existe en la subcuenta de la sede' };
  }

  // ===== CUENTA EMPRESA: historial GLOBAL (todas las sedes) =====
  if (isCentralConfigured()) {
    const centralHeaders = {
      Authorization: `Bearer ${CENTRAL_API_KEY}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    const centralContactId = contactIdMacro || await findContactIdByPhone(CENTRAL_LOCATION_ID, phone, centralHeaders);
    if (centralContactId) {
      // Historial global: se piden TODAS las órdenes del contacto, sin filtro de sede.
      const todas = [];
      for (const sede of getActiveSedes().map(s => s.sedeId)) {
        try {
          const o = await fetchOrdersForContact(vContact.id, sede);
          todas.push(...o.map(x => ({ ...x, __sede: sede })));
        } catch { /* una sede caída no bloquea el consolidado */ }
      }
      const normGlobal = sortOrdersDesc(todas.map(normalizeOrder));
      const notaGlobal = await upsertOrderHistoryNote(
        centralContactId,
        buildOrderHistoryNote(nombre, normGlobal, 'GLOBAL (todas las sedes)'),
        centralHeaders
      );

      // [FASE 3 + 4] Enriquecimiento GLOBAL: la ultima orden entre TODAS las sedes
      // dicta el estado de entrega, forma de pago, producto y sexo en la Empresa.
      // Asi la Empresa refleja la sede MAS RECIENTE de forma natural.
      const fieldsCentral = await resolveCustomFieldIds(CENTRAL_LOCATION_ID, centralHeaders);
      const enrichmentGlobal = buildOrderEnrichmentFields(normGlobal[0], fieldsCentral);
      const enriqueMacro = enrichmentGlobal.length
        ? await writeContactFields(centralContactId, enrichmentGlobal, centralHeaders)
        : { ok: false, skipped: true, reason: 'sin campos de enriquecimiento resueltos' };

      resultado.macro = { contactId: centralContactId, nota: notaGlobal, ordenes: normGlobal.length, enrique: enriqueMacro };
    } else {
      resultado.macro = { contactId: null, reason: 'el contacto no existe en la Cuenta Empresa' };
    }
  }

  return resultado;
}
