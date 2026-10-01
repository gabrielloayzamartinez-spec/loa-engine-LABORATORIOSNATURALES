/**
 * ==============================================================================
 * LOA ENGINE - BACKFILL DE COMPRADORES vTiger -> GHL (reanudable)
 * ==============================================================================
 * POR QUÉ EXISTE:
 * El puente de ventas (`vtiger_sales_bridge`) barre por `modifiedtime` y está
 * TOPADO en 25 contactos por sede y por ciclo. Como no lleva memoria, cada ciclo
 * vuelve a tomar los MISMOS 25 más recientes: si ya estaban sincronizados, el
 * ciclo no aporta nada y el resto de la cartera (miles de compradores) nunca se
 * alcanza. Eso se veía como "no se actualiza en vivo".
 *
 * Este módulo recorre la cartera COMPLETA de compradores con un cursor
 * persistente, de modo que cada ejecución avanza y el progreso sobrevive a un
 * redeploy. Es el mismo patrón ya probado en el historial de órdenes.
 *
 * REGLAS QUE RESPETA:
 *  - SÓLO COMPRADORES (`spl_num_compras > 0`). Los leads no se mudan.
 *  - Teléfono válido obligatorio (validación NANP estricta): es la llave de fusión.
 *  - Sede-Lock: cada consulta va acotada por `cf_3451`.
 *  - Destino: subcuenta de la sede + Cuenta Empresa (si está configurada).
 * ==============================================================================
 */

import { queryVTiger } from './vtiger_api_service.js';
import { sedeClause, VTIGER_CONTACT_SELECT, VTIGER_SEDES_VALIDAS, VTIGER_FIELDS } from './vtigerClient.js';
import { sanitizeForVtigerQuery } from '../utils/sanitize.js';
import { getActiveSedes } from '../config/index.js';
import { syncVtigerContactDual, pickPhone } from './dual_sync_service.js';
import { recordAuditEvent } from './audit_logger.js';
import { getStateStore } from './state/state_store.js';

const backfillStore = getStateStore('buyers_backfill');
const CURSOR_KEY = 'cursor_v1';

/** Estado del backfill de compradores (para /api/health y diagnóstico). */
export async function getBuyersBackfillStatus() {
  const estado = await backfillStore.get(CURSOR_KEY, null);
  return estado || {
    completo: false,
    porSede: {},
    ultimaEjecucion: null,
    totales: { contactos: 0, creados: 0, actualizados: 0, descartados: 0, fallidos: 0 }
  };
}

/** Reinicia el cursor para volver a recorrer toda la cartera desde cero. */
export async function resetBuyersBackfill() {
  await backfillStore.set(CURSOR_KEY, {
    completo: false,
    porSede: {},
    ultimaEjecucion: null,
    totales: { contactos: 0, creados: 0, actualizados: 0, descartados: 0, fallidos: 0 }
  });
  console.log('[Buyers Backfill] [RESET] Cursor reiniciado.');
}

/**
 * Ejecuta un lote de backfill de compradores.
 *
 * @param {object} opts
 * @param {number} [opts.tamanoLote=50] contactos por sede y por lote
 * @param {number} [opts.maxLotes=1]    lotes a procesar en esta ejecución
 * @param {number} [opts.pausaMs=300]   respiro entre contactos (rate limit GHL)
 * @param {string[]} [opts.sedes]       sedes a procesar (por defecto las activas)
 * @returns {Promise<object>} resumen acumulado de la ejecución
 */
export async function runBuyersBackfill({
  tamanoLote = 50,
  maxLotes = 1,
  pausaMs = 300,
  sedes = null
} = {}) {
  const sedesObjetivo = (sedes && sedes.length ? sedes : getActiveSedes().map(s => s.sedeId))
    .map(s => String(s).toUpperCase())
    .filter(s => VTIGER_SEDES_VALIDAS.includes(s));

  if (sedesObjetivo.length === 0) {
    console.warn('[Buyers Backfill] [SKIP] No hay sedes activas configuradas.');
    return { ok: false, reason: 'sin sedes activas' };
  }

  const estado = await getBuyersBackfillStatus();
  const inicio = Date.now();
  const resumen = { lotes: 0, contactos: 0, creados: 0, actualizados: 0, descartados: 0, fallidos: 0, porSede: {} };
  const limite = Math.min(Math.max(parseInt(tamanoLote, 10) || 50, 1), 150);

  for (let lote = 0; lote < Math.min(Math.max(parseInt(maxLotes, 10) || 1, 1), 20); lote++) {
    let procesadosEnLote = 0;

    for (const sede of sedesObjetivo) {
      const cursorSede = estado.porSede?.[sede] || {};
      const ultimoId = cursorSede.ultimoId || null;
      const offset = cursorSede.offset || 0;

      // ======================================================================
      // [DEFECTO CRITICO CORREGIDO] PAGINACION POR KEYSET, NO POR OFFSET.
      //
      // ANTES: `ORDER BY id LIMIT ${offset}, ${limite}`.
      // vTiger NO soporta bien el OFFSET grande: para devolver la pagina tiene que
      // recorrer y DESCARTAR todas las filas anteriores. Con 36.629 compradores en
      // Palacios, los offsets profundos superaban el timeout de 12 s
      // (`VTIGER_TIMEOUT_MS`) y la consulta abortaba con "This operation was
      // aborted" tras agotar los 3 intentos. Se registraron 8 fallos criticos
      // VTIGER_QUERY_FAILED -- justo cuando el backfill avanzaba hacia el fondo de
      // la cartera, que es cuando el offset es mas grande.
      //
      // AHORA: `WHERE id > ultimoId ORDER BY id LIMIT n`. Con un rango sobre `id`
      // el motor salta directo por el indice y el costo es CONSTANTE sin importar
      // la profundidad del recorrido. Es el mismo numero de filas en cada pagina,
      // pero sin escanear lo ya recorrido.
      //
      // El cursor guarda `ultimoId` (clave estable) en lugar de solo el conteo.
      // Compatibilidad: si el cursor viejo no tiene `ultimoId`, se hace UNA pagina
      // por offset para no perder el avance y se migra al nuevo formato.
      // ======================================================================
      const filtroCursor = ultimoId
        ? ` AND id > '${sanitizeForVtigerQuery(String(ultimoId), 20)}'`
        : '';
      const paginacion = ultimoId ? '' : `${offset}, `;
      const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.NUM_COMPRAS} > 0${sedeClause(sede)}${filtroCursor} ORDER BY id LIMIT ${paginacion}${limite};`;

      let contactos = [];
      try {
        // TIMEOUT AMPLIADO PARA EL RECORRIDO MASIVO.
        // Se registraron 8 fallos criticos VTIGER_QUERY_FAILED ("This operation was
        // aborted") en 42 segundos: vTiger respondio lento de forma transitoria y
        // los 3 intentos de 12 s no alcanzaron. El backfill avanza por cursor, asi
        // que una respuesta lenta NO debe abortar el trabajo: puede esperar mas.
        // Con 30 s por intento x 5 intentos hay margen real para una lentitud pasajera.
        contactos = await queryVTiger(q, sede, { timeoutMs: 30000, maxAttempts: 5 });
      } catch (err) {
        console.error(`[Buyers Backfill] [ERROR] Consulta fallida en ${sede}: ${err.message}`);
        recordAuditEvent({
          type: 'BUYERS_BACKFILL_QUERY_FAILED',
          severity: 'error',
          sede,
          message: err.message,
          // El cursor permite saber en que punto del recorrido fallo: con keyset
          // un fallo NO depende de la profundidad, asi que si ocurre aqui es otra
          // causa (red, sesion, carga del servidor).
          ultimoId: ultimoId || null,
          offset
        });
        resumen.fallidos++;
        continue;
      }

      if (contactos.length === 0) {
        estado.porSede[sede] = { ...cursorSede, offset, completo: true, ultimaEjecucion: new Date().toISOString() };
        console.log(`[Buyers Backfill] [${sede}] Cartera completada (ultimoId ${ultimoId || 'inicio'}).`);
        continue;
      }

      const conteoSede = { sede, leidos: contactos.length, creados: 0, actualizados: 0, descartados: 0, fallidos: 0 };

      for (const vContact of contactos) {
        try {
          const r = await syncVtigerContactDual(vContact);
          resumen.contactos++;
          if (r.skipped) { resumen.descartados++; conteoSede.descartados++; }
          else if (r.ok) {
            if (r.created) { resumen.creados++; conteoSede.creados++; }
            else { resumen.actualizados++; conteoSede.actualizados++; }
          } else { resumen.fallidos++; conteoSede.fallidos++; }
        } catch (err) {
          resumen.fallidos++;
          conteoSede.fallidos++;
          recordAuditEvent({ type: 'BUYERS_BACKFILL_CONTACT_FAIL', severity: 'warn', sede, vTigerId: vContact?.id, message: err.message });
        }
        if (pausaMs > 0) await new Promise(res => setTimeout(res, pausaMs));
      }

      // El cursor avanza por `id` (keyset): se guarda el ULTIMO id leido para que
      // la proxima pagina pida `id > ultimoId`. `offset` se conserva solo como
      // referencia informativa y para migrar cursores del formato anterior.
      const nuevoUltimoId = contactos[contactos.length - 1]?.id || ultimoId;
      estado.porSede[sede] = {
        ultimoId: nuevoUltimoId,
        offset: offset + contactos.length,
        ultimaEjecucion: new Date().toISOString(),
        ultimoLote: contactos.length,
        completo: contactos.length < limite
      };
      procesadosEnLote += contactos.length;
      resumen.porSede[sede] = conteoSede;
      console.log(`[Buyers Backfill] [${sede}] ${JSON.stringify(conteoSede)} (cursor id -> ${nuevoUltimoId}, total leidos ${offset + contactos.length})`);
    }

    resumen.lotes++;

    // El cursor se persiste tras CADA lote: un redeploy no reinicia el trabajo.
    estado.ultimaEjecucion = new Date().toISOString();
    estado.totales = {
      contactos: (estado.totales?.contactos || 0) + resumen.contactos,
      creados: (estado.totales?.creados || 0) + resumen.creados,
      actualizados: (estado.totales?.actualizados || 0) + resumen.actualizados,
      descartados: (estado.totales?.descartados || 0) + resumen.descartados,
      fallidos: (estado.totales?.fallidos || 0) + resumen.fallidos
    };
    estado.completo = sedesObjetivo.every(s => estado.porSede?.[s]?.completo);
    await backfillStore.set(CURSOR_KEY, estado);

    if (procesadosEnLote === 0) break; // nada más que recorrer
  }

  resumen.ms = Date.now() - inicio;
  resumen.completo = estado.completo;
  recordAuditEvent({ type: 'BUYERS_BACKFILL_CYCLE', severity: resumen.fallidos > 0 ? 'warn' : 'info', ...resumen });
  console.log(`[Buyers Backfill] [DONE] ${JSON.stringify({ ...resumen, porSede: undefined })}`);
  return resumen;
}
