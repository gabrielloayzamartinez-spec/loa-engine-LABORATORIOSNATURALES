/**
 * ==============================================================================
 * LOA ENGINE - BACKFILL DE LEADS vTiger -> GHL (Nivel 2)
 * ==============================================================================
 * Sincroniza los contactos NO COMPRADORES (leads) de vTiger a GHL, enriqueciendo
 * todos los custom fields de Contactos (Fecha Creación, Sexo, Etapa, Contact No,
 * ID Cliente, Asesor, Proveedor, Canal, Tratamiento, Origen, Sede, Total Compras=0,
 * Estado Comercial=SIN VENTA). Enruta por Oficina Actual (cf_3590).
 *
 * Se apoya en `syncVtigerContactDual` con `permitirLead: true` (la misma carga que
 * usan los compradores, pero permitiendo leads). Tiene cursor persistente por sede.
 * ==============================================================================
 */

import { queryVTiger } from './vtiger_api_service.js';
import { sedeClause, VTIGER_SEDES_VALIDAS, VTIGER_FIELDS, VTIGER_CONTACT_SELECT } from './vtigerClient.js';
import { syncVtigerContactDual } from './dual_sync_service.js';
import { getStateStore } from './state/state_store.js';
import { recordAuditEvent } from './audit_logger.js';

const leadStore = getStateStore('leads_backfill');
const CURSOR_KEY = 'cursor_v1';

// Años a barrer (los leads históricos van de 2019 a 2026).
const ANOS = ['2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'];

/**
 * Ejecuta un ciclo del backfill de leads: barre un lote de leads por sede/año.
 * Es Nivel 2: usa respiro entre contactos y cede ante el trabajo en vivo.
 *
 * @param {object} [opts]
 * @param {number} [opts.tamanoLote=50]
 * @param {number} [opts.maxLotes=1]
 * @param {number} [opts.pausaMs=250]
 * @param {string[]} [opts.sedes]
 */
export async function runLeadsBackfill({ tamanoLote = 50, maxLotes = 1, pausaMs = 250, sedes = null } = {}) {
  const sedesObjetivo = (sedes && sedes.length ? sedes : VTIGER_SEDES_VALIDAS).filter(s => VTIGER_SEDES_VALIDAS.includes(s));
  const estado = await leadStore.get(CURSOR_KEY, null) || { porSede: {} };

  const resumen = { contactos: 0, sincronizados: 0, descartados: 0, fallidos: 0, porSede: {} };

  for (let lote = 0; lote < maxLotes; lote++) {
    for (const sede of sedesObjetivo) {
      const s = estado.porSede[sede] || { anoIdx: 0, offset: 0, completo: false };
      if (s.completo) continue;
      resumen.porSede[sede] = s;

      const ano = ANOS[s.anoIdx];
      const anoSig = ANOS[s.anoIdx + 1] || '2027';
      const limite = Math.min(Math.max(parseInt(tamanoLote, 10) || 50, 1), 150);

      // Solo leads (spl_num_compras = 0), acotado por año y por sede (Sede-Lock).
      const q = `SELECT ${VTIGER_CONTACT_SELECT}, ${VTIGER_FIELDS.ESTADO_CRM}, ${VTIGER_FIELDS.PROVEEDOR}, ${VTIGER_FIELDS.CANAL}, ${VTIGER_FIELDS.CAMPANA}, ${VTIGER_FIELDS.SEXO}, ${VTIGER_FIELDS.ESTADO_VENTA}, ${VTIGER_FIELDS.CONTACT_NO}, ${VTIGER_FIELDS.ASESOR}, ${VTIGER_FIELDS.CREATED_TIME}, ${VTIGER_FIELDS.SEDE_ACTUAL} FROM Contacts WHERE ${VTIGER_FIELDS.NUM_COMPRAS} = '0' AND ${VTIGER_FIELDS.CREATED_TIME} >= '${ano}-01-01' AND ${VTIGER_FIELDS.CREATED_TIME} < '${anoSig}-01-01'${sedeClause(sede)} ORDER BY ${VTIGER_FIELDS.CREATED_TIME} ASC LIMIT ${s.offset}, ${limite};`;

      let filas = [];
      try {
        filas = await queryVTiger(q, sede);
      } catch (err) {
        console.error(`[Leads Backfill] [ERROR] Consulta fallida en ${sede} (${ano}): ${err.message}`);
        resumen.fallidos++;
        continue;
      }

      if (!filas || filas.length === 0) {
        // Avanza al siguiente año
        if (s.anoIdx < ANOS.length - 1) {
          s.anoIdx++;
          s.offset = 0;
        } else {
          s.completo = true;
        }
        await leadStore.set(CURSOR_KEY, estado);
        continue;
      }

      for (const lead of filas) {
        try {
          const r = await syncVtigerContactDual(lead, { permitirLead: true });
          resumen.contactos++;
          if (r?.skipped) resumen.descartados++;
          else if (r?.operativa?.ok) resumen.sincronizados++;
          else resumen.fallidos++;
        } catch (err) {
          resumen.fallidos++;
        }
        if (pausaMs > 0) await new Promise(r => setTimeout(r, pausaMs));
      }

      s.offset += filas.length;
      await leadStore.set(CURSOR_KEY, estado);
      console.log(`[Leads Backfill] [${sede}] ${ano} (offset ${s.offset}): +${filas.length} leads (sincronizados ${resumen.sincronizados}, fallidos ${resumen.fallidos}).`);
    }
  }

  recordAuditEvent({ type: 'LEADS_BACKFILL_CYCLE', severity: resumen.fallidos > 0 ? 'warn' : 'info', ...resumen });
  return resumen;
}
