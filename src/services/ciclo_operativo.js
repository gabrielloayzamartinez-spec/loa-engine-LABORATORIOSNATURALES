/**
 * ==============================================================================
 * CICLO OPERATIVO — DOS CARRILES PARA EL NIVEL 2 (A = histórico, B = reconciliación)
 * ==============================================================================
 * HISTORIA (por qué existe este archivo):
 * El motor tenía ~9 procesos de Nivel 2 con su propio `setInterval`. Como los
 * intervalos no estaban alineados, en el mismo minuto se disparaban varios y el
 * consumo del día se volvía impredecible. Se resolvió con un "ticket" GLOBAL: solo
 * una tarea de fondo a la vez.
 *
 * PROBLEMA QUE ESO CREÓ (medido 27/11/2026):
 * El mismo ticket lo usaban el backfill histórico (que trae lo que falta) y el
 * refill/curador (que revisa lo que ya está). El refill le robaba el turno al
 * backfill y el avance histórico se frenaba: Palacios quedó en 17,7% (6.480 de
 * 36.925 compradores) mientras el sistema "se curaba" en círculos.
 *
 * SOLUCIÓN (Nivel 2 partido en dos):
 *   N2A · HISTÓRICO      → cobertura.  Trae de vTiger lo que no está en GHL.
 *   N2B · RECONCILIACIÓN → completitud. Repara lo que ya está sincronizado.
 *
 * Reglas:
 *   1. Dentro de un carril, UNA tarea a la vez (como antes).
 *   2. Entre carriles, también UNA a la vez (protege la cuota global).
 *   3. Si A y B quieren arrancar juntos, GANA A: traer lo que falta vale más que
 *      revisar lo que ya está.
 *   4. Un carril B que lleve demasiado tiempo corriendo (watchdog) se libera para
 *      que A no quede bloqueado por un lote lento.
 *
 * El trabajo EN VIVO (radar, router, webhooks, Nivel 3 reactivo) NO pasa por aquí.
 * ==============================================================================
 */

export const CARRILES = { HISTORICO: 'N2A', RECONCILIACION: 'N2B' };

/** Tope por turno: si una tarea se cuelga, el turno no queda tomado para siempre.
 *  El carril A (histórico) necesita más margen: un ciclo del backfill de compradores
 *  dura ~50 min de día y ~45 de madrugada por diseño (perfil horario). */
const TOPE_POR_CARRIL_MS = {
  N2A: 120 * 60 * 1000,
  N2B: 45 * 60 * 1000
};
/** Tope del carril B cuando A está esperando: un lote de B es corto. */
const TOPE_B_CON_A_ESPERANDO_MS = 10 * 60 * 1000;

const estado = {
  N2A: { tarea: null, desde: 0 },
  N2B: { tarea: null, desde: 0 }
};

function carrilDe(carril) {
  const c = String(carril || CARRILES.HISTORICO).toUpperCase();
  return estado[c] ? c : CARRILES.HISTORICO;
}

/**
 * Intenta tomar el turno de un carril.
 *
 * @param {string} tarea nombre de la tarea (p. ej. 'backfill-compradores')
 * @param {'N2A'|'N2B'} [carril='N2A']
 * @returns {boolean} true si puede arrancar
 */
export function tomarTurno(tarea, carril = CARRILES.HISTORICO) {
  const id = carrilDe(carril);
  const propio = estado[id];
  const otroId = id === CARRILES.HISTORICO ? CARRILES.RECONCILIACION : CARRILES.HISTORICO;
  const otro = estado[otroId];

  if (propio.tarea) {
    const transcurrido = Date.now() - propio.desde;
    if (transcurrido > TOPE_POR_CARRIL_MS[id]) {
      console.warn(`[Ciclo Operativo] [WATCHDOG] Tarea '${propio.tarea}' (${id}) colgada ${Math.round(transcurrido / 60000)} min: se libera el turno.`);
      propio.tarea = null;
      propio.desde = 0;
    } else {
      return false;
    }
  }

  if (otro.tarea) {
    const transcurrido = Date.now() - otro.desde;
    const tope = otroId === CARRILES.RECONCILIACION ? TOPE_B_CON_A_ESPERANDO_MS : TOPE_POR_CARRIL_MS[otroId];
    if (transcurrido <= tope) {
      // El carril contrario está trabajando: no se pisa. Si el que corre es B y el
      // que pide es A, A espera solo el lote corto de B (tope de 10 min, arriba).
      return false;
    }
    console.warn(`[Ciclo Operativo] [WATCHDOG] Carril ${otroId} excedió ${Math.round(tope / 60000)} min ('${otro.tarea}'): lo releva ${id}.`);
    otro.tarea = null;
    otro.desde = 0;
  }

  propio.tarea = tarea;
  propio.desde = Date.now();
  return true;
}

/** Libera el turno cuando la tarea termina (o falla). */
export function liberarTurno(tarea) {
  for (const id of Object.keys(estado)) {
    if (estado[id].tarea === tarea) {
      estado[id].tarea = null;
      estado[id].desde = 0;
    }
  }
}

/** Estado del ciclo operativo (para /api/health, /api/nivel2/carriles y diagnóstico). */
export function getCicloOperativo() {
  return {
    carriles: {
      N2A: { nombre: 'Histórico', tarea: estado.N2A.tarea, desde: estado.N2A.desde || null, ocupado: Boolean(estado.N2A.tarea) },
      N2B: { nombre: 'Reconciliación', tarea: estado.N2B.tarea, desde: estado.N2B.desde || null, ocupado: Boolean(estado.N2B.tarea) }
    },
    ocupado: Boolean(estado.N2A.tarea || estado.N2B.tarea),
    regla: 'un carril a la vez; si A y B coinciden, gana A (histórico)'
  };
}

/** Reinicia los turnos (pruebas o recuperación tras un redeploy). */
export function reiniciarCicloOperativo() {
  estado.N2A = { tarea: null, desde: 0 };
  estado.N2B = { tarea: null, desde: 0 };
}
