/**
 * ==============================================================================
 * RE-LLENADO COMERCIAL — SEGUNDA PASADA CORRECTIVA
 * ==============================================================================
 * POR QUÉ EXISTE
 * El sincronizador tenía un defecto: el historial comercial (nº de compras, Fecha
 * Última Compra, Fecha Primera Compra, monto y Sexo) SOLO viajaba cuando el
 * contacto NO existía todavía en GHL. Como el caso normal es que el lead ENTRE
 * primero (creado por el router) y DESPUÉS aparezca como COMPRADOR en vTiger, esos
 * compradores quedaron congelados como "No Comprador" sin fecha ni monto.
 *
 * El defecto ya está corregido, pero el cursor del backfill SOLO AVANZA: los
 * contactos que quedaron atrás no se vuelven a procesar nunca. Este módulo hace
 * una SEGUNDA PASADA sobre los compradores de vTiger para RE-LLENAR sus datos.
 *
 * CÓMO FUNCIONA
 *   · Usa un cursor PROPIO (clave distinta) para no interferir con el backfill.
 *   · Recorre los compradores de vTiger (ORDER BY id DESC) y re-ejecuta el MISMO
 *     sincronizador dual que usa el backfill.
 *   · Como el filtro `soloAvances` está activo, es incapaz de retroceder un dato:
 *     solo escribe lo que falta o lo que es más reciente.
 *
 * SEGURIDAD
 *   · DRY-RUN por defecto: sin `ejecutar=true` no escribe NADA.
 *   · Throttle y lotes acotados: nunca compite con la atención en vivo.
 *   · Delega el respeto de cuota a `hayCuotaRealDeFondo` (el mismo guardián).
 * ==============================================================================
 */

import { getStateStore } from './state/state_store.js';
import { ghlFetch } from '../utils/ghl_http_client.js';
import { tokenBucketQueue } from './token_bucket_queue.js';
import { hayCuotaRealDeFondo } from '../utils/ghl_http_client.js';
import { syncVtigerContactDual } from './dual_sync_service.js';
import { recordAuditEvent } from './audit_logger.js';
import { query as vtigerQuery, VTIGER_CONTACT_SELECT, VTIGER_FIELDS, sedeClause, VTIGER_SEDES_VALIDAS } from './vtigerClient.js';

const store = getStateStore('commercial_refill');
const CURSOR_KEY = 'refill_v1_desc';

async function leerEstado() {
  return await store.get(CURSOR_KEY, null) || {
    porSede: {},
    totales: { revisados: 0, rellenados: 0, fallidos: 0 },
    ultimaEjecucion: null
  };
}

/** Estado del re-llenado (para /api/health y diagnóstico). */
export async function getRefillStatus() {
  return await leerEstado();
}

/**
 * Ejecuta una tanda del re-llenado.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede='PALACIOS']
 * @param {number} [opts.lote=50]   contactos por tanda (tope 150)
 * @param {number} [opts.lotes=1]   tandas por llamada
 * @param {boolean} [opts.ejecutar=true] false = DRY-RUN
 */
export async function refillComercial({ sede = 'PALACIOS', lote = 50, lotes = 1, ejecutar = true } = {}) {
  const sedeId = String(sede).toUpperCase();
  if (!VTIGER_SEDES_VALIDAS.includes(sedeId)) return { ok: false, reason: `sede ${sedeId} no valida` };

  const estado = await leerEstado();
  const limite = Math.min(Math.max(parseInt(lote, 10) || 50, 1), 150);
  const vueltas = Math.min(Math.max(parseInt(lotes, 10) || 1, 1), 20);

  let procesados = 0;
  let rellenados = 0;
  let fallidos = 0;
  let revisados = 0;

  for (let v = 0; v < vueltas; v++) {
    const cursorSede = estado.porSede[sedeId] || { ultimoId: null, offset: 0, completo: false };
    if (cursorSede.completo) break;

    // Guardián de cuota: el re-llenado es trabajo PESADO y cede al trabajo en vivo.
    if (!hayCuotaRealDeFondo(sedeId) || !tokenBucketQueue.hayCupoPesado(sedeId)) {
      recordAuditEvent({ type: 'COMMERCIAL_REFILL_QUOTA_PAUSED', severity: 'warn', sede: sedeId, reason: 'cuota real insuficiente: se preserva la atencion en vivo' });
      break;
    }

    const filtro = cursorSede.ultimoId ? ` AND id < '${String(cursorSede.ultimoId).slice(0, 20)}'` : '';
    const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.NUM_COMPRAS} > 0${sedeClause(sedeId)}${filtro} ORDER BY id DESC LIMIT ${limite};`;

    let contactos = [];
    try {
      contactos = await vtigerQuery(q, sedeId) || [];
    } catch (err) {
      recordAuditEvent({ type: 'COMMERCIAL_REFILL_QUERY_FAILED', severity: 'error', sede: sedeId, message: err.message });
      break;
    }

    if (contactos.length === 0) {
      estado.porSede[sedeId] = { ...cursorSede, completo: true, ultimaEjecucion: new Date().toISOString() };
      await store.set(CURSOR_KEY, estado);
      break;
    }

    for (const c of contactos) {
      revisados++;
      if (!ejecutar) continue;
      try {
        const r = await syncVtigerContactDual(c);
        if (r && (r.ok || r.skipped)) rellenados++;
        else fallidos++;
      } catch {
        fallidos++;
      }
      procesados++;
      await new Promise(res => setTimeout(res, 150));
    }

    const ultimoId = contactos[contactos.length - 1]?.id || cursorSede.ultimoId;
    estado.porSede[sedeId] = {
      ultimoId,
      offset: (parseInt(cursorSede.offset, 10) || 0) + contactos.length,
      completo: false,
      ultimaEjecucion: new Date().toISOString()
    };
    await store.set(CURSOR_KEY, estado);
  }

  estado.totales = {
    revisados: (estado.totales?.revisados || 0) + revisados,
    rellenados: (estado.totales?.rellenados || 0) + rellenados,
    fallidos: (estado.totales?.fallidos || 0) + fallidos
  };
  estado.ultimaEjecucion = new Date().toISOString();
  await store.set(CURSOR_KEY, estado);

  recordAuditEvent({
    type: ejecutar ? 'COMMERCIAL_REFILL_CYCLE' : 'COMMERCIAL_REFILL_DRY_RUN',
    severity: 'info',
    sede: sedeId,
    revisados, rellenados, fallidos,
    cursor: estado.porSede[sedeId]
  });

  return {
    ok: true,
    sede: sedeId,
    modo: ejecutar ? 'EJECUTADO' : 'DRY-RUN',
    revisados, rellenados, fallidos,
    cursor: estado.porSede[sedeId],
    totales: estado.totales
  };
}

/** Reinicia el cursor del re-llenado (para volver a recorrer toda la cartera). */
export async function resetRefill(sede = null) {
  const estado = await leerEstado();
  if (sede) delete estado.porSede[String(sede).toUpperCase()];
  else estado.porSede = {};
  await store.set(CURSOR_KEY, estado);
  return { ok: true, estado };
}
