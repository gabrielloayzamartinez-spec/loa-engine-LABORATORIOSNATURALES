/**
 * ==============================================================================
 * NIVEL 3 — SINCRONIZACIÓN REACTIVA vTiger → GHL (por cambio, no por barrido)
 * ==============================================================================
 * POR QUÉ EXISTE (auditoría 27/11/2026):
 * El Nivel 2 recorre la cartera por cursor: avanza a 249 contactos/hora y tiene
 * 128 h de ETA para Palacios. Eso está bien para el HISTÓRICO, pero un cliente que
 * compra HOY no puede esperar 5 días a que el cursor llegue a su ficha: su compra,
 * su etapa y su monto deben estar en GHL en minutos.
 *
 * El Nivel 3 cierra esa brecha: cuando un contacto cambia en vTiger (compra, etapa,
 * asesor, datos), se sincroniza ESE contacto, completo, en segundos.
 *
 * DIFERENCIAS CON LOS OTROS NIVELES
 *   N1 · atención en vivo de Meta  → prioridad absoluta, nunca se frena.
 *   N2A · histórico (cursor)        → cobertura, lo más nuevo primero.
 *   N2B · reconciliación            → completitud de lo ya sincronizado.
 *   N3 · reactivo vTiger            → un cambio = una sincronización puntual.
 *
 * GARANTÍAS
 *   1. IDEMPOTENCIA: la clave es `sede:id:modifiedtime`. Reenviar el mismo cambio
 *      no reescribe nada (TTL 15 min).
 *   2. CUOTA: cada contacto pasa por `hayCuotaRealDeFondo(sede)`. Sin cuota, el job
 *      se reprograma (no se pierde y no compite con el Nivel 1).
 *   3. ANTI-DOBLE-TRABAJO: respeta el cooldown del motor reactivo para no repetir
 *      lo que el reverse sync acaba de escribir.
 *   4. AISLAMIENTO: la lectura de vTiger va SIEMPRE filtrada por sede (`cf_3451`).
 *   5. SIN BUCLE: solo LEE de vTiger; la escritura va a GHL. El cursor avanza por
 *      `modifiedtime` y los empates se resuelven con la clave de idempotencia.
 * ==============================================================================
 */

import {
  query as vtigerQuery, VTIGER_CONTACT_SELECT, VTIGER_FIELDS,
  VTIGER_SEDES_VALIDAS, sedeActualClause
} from './vtigerClient.js';
import { syncVtigerContactDual, pickPhone } from './dual_sync_service.js';
import { getQueue, QUEUES, JOBS, getQueueStatus } from './queue/durable_queue.js';
import { hayCuotaRealDeFondo } from '../utils/ghl_http_client.js';
import { recordAuditEvent } from './audit_logger.js';
import { estaEnCooldown } from './reactive_cooldown.js';
import { getStateStore } from './state/state_store.js';
import { envInt } from '../config/secrets.js';
import { fechaLimaISO } from '../domain/ventana_temporal.js';

const store = getStateStore('nivel3_reactive');
const CURSOR_PREFIX = 'cursor:';

/**
 * Techos del carril reactivo (todos configurable por entorno).
 *
 * Se dimensionan con la medición real de vTiger (27/11/2026):
 *   · 39.359 contactos modificados en 24 h en las 4 sedes (9.390 compradores).
 * Sincronizar todo con ficha completa serían ~50.000 llamadas GHL/día y dejaría sin
 * cuota al histórico. El Nivel 3 es REACTIVO, no masivo: prioriza lo reciente.
 */
export const MAX_DIA = envInt('NIVEL3_MAX_DIA', 20000);            // contactos/día
export const MAX_ATRASO_MIN = envInt('NIVEL3_MAX_ATRASO_MIN', 45); // atraso tolerado
// [27/11] Por defecto se sincroniza TODO lo que cambia en vTiger (contactos y
// compradores): el objetivo del negocio es que los CF de vTiger estén reflejados.
export const SOLO_COMPRADORES = String(process.env.NIVEL3_SOLO_COMPRADORES || 'false').toLowerCase() === 'true';
// Un mismo contacto editado 10 veces en una hora no debe sincronizarse 10 veces.
export const COOLDOWN_MIN = Math.max(envInt('NIVEL3_COOLDOWN_MIN', 10), 1);
const COOLDOWN_MS = COOLDOWN_MIN * 60000;
const ultimaSync = new Map(); // vTigerId -> ts de la última sincronización del N3

const consumoDia = { fecha: '', n: 0 };
function diaLima() {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}
function consumoDelDia() {
  const hoy = diaLima();
  if (consumoDia.fecha !== hoy) { consumoDia.fecha = hoy; consumoDia.n = 0; }
  return consumoDia.n;
}
function registrarConsumoDia(n = 1) {
  consumoDelDia();
  consumoDia.n += n;
}

/**
 * Convierte un `modifiedtime` de vTiger ('YYYY-MM-DD HH:MM:SS', hora de Lima) a ms.
 * vTiger guarda las fechas en la zona del servidor (America/Lima, UTC-5 sin DST).
 */
export function fechaVtigerMs(valor) {
  const s = String(valor || '').trim();
  if (!s) return 0;
  const iso = `${s.replace(' ', 'T')}-05:00`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** TTL del deduplicado: un mismo cambio no se reprocesa dentro de esta ventana. */
export const TTL_DEDUPE_MS = 15 * 60 * 1000;
const MAX_DEDUPE = 5000;

/** Máximo de sincronizaciones simultáneas (protege el event loop y la cuota). */
const MAX_CONCURRENTES = 2;
let enVuelo = 0;

const dedupe = new Map(); // clave -> ts
const contadores = { encolados: 0, sincronizados: 0, saltados: 0, reintentos: 0, errores: 0 };
let ultimaCorrida = null;
let ultimoError = null;
const cursorMemoria = new Map();

/**
 * Clave de idempotencia de un cambio de vTiger.
 * @param {string} sede
 * @param {string|number} id
 * @param {string} modifiedtime
 * @returns {string}
 */
export function claveIdempotencia(sede, id, modifiedtime) {
  return `${String(sede || '').toUpperCase()}:${String(id || '').trim()}:${String(modifiedtime || '').trim()}`;
}

/**
 * Decisión PURA (sin red) de qué hacer con un cambio.
 * Se aísla para poder probarla y para que la regla quede escrita una sola vez.
 *
 * @param {object} p
 * @param {boolean} p.yaProcesado
 * @param {boolean} p.hayCuota
 * @param {boolean} p.existeRegistro
 * @param {boolean} p.enCooldown
 * @returns {{accion:'sincronizar'|'saltar'|'reintentar', motivo:string}}
 */
export function decidirSincronizacion({ yaProcesado, hayCuota, existeRegistro, enCooldown }) {
  if (yaProcesado) return { accion: 'saltar', motivo: 'cambio ya procesado (idempotencia)' };
  if (!existeRegistro) return { accion: 'saltar', motivo: 'el contacto no existe en vTiger para esa sede' };
  if (enCooldown) return { accion: 'saltar', motivo: 'cooldown: el motor reactivo ya lo sincronizó' };
  if (!hayCuota) return { accion: 'reintentar', motivo: 'sin cuota de fondo disponible' };
  return { accion: 'sincronizar', motivo: 'cambio nuevo con cuota disponible' };
}

function limpiarDedupe() {
  const corte = Date.now() - TTL_DEDUPE_MS;
  for (const [k, ts] of dedupe) if (ts < corte) dedupe.delete(k);
  while (dedupe.size > MAX_DEDUPE) {
    const primera = dedupe.keys().next().value;
    dedupe.delete(primera);
  }
}

async function leerCursor(sede) {
  if (cursorMemoria.has(sede)) return cursorMemoria.get(sede);
  try {
    const v = await store.get(`${CURSOR_PREFIX}${sede}`, null);
    if (v) cursorMemoria.set(sede, v);
    return v || null;
  } catch { return null; }
}

async function guardarCursor(sede, modifiedtime) {
  cursorMemoria.set(sede, modifiedtime);
  try { await store.set(`${CURSOR_PREFIX}${sede}`, modifiedtime); } catch { /* memoria alcanza */ }
}

/**
 * Procesa UN cambio de vTiger: relee la ficha completa y la sincroniza a GHL.
 *
 * @param {object} payload { id, sede, modifiedtime, motivo }
 * @param {object} [deps] inyección para pruebas (query, sync, cuota, cooldown)
 * @returns {Promise<object>}
 */
export async function procesarCambioVtiger(payload = {}, deps = {}) {
  const {
    query = vtigerQuery,
    sincronizar = syncVtigerContactDual,
    hayCuota = hayCuotaRealDeFondo,
    enCooldown = estaEnCooldown,
    cooldownMs = COOLDOWN_MS
  } = deps;

  const id = String(payload.id || '').trim();
  const sede = String(payload.sede || '').toUpperCase().trim();
  const modifiedtime = String(payload.modifiedtime || '').trim();

  if (!id || !VTIGER_SEDES_VALIDAS.includes(sede)) {
    return { ok: false, accion: 'saltar', motivo: 'payload inválido (id o sede)' };
  }

  const clave = claveIdempotencia(sede, id, modifiedtime);
  limpiarDedupe();

  // Lectura puntual acotada por OFICINA ACTUAL (cf_3590): el cambio se publica en la
  // subcuenta donde el contacto está HOY. Con cf_3451, un contacto reasignado no se
  // encontraba y el cambio se perdía en silencio.
  const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.ID} = '${id.replace(/[^A-Za-z0-9]/g, '')}'${sedeActualClause(sede)};`;
  let filas = [];
  try {
    filas = await query(q, { context: 'nivel3-sync' }) || [];
  } catch (err) {
    contadores.errores++;
    ultimoError = err.message;
    recordAuditEvent({ type: 'NIVEL3_READ_FAILED', severity: 'warn', sede, vTigerId: id, message: err.message });
    return { ok: false, accion: 'reintentar', motivo: `lectura vTiger falló: ${err.message}`, reintentable: true };
  }

  const registro = filas[0] || null;
  const phone = registro ? pickPhone(registro) : null;

  const decision = decidirSincronizacion({
    yaProcesado: dedupe.has(clave),
    hayCuota: hayCuota(sede),
    existeRegistro: Boolean(registro),
    // [COOLDOWN] Ni el motor reactivo ni el propio N3 deben reescribir el mismo
    // contacto dos veces en COOLDOWN_MIN minutos: un asesor guardando 10 veces la
    // misma ficha genera 10 cambios de `modifiedtime` y una sola sincronización basta.
    enCooldown: Boolean(registro) && (
      Boolean(enCooldown(id, phone)) ||
      (cooldownMs > 0 && (Date.now() - (ultimaSync.get(id) || 0) < cooldownMs))
    )
  });

  if (decision.accion === 'saltar') {
    contadores.saltados++;
    return { ok: true, accion: 'saltar', motivo: decision.motivo };
  }
  if (decision.accion === 'reintentar') {
    contadores.reintentos++;
    return { ok: false, accion: 'reintentar', motivo: decision.motivo, reintentable: true };
  }

  try {
    const resultado = await sincronizar(registro, { permitirLead: true });
    dedupe.set(clave, Date.now());
    ultimaSync.set(id, Date.now());
    // Poda del mapa de cooldown (memoria acotada).
    if (ultimaSync.size > 20000) {
      const corte = Date.now() - COOLDOWN_MS;
      for (const [k, ts] of ultimaSync) if (ts < corte) ultimaSync.delete(k);
    }
    contadores.sincronizados++;
    recordAuditEvent({
      type: 'NIVEL3_SYNC_OK',
      severity: 'info',
      sede,
      vTigerId: id,
      modifiedtime,
      motivo: payload.motivo || 'cambio',
      ok: Boolean(resultado?.ok),
      skipped: Boolean(resultado?.skipped)
    });
    return { ok: true, accion: 'sincronizar', resultado };
  } catch (err) {
    contadores.errores++;
    ultimoError = err.message;
    recordAuditEvent({ type: 'NIVEL3_SYNC_FAIL', severity: 'error', sede, vTigerId: id, message: err.message });
    return { ok: false, accion: 'reintentar', motivo: err.message, reintentable: true };
  }
}

/**
 * Encola un cambio para que lo procese el worker (cola durable si está activa).
 * @param {object} payload { id, sede, modifiedtime, motivo }
 */
export async function encolarCambioVtiger(payload = {}) {
  contadores.encolados++;
  const q = getQueue(QUEUES.NIVEL3);
  return q.enqueue(JOBS.NIVEL3_SYNC, payload);
}

/**
 * Recorre vTiger por `modifiedtime` (lo más viejo pendiente primero), encola los
 * cambios y avanza el cursor. En el primer arranque se ancla en el último cambio
 * conocido: el histórico lo cubre el Nivel 2, no este carril.
 *
 * @param {object} [opts]
 * @param {number} [opts.limite=25] cambios máximos por sede y por ciclo
 * @param {string[]} [opts.sedes] sedes a recorrer
 * @param {object} [opts.deps] inyección para pruebas
 */
export async function runNivel3Tail({ limite = 10, sedes = VTIGER_SEDES_VALIDAS, deps = {} } = {}) {
  const {
    query = vtigerQuery,
    encolar = encolarCambioVtiger,
    cuotaDisponible = hayCuotaRealDeFondo,
    leerCursorDe = leerCursor,
    guardarCursorDe = guardarCursor
  } = deps;

  const resumen = { sedes: {}, encolados: 0, inicializadas: [], sinCuota: [], topeDiario: [], saltos: [] };

  for (const sede of sedes.map(s => String(s).toUpperCase())) {
    if (!VTIGER_SEDES_VALIDAS.includes(sede)) continue;
    try {
      let cursor = await leerCursorDe(sede);

      if (!cursor) {
        // Ancla: el último cambio registrado. No se barre el histórico por aquí.
        const qUltimo = `SELECT modifiedtime FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${sede}' ORDER BY modifiedtime DESC LIMIT 1;`;
        const ultimo = (await query(qUltimo, { context: 'nivel3-ancla' }))?.[0];
        if (ultimo?.modifiedtime) {
          await guardarCursorDe(sede, ultimo.modifiedtime);
          resumen.inicializadas.push({ sede, cursor: ultimo.modifiedtime });
        }
        resumen.sedes[sede] = { encolados: 0, ancla: ultimo?.modifiedtime || null };
        continue;
      }

      // [CUOTA] Si no hay cuota real, no se encola: se reintenta en el próximo ciclo.
      if (!cuotaDisponible(sede)) {
        resumen.sinCuota.push(sede);
        resumen.sedes[sede] = { encolados: 0, motivo: 'sin cuota' };
        continue;
      }

      // [TOPE DIARIO] vTiger registra ~39.000 cambios/día en las 4 sedes (9.390 de
      // compradores). Sincronizar TODOS con ficha completa serían ~50.000 llamadas
      // GHL/día y dejaría sin cuota al histórico (N2A). El Nivel 3 tiene su propio
      // techo: protege la cuota y mantiene el carril reactivo, no masivo.
      const usadoHoy = consumoDelDia();
      if (usadoHoy >= MAX_DIA) {
        resumen.topeDiario.push(sede);
        resumen.sedes[sede] = { encolados: 0, motivo: `tope diario alcanzado (${usadoHoy}/${MAX_DIA})` };
        continue;
      }

      const cupo = Math.max(0, Math.min(parseInt(limite, 10) || 10, MAX_DIA - usadoHoy));
      if (cupo === 0) {
        resumen.topeDiario.push(sede);
        resumen.sedes[sede] = { encolados: 0, motivo: 'sin cupo diario' };
        continue;
      }

      // [UNA SOLA CONSULTA CUANDO NO HAY CAMBIOS] La consulta pide los más VIEJOS
      // pendientes: si no hay filas, el carril está al día y no se hace nada más
      // (4 consultas/min en reposo, no 12). Si hay filas, la primera es justamente
      // la que mide el atraso.
      const filtroComprador = SOLO_COMPRADORES ? ` AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0` : '';
      const q = `SELECT id, modifiedtime FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${sede}'${filtroComprador} AND modifiedtime > '${cursor.replace(/'/g, '')}' ORDER BY modifiedtime ASC LIMIT ${cupo};`;
      const filas = await query(q, { context: 'nivel3-tail' }) || [];

      // [ANTI-ATRASO] Si el cambio más viejo pendiente ya tiene más de MAX_ATRASO_MIN,
      // el carril no puede drenar la cola (y no debe intentarlo: eso es el histórico).
      // Se SALTA al presente y se deja constancia: mejor reactivo y al día que un
      // backlog eterno que nunca alcanza lo que acaba de pasar.
      if (filas.length > 0) {
        const lagMin = (Date.now() - fechaVtigerMs(filas[0].modifiedtime)) / 60000;
        if (lagMin > MAX_ATRASO_MIN) {
          const qAhora = `SELECT modifiedtime FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${sede}' ORDER BY modifiedtime DESC LIMIT 1;`;
          const ahoraVt = (await query(qAhora, { context: 'nivel3-jump' }))?.[0]?.modifiedtime || null;
          if (ahoraVt) await guardarCursorDe(sede, ahoraVt);
          resumen.saltos.push({ sede, atrasoMin: Math.round(lagMin), nuevoCursor: ahoraVt });
          recordAuditEvent({
            type: 'NIVEL3_CURSOR_JUMP',
            severity: 'warn',
            sede,
            atrasoMin: Math.round(lagMin),
            cursorAnterior: cursor,
            cursorNuevo: ahoraVt,
            reason: 'el atraso supera el máximo del carril reactivo; el histórico lo cubre N2A'
          });
          resumen.sedes[sede] = { encolados: 0, salto: true, atrasoMin: Math.round(lagMin) };
          continue;
        }
      }

      for (const f of filas) {
        await encolar({ id: f.id, sede, modifiedtime: f.modifiedtime, motivo: 'tail' });
        resumen.encolados++;
        registrarConsumoDia(1);
      }
      if (filas.length > 0) {
        // Se avanza al último modifiedtime leído. Los empates de ese mismo segundo
        // los absorbe la clave de idempotencia (no se reprocesan).
        await guardarCursorDe(sede, filas[filas.length - 1].modifiedtime);
      }
      resumen.sedes[sede] = { encolados: filas.length, cursor: filas[filas.length - 1]?.modifiedtime || cursor };
    } catch (err) {
      resumen.sedes[sede] = { error: err.message };
      ultimoError = err.message;
    }
  }

  ultimaCorrida = new Date().toISOString();
  return resumen;
}

// ------------------------------------------------------------------------------
// NIVEL 3 — REACTIVIDAD A NIVEL DE ORDEN DE VENTA
// ------------------------------------------------------------------------------
/**
 * POR QUÉ EXISTE
 * Una venta nueva puede cambiar el contacto (compras, fechas, monto) sin que su
 * `modifiedtime` cambie en el mismo instante, y el tail de contactos no la vería.
 * Este carril vigila `SalesOrder` y encola el CONTACTO de la orden — así una venta
 * de hoy llega a GHL en minutos, no cuando el cursor histórico la alcance.
 *
 * `SalesOrder` NO tiene `cf_3451` (la sede se hereda del contacto), así que la
 * consulta es global y la sede se resuelve DESPUÉS con los contactos de la orden.
 * Se descartan las órdenes cuyo contacto no pertenece a una sede válida.
 */
const ORDEN_CURSOR_KEY = 'cursor:ordenes';
let ordenCursorMemoria = null;

async function leerCursorOrdenes() {
  if (ordenCursorMemoria) return ordenCursorMemoria;
  try { ordenCursorMemoria = await store.get(ORDEN_CURSOR_KEY, null); } catch { ordenCursorMemoria = null; }
  return ordenCursorMemoria;
}
async function guardarCursorOrdenes(v) {
  ordenCursorMemoria = v;
  try { await store.set(ORDEN_CURSOR_KEY, v); } catch { /* memoria alcanza */ }
}

/**
 * @param {object} [opts]
 * @param {number} [opts.limite=20] órdenes por ciclo
 * @param {object} [opts.deps] inyección para pruebas
 */
export async function runNivel3OrderTail({ limite = 20, deps = {} } = {}) {
  const {
    query = vtigerQuery,
    encolar = encolarCambioVtiger,
    cuotaDisponible = hayCuotaRealDeFondo,
    leerCursorOrdenesDe = leerCursorOrdenes,
    guardarCursorOrdenesDe = guardarCursorOrdenes
  } = deps;

  const resumen = { ordenes: 0, encolados: 0, sinSede: 0, sinContacto: 0, ancla: null, saltos: [] };

  let cursor = await leerCursorOrdenesDe();
  if (!cursor) {
    const qAncla = 'SELECT modifiedtime FROM SalesOrder ORDER BY modifiedtime DESC LIMIT 1;';
    const ultima = (await query(qAncla, { context: 'nivel3-orden-ancla', inheritedSede: 'PALACIOS' }))?.[0];
    if (ultima?.modifiedtime) await guardarCursorOrdenesDe(ultima.modifiedtime);
    resumen.ancla = ultima?.modifiedtime || null;
    return resumen;
  }

  const n = Math.min(Math.max(parseInt(limite, 10) || 20, 1), 100);
  // [FRONTERA N1/N2 — 27/11] La VENTA de HOY es trabajo del Nivel 2 (mañana).
  // El Nivel 1 atiende el día en calidad de CONTACTO (número obtenido, etiquetas,
  // segmentación). Una orden de venta registrada hoy llena más CF en vTiger, pero
  // esos CF se reflejan al día siguiente: se corta en el inicio del día de Lima.
  // Así el equipo ve "hoy" sin que una venta a medio registrar le mueva la ficha.
  const corteHoy = `${fechaLimaISO(new Date())} 00:00:00`;
  const q = `SELECT id, contact_id, modifiedtime FROM SalesOrder WHERE modifiedtime > '${cursor.replace(/'/g, '')}' AND modifiedtime < '${corteHoy} 00:00:00' ORDER BY modifiedtime ASC LIMIT ${n};`;
  const ordenes = await query(q, { context: 'nivel3-ordenes', inheritedSede: 'PALACIOS' }) || [];
  resumen.ordenes = ordenes.length;
  if (ordenes.length === 0) return resumen;

  // [ANTI-ATRASO] Igual que el carril de contactos: si la orden pendiente más vieja
  // supera el máximo, se salta al presente (el histórico lo cubre N2A).
  const lagMin = (Date.now() - fechaVtigerMs(ordenes[0].modifiedtime)) / 60000;
  if (lagMin > MAX_ATRASO_MIN) {
    const qAhora = 'SELECT modifiedtime FROM SalesOrder ORDER BY modifiedtime DESC LIMIT 1;';
    const ahora = (await query(qAhora, { context: 'nivel3-orden-jump', inheritedSede: 'PALACIOS' }))?.[0];
    if (ahora?.modifiedtime) await guardarCursorOrdenesDe(ahora.modifiedtime);
    resumen.saltos.push({ atrasoMin: Math.round(lagMin), nuevoCursor: ahora?.modifiedtime || null });
    recordAuditEvent({
      type: 'NIVEL3_ORDER_CURSOR_JUMP',
      severity: 'warn',
      atrasoMin: Math.round(lagMin),
      cursorAnterior: cursor,
      cursorNuevo: ahora?.modifiedtime || null
    });
    return resumen;
  }

  // Sede de cada contacto de la orden (una sola consulta por lote).
  const contactIds = [...new Set(ordenes.map(o => String(o.contact_id || '').trim()).filter(Boolean))];
  const sedePorContacto = new Map();
  if (contactIds.length) {
    const cond = contactIds.slice(0, 40).map(id => `id = '${id.replace(/[^A-Za-z0-9]/g, '')}'`).join(' OR ');
    const filas = await query(`SELECT id, cf_3451, cf_3590 FROM Contacts WHERE ${cond};`, { context: 'nivel3-orden-sede' }) || [];
    for (const f of filas) {
      const sede = String(f.cf_3590 || f.cf_3451 || '').toUpperCase().trim();
      if (VTIGER_SEDES_VALIDAS.includes(sede)) sedePorContacto.set(String(f.id), sede);
    }
  }

  for (const o of ordenes) {
    const contactId = String(o.contact_id || '').trim();
    if (!contactId) { resumen.sinContacto++; continue; }
    const sede = sedePorContacto.get(contactId);
    if (!sede) { resumen.sinSede++; continue; }
    if (!cuotaDisponible(sede)) continue;
    await encolar({ id: contactId, sede, modifiedtime: o.modifiedtime, motivo: 'orden' });
    resumen.encolados++;
    registrarConsumoDia(1);
  }

  await guardarCursorOrdenesDe(ordenes[ordenes.length - 1].modifiedtime);
  return resumen;
}

/** Estado del Nivel 3 (para /api/nivel3/estado y el panel). */
export async function getNivel3Status() {
  const cursores = {};
  for (const sede of VTIGER_SEDES_VALIDAS) {
    cursores[sede] = (await leerCursor(sede)) || null;
  }
  return {
    ok: true,
    cola: getQueueStatus(),
    cursores,
    cursorOrdenes: (await leerCursorOrdenes()) || null,
    dedupeEnMemoria: dedupe.size,
    ttlDedupeMin: Math.round(TTL_DEDUPE_MS / 60000),
    limites: {
      maxDia: MAX_DIA,
      maxAtrasoMin: MAX_ATRASO_MIN,
      soloCompradores: SOLO_COMPRADORES,
      cooldownMin: COOLDOWN_MIN,
      consumoHoy: consumoDelDia()
    },
    contadores: { ...contadores },
    enVuelo,
    ultimaCorrida,
    ultimoError,
    regla: 'un cambio de vTiger = una sincronización puntual; cursor por modifiedtime con tope diario'
  };
}

/** Reinicia los cursores (el próximo ciclo vuelve a anclarse en el presente). */
export async function reiniciarCursoresN3() {
  for (const sede of VTIGER_SEDES_VALIDAS) {
    cursorMemoria.delete(sede);
    try { await store.set(`${CURSOR_PREFIX}${sede}`, null); } catch { /* noop */ }
  }
  dedupe.clear();
  return { ok: true, mensaje: 'Cursores N3 reiniciados; el próximo ciclo se ancla en el último cambio.' };
}

/**
 * Ejecuta una sincronización puntual bajo el límite de concurrencia del Nivel 3.
 * Es lo que invoca el worker de cola.
 */
export async function procesarCambioConLimite(payload, deps = {}) {
  if (enVuelo >= MAX_CONCURRENTES) {
    const err = new Error('Nivel 3 ocupado: reprogramar');
    err.reintentable = true;
    throw err;
  }
  enVuelo++;
  try {
    const r = await procesarCambioVtiger(payload, deps);
    if (r?.reintentable) {
      const err = new Error(r.motivo || 'reintentar');
      err.reintentable = true;
      throw err;
    }
    return r;
  } finally {
    enVuelo--;
  }
}
