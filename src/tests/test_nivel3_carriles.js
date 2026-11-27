/**
 * TEST — NIVEL 2 EN DOS CARRILES + NIVEL 3 REACTIVO
 *
 * Valida, SIN RED, las reglas nuevas de la arquitectura:
 *   · el carril histórico (N2A) gana el turno sobre reconciliación (N2B);
 *   · un carril no se solapa consigo mismo;
 *   · la idempotencia del Nivel 3 (sede:id:modifiedtime) evita reprocesar;
 *   · sin cuota el cambio NO se pierde: se reintenta;
 *   · el tail del Nivel 3 se ancla en el presente y luego avanza el cursor.
 */
import { tomarTurno, liberarTurno, getCicloOperativo, reiniciarCicloOperativo, CARRILES } from '../services/ciclo_operativo.js';
import { getEstadoCarriles, CARRILES as CARRILES_N2 } from '../services/nivel2_carriles.js';
import {
  claveIdempotencia, decidirSincronizacion, procesarCambioVtiger, runNivel3Tail, runNivel3OrderTail, fechaVtigerMs
} from '../services/nivel3_reactive_sync.js';

let pasadas = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg); pasadas++; };

console.log('[TEST] Carriles N2 + Nivel 3 reactivo…');

// ---------------------------------------------------------------------------
// 1. CARRILES DEL NIVEL 2
// ---------------------------------------------------------------------------
reiniciarCicloOperativo();

assert(tomarTurno('backfill-compradores', CARRILES.HISTORICO) === true, 'El carril A arranca si está libre');
assert(tomarTurno('refill-comercial', CARRILES.RECONCILIACION) === false, 'Si A corre, B espera (A tiene prioridad)');
assert(tomarTurno('backfill-compradores', CARRILES.HISTORICO) === false, 'El mismo carril no admite dos tareas');
assert(getCicloOperativo().carriles.N2A.tarea === 'backfill-compradores', 'El estado refleja la tarea activa de A');

liberarTurno('backfill-compradores');
assert(tomarTurno('refill-comercial', CARRILES.RECONCILIACION) === true, 'Al liberar A, B arranca');
assert(tomarTurno('backfill-compradores', CARRILES.HISTORICO) === false, 'Mientras B corre, A espera su lote corto');
assert(tomarTurno('curador-estandar', CARRILES.RECONCILIACION) === false, 'B tampoco se solapa consigo mismo');

liberarTurno('refill-comercial');
assert(tomarTurno('backfill-compradores', CARRILES.HISTORICO) === true, 'Liberado B, A vuelve a arrancar');
liberarTurno('backfill-compradores');

const estadoCarriles = getEstadoCarriles();
assert(estadoCarriles.carriles.N2A && estadoCarriles.carriles.N2B, 'Se reportan los dos carriles');
assert(estadoCarriles.carriles.N2A.cuotaRelativaPct + estadoCarriles.carriles.N2B.cuotaRelativaPct === 100, 'El reparto de cuota relativa suma 100%');
assert(estadoCarriles.carriles.N2A.cuotaRelativaPct > estadoCarriles.carriles.N2B.cuotaRelativaPct, 'El histórico tiene mayor participación que la reconciliación');

// ---------------------------------------------------------------------------
// 2. CLAVE DE IDEMPOTENCIA
// ---------------------------------------------------------------------------
const k1 = claveIdempotencia('PALACIOS', '12x2473710', '2026-11-27 10:00:00');
assert(k1 === 'PALACIOS:12x2473710:2026-11-27 10:00:00', 'La clave es sede:id:modifiedtime');
assert(k1 === claveIdempotencia('palacios', ' 12x2473710 ', '2026-11-27 10:00:00'), 'Normaliza sede (mayúsculas) y espacios');
assert(k1 !== claveIdempotencia('PALACIOS', '12x2473710', '2026-11-27 10:00:01'), 'Un modifiedtime distinto es un cambio distinto');

// ---------------------------------------------------------------------------
// 3. DECISIÓN PURA
// ---------------------------------------------------------------------------
assert(decidirSincronizacion({ yaProcesado: true, hayCuota: true, existeRegistro: true, enCooldown: false }).accion === 'saltar', 'Ya procesado → saltar');
assert(decidirSincronizacion({ yaProcesado: false, hayCuota: true, existeRegistro: true, enCooldown: true }).accion === 'saltar', 'En cooldown → saltar');
assert(decidirSincronizacion({ yaProcesado: false, hayCuota: true, existeRegistro: false, enCooldown: false }).accion === 'saltar', 'Sin registro → saltar');
assert(decidirSincronizacion({ yaProcesado: false, hayCuota: false, existeRegistro: true, enCooldown: false }).accion === 'reintentar', 'Sin cuota → reintentar (no se pierde)');
assert(decidirSincronizacion({ yaProcesado: false, hayCuota: true, existeRegistro: true, enCooldown: false }).accion === 'sincronizar', 'Cambio nuevo con cuota → sincronizar');

// ---------------------------------------------------------------------------
// 4. PROCESAR UN CAMBIO (dependencias inyectadas, sin red)
// ---------------------------------------------------------------------------
let sincronizaciones = 0;
const registroFalso = { id: '12x1', homephone: '9802519139', cf_3451: 'PALACIOS', spl_num_compras: '2' };
const depsBase = {
  query: async () => [registroFalso],
  sincronizar: async () => { sincronizaciones++; return { ok: true }; },
  hayCuota: () => true,
  enCooldown: () => false,
  cooldownMs: 0   // sin cooldown local: se prueba la idempotencia, no el enfriamiento
};

const primero = await procesarCambioVtiger({ id: '12x1', sede: 'PALACIOS', modifiedtime: '2026-11-27 10:00:00' }, depsBase);
assert(primero.ok && primero.accion === 'sincronizar', 'El primer cambio se sincroniza');
assert(sincronizaciones === 1, 'Se llamó una vez al sincronizador');

const repetido = await procesarCambioVtiger({ id: '12x1', sede: 'PALACIOS', modifiedtime: '2026-11-27 10:00:00' }, depsBase);
assert(repetido.accion === 'saltar' && repetido.motivo.includes('idempotencia'), 'El mismo cambio no se reprocesa');
assert(sincronizaciones === 1, 'El sincronizador NO se volvió a llamar');

const otroCambio = await procesarCambioVtiger({ id: '12x1', sede: 'PALACIOS', modifiedtime: '2026-11-27 11:00:00' }, depsBase);
assert(otroCambio.accion === 'sincronizar' && sincronizaciones === 2, 'Un modifiedtime nuevo sí se sincroniza');

const sinCuota = await procesarCambioVtiger(
  { id: '12x2', sede: 'BENAVIDES', modifiedtime: '2026-11-27 10:00:00' },
  { ...depsBase, hayCuota: () => false }
);
assert(sinCuota.accion === 'reintentar' && sinCuota.reintentable === true, 'Sin cuota devuelve reintentable');

const noExiste = await procesarCambioVtiger(
  { id: '12x3', sede: 'PIURA', modifiedtime: '2026-11-27 10:00:00' },
  { ...depsBase, query: async () => [] }
);
assert(noExiste.accion === 'saltar' && noExiste.ok === true, 'Un id inexistente en la sede no rompe');

const sedeInvalida = await procesarCambioVtiger({ id: '12x4', sede: 'LIMA', modifiedtime: 'x' }, depsBase);
assert(sedeInvalida.accion === 'saltar', 'Una sede fuera de la allow-list se rechaza');

const enCooldown = await procesarCambioVtiger(
  { id: '12x5', sede: 'ROOSEVELT', modifiedtime: '2026-11-27 10:00:00' },
  { ...depsBase, enCooldown: () => true }
);
assert(enCooldown.accion === 'saltar', 'Si el motor reactivo ya lo hizo, N3 no repite');

// ---------------------------------------------------------------------------
// 5. TAIL: ancla y avance de cursor
// ---------------------------------------------------------------------------
const cursores = new Map();
let encoladosTail = [];
const limaHace = (min) => new Date(Date.now() - 5 * 3600 * 1000 - min * 60000).toISOString().slice(0, 19).replace('T', ' ');

const ancla = await runNivel3Tail({
  sedes: ['PALACIOS'],
  deps: {
    query: async (q) => (q.includes('modifiedtime DESC') ? [{ modifiedtime: '2026-11-27 09:00:00' }] : []),
    encolar: async (p) => { encoladosTail.push(p); },
    cuotaDisponible: () => true,
    leerCursorDe: async (s) => cursores.get(s) || null,
    guardarCursorDe: async (s, v) => { cursores.set(s, v); }
  }
});
assert(ancla.inicializadas.some(i => i.sede === 'PALACIOS'), 'La primera vez se ancla en el último cambio');
assert(ancla.encolados === 0, 'El ancla no encola histórico (eso es N2)');

const avance = await runNivel3Tail({
  sedes: ['PALACIOS'],
  deps: {
    // Cambios "de hace minutos" en hora Lima: así el control de atraso no salta y
    // la prueba no depende de la hora a la que se ejecute.
    query: async () => [
      { id: '12x9', modifiedtime: limaHace(6) },
      { id: '12x10', modifiedtime: limaHace(5) }
    ],
    encolar: async (p) => { encoladosTail.push(p); },
    cuotaDisponible: () => true,
    leerCursorDe: async (s) => cursores.get(s) || null,
    guardarCursorDe: async (s, v) => { cursores.set(s, v); }
  }
});
assert(avance.encolados === 2, 'Encola los cambios nuevos');
assert(encoladosTail.length === 2 && encoladosTail[0].sede === 'PALACIOS', 'Cada job lleva su sede');
assert(cursores.get('PALACIOS') === limaHace(5), 'El cursor avanza al último cambio leído');

const sinCuotaTail = await runNivel3Tail({
  sedes: ['BENAVIDES'],
  deps: {
    query: async () => [],
    encolar: async () => { throw new Error('no debería encolar'); },
    cuotaDisponible: () => false,
    leerCursorDe: async () => '2026-11-27 09:00:00',
    guardarCursorDe: async () => {}
  }
});
assert(sinCuotaTail.sinCuota.includes('BENAVIDES') && sinCuotaTail.encolados === 0, 'Sin cuota no encola y lo reporta');

assert(CARRILES_N2.HISTORICO.id === 'N2A' && CARRILES_N2.RECONCILIACION.id === 'N2B', 'Los identificadores de carril son estables');
assert(CARRILES_N2.HISTORICO.id === CARRILES.HISTORICO, 'El descriptor de carril y el ciclo operativo usan el MISMO id (N2A)');

// ---------------------------------------------------------------------------
// 6. FECHAS DE vTIGER Y SALTO POR ATRASO
// ---------------------------------------------------------------------------
// vTiger guarda 'YYYY-MM-DD HH:MM:SS' en hora de Lima (UTC-5).
assert(fechaVtigerMs('2026-11-27 10:00:00') === Date.UTC(2026, 10, 27, 15, 0, 0), 'La fecha de vTiger se interpreta como Lima (UTC-5)');
assert(fechaVtigerMs('') === 0 && fechaVtigerMs(null) === 0, 'Una fecha vacía no rompe');

const saltos = [];
const salto = await runNivel3Tail({
  sedes: ['ROOSEVELT'],
  deps: {
    query: async (q) => {
      if (q.includes('ORDER BY modifiedtime DESC LIMIT 1')) return [{ modifiedtime: '2026-11-27 15:00:00' }];
      if (q.includes('ORDER BY modifiedtime ASC')) return [{ id: '12x99', modifiedtime: '2026-11-27 08:00:00' }]; // atraso > 45 min
      return [];
    },
    encolar: async (p) => { saltos.push(p); },
    cuotaDisponible: () => true,
    leerCursorDe: async () => '2026-11-27 07:00:00',
    guardarCursorDe: async () => {}
  }
});
assert(salto.saltos.some(s => s.sede === 'ROOSEVELT'), 'Con atraso excesivo el carril salta al presente');
assert(salto.encolados === 0 && saltos.length === 0, 'Al saltar no se encola el backlog (eso es N2A)');

// ---------------------------------------------------------------------------
// 7. TAIL DE ÓRDENES DE VENTA (reactividad a nivel de venta)
// ---------------------------------------------------------------------------
// Hora de Lima "de hace 5 minutos" para que el control de atraso no salte.
const hace5 = new Date(Date.now() - 5 * 3600 * 1000 - 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

let cursorOrdenes = null;
const encoladosOrden = [];

const anclaOrdenes = await runNivel3OrderTail({
  deps: {
    query: async (q) => (q.includes('FROM SalesOrder') && q.includes('DESC LIMIT 1') ? [{ modifiedtime: hace5 }] : []),
    encolar: async (p) => { encoladosOrden.push(p); },
    cuotaDisponible: () => true,
    leerCursorOrdenesDe: async () => cursorOrdenes,
    guardarCursorOrdenesDe: async (v) => { cursorOrdenes = v; }
  }
});
assert(anclaOrdenes.ancla === hace5, 'La primera vez el carril de órdenes se ancla en la última venta');
assert(anclaOrdenes.encolados === 0, 'El ancla no encola ventas históricas');

cursorOrdenes = '2026-01-01 00:00:00';
const ordenesLote = await runNivel3OrderTail({
  deps: {
    query: async (q) => {
      if (q.includes('FROM SalesOrder') && q.includes('ASC')) {
        return [
          { id: 'O1', contact_id: 'C1', modifiedtime: hace5 },
          { id: 'O2', contact_id: 'C2', modifiedtime: hace5 },
          { id: 'O3', contact_id: '', modifiedtime: hace5 }
        ];
      }
      if (q.includes('FROM Contacts WHERE id =')) {
        return [{ id: 'C1', cf_3451: 'PALACIOS' }, { id: 'C2', cf_3451: 'LIMA' }];
      }
      return [];
    },
    encolar: async (p) => { encoladosOrden.push(p); },
    cuotaDisponible: () => true,
    leerCursorOrdenesDe: async () => cursorOrdenes,
    guardarCursorOrdenesDe: async (v) => { cursorOrdenes = v; }
  }
});
assert(ordenesLote.ordenes === 3, 'Se leen las 3 órdenes del lote');
assert(ordenesLote.encolados === 1, 'Solo se encola la orden de una sede válida');
assert(encoladosOrden.length === 1 && encoladosOrden[0].sede === 'PALACIOS' && encoladosOrden[0].motivo === 'orden', 'El job lleva la sede del CONTACTO y el motivo "orden"');
assert(ordenesLote.sinSede === 1 && ordenesLote.sinContacto === 1, 'Se descartan la orden sin sede válida y la orden sin contacto');
assert(cursorOrdenes === hace5, 'El cursor de órdenes avanza al último modifiedtime leído');

console.log(`[SUCCESS] ${pasadas} aserciones de carriles N2 + Nivel 3 validadas al 100%.`);
