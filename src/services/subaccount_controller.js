/**
 * ==============================================================================
 * CONTROL POR SUBCUENTA — 4 PROCESOS INDEPENDIENTES, 4 CUOTAS INDEPENDIENTES
 * ==============================================================================
 * PEDIDO (27/11/2026): "procesos independientes, cada uno sujeto al consumo de su
 * propia subcuenta en GHL, controlando el trabajo de vTiger, con efectividad del
 * 100% por éxito de cada contacto y en el total de las subcuentas".
 *
 * PROBLEMA QUE RESUELVE
 * Antes había UN bucle global que recorría las 4 sedes en serie: si Palacios se
 * quedaba sin cuota o una llamada se colgaba, las otras tres esperaban. Además no
 * existía una contabilidad por CONTACTO: se sabía cuántos lotes corrieron, no si
 * cada ficha terminó bien. Un fallo silencioso se perdía.
 *
 * CÓMO FUNCIONA
 *   · Cada subcuenta tiene SU worker (cola, estado y contadores propios).
 *   · El worker de una sede sólo arranca si SU subcuenta tiene cuota
 *     (`hayCuotaRealDeFondo(sede)`): una sede sin cuota se pausa sola y NO frena a
 *     las demás.
 *   · El trabajo de vTiger está racionado por sede (`VTIGER_LECTURAS_POR_MIN_SEDE`)
 *     además del gate global de 3 consultas concurrentes.
 *   · Cada contacto termina en un estado TERMINAL y queda en el libro:
 *       ok            → se escribió en GHL
 *       sin_cambios   → ya estaba igual (idempotencia = éxito)
 *       omitido       → no se puede/puede no aplicarse (sin teléfono, no existe,
 *                        no es comprador, cooldown) con su motivo
 *       fallido       → error tras agotar reintentos → va a la lista de fallidos
 *   · EFECTIVIDAD = escrituras confirmadas / contactos que debían escribirse.
 *     100% = no hay fallidos ni pendientes.
 *
 * NO ESCRIBE EN vTIGER: sólo lee (Sede-Lock en cada consulta).
 * ==============================================================================
 */

import { syncVtigerContactDual } from './dual_sync_service.js';
import { getRepartoCuota, getCuotaRealEstado, hayCuotaRealDeFondo } from '../utils/ghl_http_client.js';
import { VTIGER_SEDES_VALIDAS } from './vtigerClient.js';
import { getStateStore } from './state/state_store.js';
import { recordAuditEvent } from './audit_logger.js';
import { envInt } from '../config/secrets.js';

const store = getStateStore('control_subcuenta');

const MAX_INTENTOS = Math.min(Math.max(envInt('CONTROL_MAX_INTENTOS', 3), 1), 5);
const MAX_COLA = Math.min(Math.max(envInt('CONTROL_MAX_COLA', 5000), 100), 50000);
const PAUSA_POR_CUOTA_MS = 60 * 1000;
const LECTURAS_VTIGER_POR_MIN = Math.min(Math.max(envInt('VTIGER_LECTURAS_POR_MIN_SEDE', 60), 5), 600);
const PAUSA_ENTRE_TAREAS_MS = Math.min(Math.max(envInt('CONTROL_PAUSA_MS', 150), 0), 5000);

/** Estados terminales del libro de contactos. */
export const RESULTADOS = {
  OK: 'ok',
  SIN_CAMBIOS: 'sin_cambios',
  OMITIDO: 'omitido',
  FALLIDO: 'fallido'
};

function registroInicial() {
  return {
    cola: [],
    procesando: false,
    pausadoHasta: 0,
    motivoPausa: null,
    lecturasVtiger: [],
    // [LIBRO POR CONTACTO] La efectividad se mide sobre el ÚLTIMO estado de cada
    // contacto, no sobre intentos: un contacto que falla y luego se recupera cuenta
    // como éxito (es la definición de "éxito por contacto").
    contactos: new Map(), // vtigerId -> { estado, motivo, ts }
    stats: {
      encolados: 0,
      intentos: 0,
      reintentos: 0,
      contactosOk: 0,
      contactosSinCambios: 0,
      contactosOmitidos: 0,
      contactosFallidos: 0,
      omitidosPorMotivo: {},
      ultimoOk: null,
      ultimoError: null,
      ultimaTarea: null
    },
    fallidos: [],
    desde: new Date().toISOString()
  };
}

/** Estado en memoria por sede (una por subcuenta; nunca se mezclan). */
const sedes = new Map();
let timers = [];

function estadoDe(sede) {
  const id = String(sede || '').toUpperCase();
  if (!sedes.has(id)) sedes.set(id, registroInicial());
  return sedes.get(id);
}

// ------------------------------------------------------------------------------
// PERSISTENCIA (sobrevive al reinicio; el archivo se escribe con throttle)
// ------------------------------------------------------------------------------
const ultimoGuardado = new Map();

async function persistir(sede, forzar = false) {
  const id = String(sede).toUpperCase();
  const ahora = Date.now();
  if (!forzar && (ahora - (ultimoGuardado.get(id) || 0)) < 20000) return;
  ultimoGuardado.set(id, ahora);
  const s = estadoDe(id);
  try {
    await store.set(`stats:${id}`, { stats: s.stats, desde: s.desde });
  } catch { /* la contabilidad en memoria sigue viva */ }
}

/** Rehidrata los contadores guardados (el libro no se reinicia en cada deploy). */
export async function hidratarControl() {
  for (const sede of VTIGER_SEDES_VALIDAS) {
    try {
      const g = await store.get(`stats:${sede}`, null);
      if (g?.stats) {
        const s = estadoDe(sede);
        s.stats = { ...s.stats, ...g.stats };
        s.desde = g.desde || s.desde;
      }
    } catch { /* sin estado previo */ }
  }
}

// ------------------------------------------------------------------------------
// COLA POR SUBCUENTA
// ------------------------------------------------------------------------------
/**
 * Encola un contacto para sincronizar en SU subcuenta.
 *
 * @param {object} p
 * @param {string} p.sede        PALACIOS | BENAVIDES | ROOSEVELT | PIURA
 * @param {string} p.vtigerId    id del contacto en vTiger
 * @param {string} [p.modifiedtime]
 * @param {number} [p.prioridad=2] 1 = alta (reactivo), 2 = normal
 * @param {string} [p.origen='manual']
 * @returns {Promise<{ok:boolean, motivo?:string, enCola?:number}>}
 */
export async function encolarContacto({ sede, vtigerId, modifiedtime = '', prioridad = 2, origen = 'manual', estadoPrevio = null } = {}) {
  const id = String(sede || '').toUpperCase();
  if (!VTIGER_SEDES_VALIDAS.includes(id)) return { ok: false, motivo: 'sede inválida' };
  if (!vtigerId) return { ok: false, motivo: 'falta vtigerId' };

  const s = estadoDe(id);
  if (s.cola.length >= MAX_COLA) {
    recordAuditEvent({ type: 'CONTROL_COLA_LLENA', severity: 'warn', sede: id, enCola: s.cola.length, tope: MAX_COLA });
    return { ok: false, motivo: 'cola llena' };
  }

  s.cola.push({
    vtigerId: String(vtigerId),
    modifiedtime: String(modifiedtime || ''),
    prioridad: Number(prioridad) === 1 ? 1 : 2,
    origen,
    intentos: 0,
    estadoPrevio,
    encoladoEn: Date.now()
  });
  // Prioridad 1 al frente (reactivo), 2 al final (histórico).
  if (Number(prioridad) === 1 && s.cola.length > 1) {
    s.cola.sort((a, b) => a.prioridad - b.prioridad);
  }
  s.stats.encolados++;
  return { ok: true, enCola: s.cola.length };
}

// ------------------------------------------------------------------------------
// RACIÓN DE VTIGER POR SEDE
// ------------------------------------------------------------------------------
function puedeLeerVtiger(sede) {
  const s = estadoDe(sede);
  const corte = Date.now() - 60000;
  s.lecturasVtiger = s.lecturasVtiger.filter(t => t > corte);
  if (s.lecturasVtiger.length >= LECTURAS_VTIGER_POR_MIN) return false;
  s.lecturasVtiger.push(Date.now());
  return true;
}

// ------------------------------------------------------------------------------
// CLASIFICACIÓN DEL RESULTADO (pura, testeable)
// ------------------------------------------------------------------------------
/**
 * Traduce la respuesta de `procesarCambioVtiger`/`syncVtigerContactDual` a un
 * estado terminal del libro.
 *
 * @param {object} r
 * @returns {{estado:string, motivo?:string}}
 */
export function clasificarResultado(r = {}) {
  if (!r) return { estado: RESULTADOS.FALLIDO, motivo: 'sin respuesta' };

  // Error de red/escritura: se reintenta; si se agotan, fallido.
  if (r.ok === false && r.reintentable) return { estado: RESULTADOS.FALLIDO, motivo: r.motivo || 'reintentable agotado' };
  if (r.ok === false) {
    const m = String(r.motivo || r.reason || '').toLowerCase();
    if (m.includes('no existe') || m.includes('sin tel') || m.includes('no es comprador') || m.includes('cooldown')) {
      return { estado: RESULTADOS.OMITIDO, motivo: r.motivo || r.reason };
    }
    return { estado: RESULTADOS.FALLIDO, motivo: r.motivo || r.reason || 'error' };
  }

  if (r.accion === 'saltar') return { estado: RESULTADOS.OMITIDO, motivo: r.motivo || 'omitido' };

  const res = r.resultado || {};
  if (res.skipped) {
    const m = String(res.reason || res.motivo || '').toLowerCase();
    if (m.includes('no_changes') || m.includes('no changes') || m.includes('sin cambios')) {
      return { estado: RESULTADOS.SIN_CAMBIOS, motivo: 'sin cambios' };
    }
    return { estado: RESULTADOS.OMITIDO, motivo: res.reason || res.motivo || 'omitido por el sincronizador' };
  }
  if (res.ok === false) return { estado: RESULTADOS.FALLIDO, motivo: res.error || res.reason || 'sin éxito' };

  return { estado: RESULTADOS.OK, motivo: null };
}

// ------------------------------------------------------------------------------
// LIBRO DE CONTACTOS (último estado por contacto)
// ------------------------------------------------------------------------------
const CAMPO_POR_ESTADO = {
  [RESULTADOS.OK]: 'contactosOk',
  [RESULTADOS.SIN_CAMBIOS]: 'contactosSinCambios',
  [RESULTADOS.OMITIDO]: 'contactosOmitidos',
  [RESULTADOS.FALLIDO]: 'contactosFallidos'
};

function anotar(sede, tarea, clasificado) {
  const s = estadoDe(sede);
  s.stats.intentos++;
  s.stats.ultimaTarea = { vtigerId: tarea.vtigerId, estado: clasificado.estado, ts: new Date().toISOString() };

  // Se retira el estado ANTERIOR del contacto (si lo tenía) y se anota el nuevo.
  // Sin esto, un contacto que falla y luego se recupera quedaría contado dos veces y
  // la efectividad nunca llegaría al 100%.
  const previo = s.contactos.get(tarea.vtigerId)?.estado || tarea.estadoPrevio || null;
  if (previo && CAMPO_POR_ESTADO[previo]) {
    s.stats[CAMPO_POR_ESTADO[previo]] = Math.max(0, s.stats[CAMPO_POR_ESTADO[previo]] - 1);
  }

  s.contactos.set(tarea.vtigerId, { estado: clasificado.estado, motivo: clasificado.motivo, ts: Date.now() });
  s.stats[CAMPO_POR_ESTADO[clasificado.estado]]++;

  // Poda del libro (memoria acotada): se descartan los estados más viejos.
  if (s.contactos.size > 60000) {
    const sobran = s.contactos.size - 60000;
    let i = 0;
    for (const k of s.contactos.keys()) { if (i++ >= sobran) break; s.contactos.delete(k); }
  }

  if (clasificado.estado === RESULTADOS.OK) {
    s.stats.ultimoOk = new Date().toISOString();
  } else if (clasificado.estado === RESULTADOS.OMITIDO) {
    const clave = String(clasificado.motivo || 'otro').slice(0, 60);
    s.stats.omitidosPorMotivo[clave] = (s.stats.omitidosPorMotivo[clave] || 0) + 1;
  } else if (clasificado.estado === RESULTADOS.FALLIDO) {
    s.stats.ultimoError = clasificado.motivo || 'error';
    s.fallidos.push({
      vtigerId: tarea.vtigerId,
      modifiedtime: tarea.modifiedtime,
      motivo: clasificado.motivo,
      intentos: tarea.intentos,
      ts: new Date().toISOString()
    });
    if (s.fallidos.length > 2000) s.fallidos.splice(0, s.fallidos.length - 2000);
  }
  persistir(sede);
}

// ------------------------------------------------------------------------------
// WORKER INDEPENDIENTE POR SUBCUENTA
// ------------------------------------------------------------------------------
let procesarTarea = null;

/**
 * Inyecta el procesador real (normalmente `procesarCambioVtiger` del Nivel 3).
 * Se inyecta para poder probar el control sin red.
 */
export function setProcesador(fn) {
  procesarTarea = fn;
}

async function ejecutarTarea(sede, tarea) {
  const s = estadoDe(sede);
  tarea.intentos++;

  // [vTIGER] Ración por sede: si ya consumió su cuota de lecturas del minuto, la
  // tarea vuelve al frente y se reintenta en unos segundos (sin perderla).
  if (!puedeLeerVtiger(sede)) {
    s.cola.unshift(tarea);
    setTimeout(() => bombear(sede), 5000);
    return;
  }

  let clasificado;
  try {
    const r = await procesarTarea({ id: tarea.vtigerId, sede, modifiedtime: tarea.modifiedtime, motivo: tarea.origen });
    clasificado = clasificarResultado(r);
  } catch (err) {
    clasificado = { estado: RESULTADOS.FALLIDO, motivo: err.message };
  }

  // Reintento con backoff si es recuperable y quedan intentos.
  const recuperable = clasificado.estado === RESULTADOS.FALLIDO && tarea.intentos < MAX_INTENTOS;
  if (recuperable) {
    s.stats.reintentos++;
    const espera = Math.min(30000, 1000 * Math.pow(2, tarea.intentos - 1));
    s.cola.unshift(tarea);
    setTimeout(() => bombear(sede), espera);
    return;
  }

  anotar(sede, tarea, clasificado);
}

/**
 * Bucle del worker: toma una tarea, la ejecuta y vuelve a bombear.
 * Cada sede tiene el suyo; uno lento no bloquea a los demás.
 */
export async function bombear(sede) {
  const id = String(sede || '').toUpperCase();
  if (!VTIGER_SEDES_VALIDAS.includes(id)) return;
  const s = estadoDe(id);

  if (s.procesando || s.cola.length === 0) return;
  if (Date.now() < s.pausadoHasta) return;

  // [CUOTA DE SU SUBCUENTA] Si esta sede no tiene cuota, se pausa SOLA.
  if (!hayCuotaRealDeFondo(id)) {
    s.pausadoHasta = Date.now() + PAUSA_POR_CUOTA_MS;
    s.motivoPausa = 'sin cuota de fondo en su subcuenta';
    recordAuditEvent({ type: 'CONTROL_SEDE_PAUSADA', severity: 'warn', sede: id, motivo: s.motivoPausa, enCola: s.cola.length });
    return;
  }
  s.motivoPausa = null;

  s.procesando = true;
  const tarea = s.cola.shift();
  try {
    await ejecutarTarea(id, tarea);
  } finally {
    s.procesando = false;
    if (PAUSA_ENTRE_TAREAS_MS > 0) setTimeout(() => bombear(id), PAUSA_ENTRE_TAREAS_MS);
    else setImmediate(() => bombear(id));
  }
}

/** Arranca los 4 workers (uno por subcuenta) y los mantiene vivos. */
export function arrancarControladores({ vigilanciaMs = 15000 } = {}) {
  detenerControladores();
  for (const sede of VTIGER_SEDES_VALIDAS) {
    estadoDe(sede); // crea la estructura aislada
    const t = setInterval(() => bombear(sede), vigilanciaMs);
    timers.push(t);
    bombear(sede);
  }
  return { ok: true, sedes: [...VTIGER_SEDES_VALIDAS] };
}

/** Detiene todos los workers (apagado ordenado / pruebas). */
export function detenerControladores() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

// ------------------------------------------------------------------------------
// MÉTRICAS: EFECTIVIDAD POR SUBCUENTA Y TOTAL
// ------------------------------------------------------------------------------
/**
 * Efectividad de una subcuenta — POR CONTACTO, no por intento.
 *
 * Cada contacto tiene un ÚLTIMO estado. Se consideran "debían escribirse" los que
 * terminaron en ok / sin_cambios / fallido (los omitidos son fichas que no aplican:
 * sin teléfono, inexistentes en vTiger, cooldown…).
 *
 *   efectividad = (ok + sin_cambios) / (ok + sin_cambios + fallidos)
 */
export function efectividadDe(stats) {
  const ok = stats.contactosOk || 0;
  const sinCambios = stats.contactosSinCambios || 0;
  const omitidos = stats.contactosOmitidos || 0;
  const fallidos = stats.contactosFallidos || 0;
  const exitosos = ok + sinCambios;
  const debian = exitosos + fallidos;
  return {
    contactosConocidos: exitosos + fallidos + omitidos,
    exitosos,
    fallidos,
    omitidos,
    debianEscribirse: debian,
    efectividadPct: debian > 0 ? Math.round((exitosos / debian) * 1000) / 10 : null,
    tasaFalloPct: debian > 0 ? Math.round((fallidos / debian) * 1000) / 10 : null,
    intentos: stats.intentos || 0,
    reintentos: stats.reintentos || 0
  };
}

/** Estado de UNA subcuenta (cuota, cola, libro y efectividad). */
export function getEstadoSubcuenta(sede) {
  const id = String(sede || '').toUpperCase();
  const s = estadoDe(id);
  const ef = efectividadDe(s.stats);
  let cuota = null;
  try { cuota = { ...getRepartoCuota(id), ...getCuotaRealEstado(id) }; } catch { cuota = null; }

  return {
    sede: id,
    cola: s.cola.length,
    procesando: s.procesando,
    pausado: Date.now() < s.pausadoHasta,
    pausadoHasta: s.pausadoHasta ? new Date(s.pausadoHasta).toISOString() : null,
    motivoPausa: s.motivoPausa,
    cuota,
    lecturasVtigerUltimoMinuto: s.lecturasVtiger.length,
    topeLecturasVtigerPorMinuto: LECTURAS_VTIGER_POR_MIN,
    libro: { ...s.stats },
    efectividad: ef,
    fallidosPendientes: s.fallidos.length,
    muestraFallidos: s.fallidos.slice(-5),
    desde: s.desde
  };
}

/** Estado consolidado de las 4 subcuentas + efectividad total. */
export function getEstadoGlobal() {
  const porSede = {};
  let exitosos = 0, fallidos = 0, omitidos = 0, enCola = 0, pendientes = 0, intentos = 0;

  for (const sede of VTIGER_SEDES_VALIDAS) {
    const e = getEstadoSubcuenta(sede);
    porSede[sede] = e;
    exitosos += e.efectividad.exitosos;
    fallidos += e.efectividad.fallidos;
    omitidos += e.efectividad.omitidos;
    intentos += e.efectividad.intentos;
    enCola += e.cola;
    pendientes += e.fallidosPendientes;
  }

  const debian = exitosos + fallidos;
  return {
    ok: true,
    sedes: porSede,
    total: {
      exitosos,
      fallidos,
      omitidos,
      intentos,
      debianEscribirse: debian,
      enCola,
      fallidosPendientes: pendientes,
      efectividadPct: debian > 0 ? Math.round((exitosos / debian) * 1000) / 10 : null
    },
    criterio: 'efectividad por CONTACTO = (ok + sin_cambios) / (ok + sin_cambios + fallidos). 100% = ningún contacto fallido ni en cola.',
    objetivos: { efectividadPct: 100, fallidosPendientes: 0, cola: 0 }
  };
}

/** Reencola los contactos fallidos de una sede (o de todas). */
export async function reintentarFallidos(sede = null) {
  const objetivo = sede ? [String(sede).toUpperCase()] : [...VTIGER_SEDES_VALIDAS];
  const resumen = {};
  for (const id of objetivo) {
    const s = estadoDe(id);
    const fallidos = s.fallidos.splice(0, s.fallidos.length);
    for (const f of fallidos) {
      // `estadoPrevio` permite que el libro reste el 'fallido' cuando se recupere.
      await encolarContacto({
        sede: id,
        vtigerId: f.vtigerId,
        modifiedtime: f.modifiedtime,
        prioridad: 1,
        origen: 'reintento-fallidos',
        estadoPrevio: RESULTADOS.FALLIDO
      });
    }
    resumen[id] = fallidos.length;
    bombear(id);
  }
  return { ok: true, reencolados: resumen };
}

/** Pausa/reanuda una sede a mano (sin tocar a las demás). */
export function pausarSede(sede, minutos = 5) {
  const id = String(sede || '').toUpperCase();
  if (!VTIGER_SEDES_VALIDAS.includes(id)) return { ok: false, motivo: 'sede inválida' };
  const s = estadoDe(id);
  s.pausadoHasta = Date.now() + Math.max(1, minutos) * 60000;
  s.motivoPausa = 'pausa manual';
  return { ok: true, sede: id, pausadoHasta: new Date(s.pausadoHasta).toISOString() };
}

export function reanudarSede(sede) {
  const id = String(sede || '').toUpperCase();
  if (!VTIGER_SEDES_VALIDAS.includes(id)) return { ok: false, motivo: 'sede inválida' };
  const s = estadoDe(id);
  s.pausadoHasta = 0;
  s.motivoPausa = null;
  bombear(id);
  return { ok: true, sede: id };
}

/** Reinicia el libro de una sede (pruebas o arranque de un ciclo limpio). */
export function reiniciarLibro(sede = null) {
  const objetivo = sede ? [String(sede).toUpperCase()] : [...VTIGER_SEDES_VALIDAS];
  for (const id of objetivo) {
    if (sedes.has(id)) sedes.set(id, registroInicial());
  }
  return { ok: true, reiniciadas: objetivo };
}
