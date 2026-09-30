/**
 * ==============================================================================
 * LOA ENGINE - SINCRONIZACIÓN DE VENTAS vTiger -> GHL (PUENTE DE ALTA)
 * ==============================================================================
 * POR QUÉ EXISTE ESTE MÓDULO:
 * El Reverse Sync (`runVTigerToGHLPoller`) sólo hacía `PUT` sobre contactos que
 * YA EXISTÍAN en GHL. Diagnóstico en vivo sobre 60 contactos de Palacios:
 *   - 100% tienen teléfono (en `homephone`)
 *   - 57/60 tienen compras registradas
 *   - **0 existen en GHL**
 * Resultado: una venta cerrada en vTiger para un cliente que nunca chateó NO
 * aparecía en GHL. El dato existía y no había forma de verlo.
 *
 * Este módulo cierra ese hueco: barre las ventas recientes de vTiger POR SEDE
 * (Sede-Lock) y las distribuye con el upsert dual de `dual_sync_service.js`.
 * ==============================================================================
 */

import { queryVTiger } from './vtiger_api_service.js';
import { sedeClause, VTIGER_SEDES_VALIDAS, VTIGER_FIELDS } from './vtigerClient.js';
import { getActiveSedes } from '../config/index.js';
import { sanitizeForVtigerQuery } from '../utils/sanitize.js';
import { syncVtigerBatchDual, isCentralConfigured } from './dual_sync_service.js';
import { recordAuditEvent } from './audit_logger.js';

/**
 * Trae las ventas (o contactos) de vTiger modificados desde `horasAtras`, POR SEDE.
 * El filtro `spl_num_compras > 0` limita a clientes con compra real.
 *
 * @param {object} opts
 * @param {number} [opts.horasAtras=24]
 * @param {boolean} [opts.soloCompradores=true]
 * @param {number} [opts.limitePorSede=50]
 * @param {string[]} [opts.sedes]
 */
export async function fetchVentasRecientesVtiger({
  horasAtras = 24,
  soloCompradores = true,
  limitePorSede = 50,
  sedes = null
} = {}) {
  const sedesObjetivo = (sedes && sedes.length ? sedes : getActiveSedes().map(s => s.sedeId))
    .map(s => String(s).toUpperCase())
    .filter(s => VTIGER_SEDES_VALIDAS.includes(s));

  const fecha = new Date(Date.now() - (horasAtras * 60 * 60 * 1000));
  const pad = n => n.toString().padStart(2, '0');
  const desde = `${fecha.getUTCFullYear()}-${pad(fecha.getUTCMonth() + 1)}-${pad(fecha.getUTCDate())} ${pad(fecha.getUTCHours())}:${pad(fecha.getUTCMinutes())}:${pad(fecha.getUTCSeconds())}`;
  const safeDesde = sanitizeForVtigerQuery(desde, 25);
  // Ventana por DIA para la fecha de compra (es un campo DATE, no datetime).
  const desdeDia = safeDesde.slice(0, 10);

  const acumulado = [];
  for (const sede of sedesObjetivo) {
    const filtroCompras = soloCompradores ? ` AND ${VTIGER_FIELDS.NUM_COMPRAS} > 0` : '';
    // ======================================================================
    // [FILTRO CORREGIDO] Antes se filtraba por `modifiedtime`, que marca
    // CUALQUIER edición del registro (una nota del asesor, un campo de campaña),
    // no una compra. Medición real en Palacios:
    //   modificados en 24 h          -> 2000+  (pero sus compras reales eran de
    //                                           2026-09, 2026-07, 2026-06, 2025-11...)
    //   por FECHA REAL DE COMPRA 24 h -> 23    <- las ventas de ayer
    // Por eso el puente "no traía las ventas del día": traía fichas editadas.
    //
    // Ahora se filtra por `spl_fecha_ultima_compra` (la fecha real de la venta) y
    // se ORDENA de más reciente a más antigua, para que las ventas de ayer sean
    // SIEMPRE las primeras en entrar y no queden detrás del tope.
    const q = `SELECT * FROM Contacts WHERE ${VTIGER_FIELDS.FECHA_ULTIMA_COMPRA} >= '${desdeDia}'${filtroCompras}${sedeClause(sede)} ORDER BY ${VTIGER_FIELDS.FECHA_ULTIMA_COMPRA} DESC LIMIT ${Math.min(Math.max(parseInt(limitePorSede, 10) || 50, 1), 200)};`;
    try {
      const filas = await queryVTiger(q, sede);
      for (const f of (filas || [])) acumulado.push({ ...f, __sedeOrigen: sede });
      console.log(`[Sales Bridge] [FETCH] ${sede}: ${(filas || []).length} COMPRADORES con fecha de ultima compra >= ${desdeDia} (ordenados del mas reciente al mas antiguo).`);
    } catch (err) {
      console.error(`[Sales Bridge] [ERROR] Consulta de ventas falló para ${sede}: ${err.message}`);
      recordAuditEvent({ type: 'SALES_BRIDGE_QUERY_FAILED', severity: 'error', sede, message: err.message });
    }
  }
  return acumulado;
}

/**
 * Ejecuta el puente completo: barre vTiger y hace el upsert dual en GHL.
 *
 * @param {object} [opts] mismas opciones que `fetchVentasRecientesVtiger`
 * @returns {Promise<object>} resumen del ciclo
 */
export async function runVtigerSalesBridge(opts = {}) {
  const { horasAtras = 24, soloCompradores = true } = opts;
  const inicio = Date.now();

  console.log(`[Sales Bridge] [CYCLE] Iniciando puente vTiger -> GHL (últimas ${horasAtras} h, soloCompradores=${soloCompradores}).`);
  console.log(`[Sales Bridge] [CONFIG] Cuenta Empresa (macro): ${isCentralConfigured() ? 'configurada' : 'NO configurada (solo sede)'}`);

  const registros = await fetchVentasRecientesVtiger(opts);
  if (registros.length === 0) {
    console.log('[Sales Bridge] [CYCLE] Sin ventas recientes que sincronizar.');
    return { total: 0, creados: 0, actualizados: 0, descartados: 0, fallidos: 0, ms: Date.now() - inicio };
  }

  const resumen = await syncVtigerBatchDual(registros, { pausaMs: opts.pausaMs ?? 250 });
  resumen.ms = Date.now() - inicio;

  // [VISIBILIDAD] Se audita una linea por contacto sincronizado. Antes el puente
  // solo dejaba un resumen al final, asi que en produccion no habia forma de ver
  // QUE contactos se crearon: la unica senal era el total, y si el conteo estaba
  // mal (bug corregido de ok/skipped) parecia que no pasaba nada.
  if (Array.isArray(resumen.detalle)) {
    for (const d of resumen.detalle) {
      recordAuditEvent({
        type: d.accion === 'creado' ? 'SALES_BRIDGE_CONTACT_CREATED'
          : d.accion === 'actualizado' ? 'SALES_BRIDGE_CONTACT_UPDATED'
          : d.accion === 'descartado' ? 'SALES_BRIDGE_CONTACT_SKIPPED'
          : 'SALES_BRIDGE_CONTACT_FAILED',
        severity: d.accion === 'fallido' ? 'error' : 'info',
        sede: d.sede,
        vTigerId: d.vTigerId,
        nombre: d.nombre,
        telefono: d.telefono,
        macroOk: d.macroOk,
        historialOk: d.historialOk,
        motivo: d.motivo
      });
    }
  }

  recordAuditEvent({
    type: 'SALES_BRIDGE_CYCLE',
    severity: resumen.fallidos > 0 ? 'warn' : 'info',
    ...resumen
  });

  console.log(`[Sales Bridge] [DONE] ${JSON.stringify(resumen)}`);
  return resumen;
}
