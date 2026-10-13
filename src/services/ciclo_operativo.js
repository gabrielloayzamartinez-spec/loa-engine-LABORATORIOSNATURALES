/**
 * ==============================================================================
 * CICLO OPERATIVO — SERIALIZACIÓN DEL TRABAJO DE NIVEL 2
 * ==============================================================================
 * PROBLEMA REPORTADO (coordinador): "veo varios disparados al mismo tiempo, cosa que
 * no da control ni gestión diaria y se vuelve variable".
 *
 * El motor tenía ~9 procesos de nivel 2 (backfill, ordenes, sales bridge, re-llenado,
 * curador, reverse sync, guardianes, ...) cada uno con su propio `setInterval`. Como
 * los intervalos no estaban alineados, en un mismo minuto podían dispararse VARIOS a
 * la vez: el consumo del día se volvía impredecible.
 *
 * SOLUCIÓN: un "ticket" global. Solo UNA tarea de nivel 2 puede estar activa a la
 * vez. Si un scheduler dispara y hay otra tarea en curso, SE OMITE ese disparo (la
 * tarea ya correrá en el siguiente turno). Así el nivel 2 avanza en BLOQUES
 * CONTROLADOS y SECUENCIALES, con un número diario predecible.
 *
 * La atención EN VIVO (radar, router, webhooks) NO pasa por aquí: es prioritaria y
 * siempre corre.
 * ==============================================================================
 */

let tareaActiva = null;
let tareaActivaDesde = null;

/**
 * Intenta tomar el turno para una tarea de nivel 2.
 * @param {string} tarea nombre de la tarea (p.ej. 'backfill-compradores')
 * @returns {boolean} true si puede arrancar (no hay otra tarea en curso)
 */
export function tomarTurno(tarea) {
  if (tareaActiva) return false;
  tareaActiva = tarea;
  tareaActivaDesde = Date.now();
  return true;
}

/** Libera el turno cuando la tarea termina (o falla). */
export function liberarTurno(tarea) {
  if (tareaActiva === tarea) {
    tareaActiva = null;
    tareaActivaDesde = null;
  }
}

/** Estado del ciclo operativo (para /api/health y diagnóstico). */
export function getCicloOperativo() {
  return {
    tareaActiva,
    tareaActivaDesde,
    ocupado: Boolean(tareaActiva)
  };
}
