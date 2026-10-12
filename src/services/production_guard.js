/**
 * ==============================================================================
 * VIGILANCIA DE PRODUCCIÓN — "un proceso solo funciona si PRODUCE"
 * ==============================================================================
 * CRÍTICA DEL USUARIO (justa)
 * "Desarrollo robusto pero poco constante, poco estable. Hay que evitar errores de
 * esta escala." El patrón de todos los fallos de esta semana fue el mismo: un
 * proceso que "corría" pero NO producía trabajo, y nadie lo detectó a tiempo:
 *
 *   · el backfill estuvo 55 horas congelado por un flag `completo` falso;
 *   · el radar reprocesaba en bucle;
 *   · el curador re-barría la base en bucle infinito.
 *
 * POR QUÉ EXISTE ESTA CAPA
 * La auditoría técnica mide la SALUD INTERNA (bucles, costo, cuota). Esta capa mide
 * la PRODUCCIÓN REAL de cada proceso crítico: ¿avanzó su cursor? ¿atendió leads?
 * ¿escribió algo? Y verifica INVARIANTES de negocio que, si se rompen, delatan un
 * error de escala: un `completo` que no corresponde a la realidad es el caso exacto
 * que detuvo la migración días enteros.
 *
 * QUÉ HACE (cada 15 minutos, de forma autónoma)
 *   1. INVARIANTES  — reglas que siempre deben cumplirse. Si se rompen, se registran
 *      como CRÍTICAS y, cuando hay una cura automática segura, se APLICA.
 *   2. LIVENESS     — para cada proceso crítico, cuánto hace que produjo su última
 *      unidad de trabajo real. Si supera su umbral, se alerta.
 *   3. SELF-HEAL    — corrige solo lo que tiene cura determinista (bajar un flag
 *      falso), y deja constancia de CADA curación en la auditoría.
 *
 * SOLO LECTURA + auto-curación acotada: nunca inventa datos, solo corrige estados
 * internos demostrablemente erróneos.
 * ==============================================================================
 */

import { getBuyersBackfillStatus, desatascarBackfill } from './vtiger_buyers_backfill.js';
import { VTIGER_SEDES_VALIDAS } from './vtigerClient.js';
import { recordAuditEvent } from './audit_logger.js';
import { getGhlRateState } from '../utils/ghl_http_client.js';

/** Umbral de "sin actividad" por proceso (ms). Pasado esto se alerta. */
const UMBRALES_LIVENESS = {
  // La migración de compradores debe avanzar al menos cada 3 h (si está pendiente).
  backfill: 3 * 60 * 60 * 1000,
  // El radar de atención en vivo debe reportar actividad cada 10 min.
  radar: 10 * 60 * 1000
};

/**
 * Ejecuta la vigilancia completa.
 * @returns {object} informe con invariantes, liveness, auto-curaciones y alertas
 */
export async function ejecutarVigilanciaProduccion() {
  const informe = {
    ts: new Date().toISOString(),
    invariantes: [],
    liveness: [],
    autoCuraciones: [],
    alertas: []
  };

  // ==========================================================================
  // 1. INVARIANTES DEL BACKFILL (el defecto de las 55 horas)
  // ==========================================================================
  try {
    const estado = await getBuyersBackfillStatus();
    let curaPendiente = false;

    for (const sede of VTIGER_SEDES_VALIDAS) {
      const p = estado.porSede?.[sede];
      if (!p || p.compradoresTotal == null) continue;
      const offset = parseInt(p.offset, 10) || 0;
      const total = p.compradoresTotal;

      // Invariante A: una sede "completa" debe tener su offset == total.
      if (p.completo && offset < total) {
        informe.invariantes.push({
          severidad: 'CRITICO',
          regla: 'completo-sede-inconsistente',
          sede,
          detalle: `${sede} figura completa con ${offset}/${total}`
        });
        // Cura determinista: bajar el flag de la sede (recibe un array).
        await desatascarBackfill([sede]);
        curaPendiente = true;
        informe.autoCuraciones.push({ regla: 'completo-sede-inconsistente', sede });
      }

      // Invariante B: el offset nunca debe superar el total.
      if (offset > total) {
        informe.invariantes.push({
          severidad: 'CRITICO',
          regla: 'offset-supera-total',
          sede,
          detalle: `${sede} offset ${offset} > total ${total}`
        });
      }
    }

    if (curaPendiente) {
      recordAuditEvent({
        type: 'PRODUCTION_GUARD_HEALED',
        severity: 'warn',
        curaciones: informe.autoCuraciones,
        message: 'Flags de completitud inconsistentes corregidos automáticamente.'
      });
    }

    // ========================================================================
    // 2. LIVENESS DEL BACKFILL: ¿avanzó recientemente?
    // ========================================================================
    const ultimaEjec = estado.ultimaEjecucion ? new Date(estado.ultimaEjecucion).getTime() : null;
    if (!estado.completo && ultimaEjec) {
      const sinAvanceMs = Date.now() - ultimaEjec;
      if (sinAvanceMs > UMBRALES_LIVENESS.backfill) {
        const horas = Math.round(sinAvanceMs / 3600000);
        informe.liveness.push({ proceso: 'backfill', estado: 'SIN ACTIVIDAD', haceHoras: horas });
        informe.alertas.push({
          nivel: 'CRITICO',
          codigo: 'BACKFILL_SIN_ACTIVIDAD',
          mensaje: `El backfill lleva ${horas} h sin avanzar y aún no está completo.`
        });
      }
    }
  } catch (err) {
    informe.alertas.push({ nivel: 'ERROR', codigo: 'VIGILANCIA_BACKFILL', mensaje: err.message });
  }

  // ==========================================================================
  // 3. LIVENESS DEL RADAR (atención en vivo)
  // ==========================================================================
  try {
    const radarTs = global.lastRadarActivity || 0;
    if (radarTs > 0) {
      const sinActividadMs = Date.now() - radarTs;
      if (sinActividadMs > UMBRALES_LIVENESS.radar) {
        const min = Math.round(sinActividadMs / 60000);
        informe.liveness.push({ proceso: 'radar', estado: 'SIN ACTIVIDAD', haceMin: min });
        informe.alertas.push({
          nivel: 'ALTO',
          codigo: 'RADAR_SIN_ACTIVIDAD',
          mensaje: `El radar no reporta actividad hace ${min} min.`
        });
      }
    }
  } catch (err) {
    informe.alertas.push({ nivel: 'ERROR', codigo: 'VIGILANCIA_RADAR', mensaje: err.message });
  }

  // ==========================================================================
  // 4. INVARIANTE DE CUOTA: ninguna sede en 0 (atención en vivo sin margen)
  // ==========================================================================
  try {
    const cuota = getGhlRateState();
    for (const [sede, st] of Object.entries(cuota)) {
      if (Number.isFinite(st.dailyRemaining) && st.dailyRemaining === 0) {
        informe.invariantes.push({
          severidad: 'CRITICO',
          regla: 'cuota-agotada',
          sede,
          detalle: `${sede} está en 0 peticiones`
        });
        informe.alertas.push({
          nivel: 'CRITICO',
          codigo: 'CUOTA_AGOTADA',
          mensaje: `La subcuenta ${sede} está en 0 peticiones: su atención en vivo no puede trabajar.`
        });
      }
    }
  } catch (err) {
    informe.alertas.push({ nivel: 'ERROR', codigo: 'VIGILANCIA_CUOTA', mensaje: err.message });
  }

  // ==========================================================================
  // 5. VEREDICTO GLOBAL
  // ==========================================================================
  const criticas = informe.alertas.filter(a => a.nivel === 'CRITICO').length;
  const altas = informe.alertas.filter(a => a.nivel === 'ALTO').length;
  informe.veredicto = criticas > 0 ? '🔴 CRITICO' : (altas > 0 ? '🟠 ATENCION' : '🟢 SALUDABLE');

  if (informe.alertas.length > 0 || informe.autoCuraciones.length > 0) {
    recordAuditEvent({
      type: 'PRODUCTION_GUARD_CYCLE',
      severity: criticas > 0 ? 'error' : (altas > 0 ? 'warn' : 'info'),
      veredicto: informe.veredicto,
      alertas: informe.alertas,
      autoCuraciones: informe.autoCuraciones
    });
  }

  return informe;
}
