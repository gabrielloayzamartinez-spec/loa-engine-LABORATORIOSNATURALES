/**
 * ==============================================================================
 * NIVEL 2 EN DOS CARRILES (A = histórico, B = reconciliación)
 * ==============================================================================
 * POR QUÉ (auditoría 27/11/2026):
 * El Nivel 2 tenía SIETE jobs compitiendo por el mismo turno y la misma cuota.
 * Medición en producción:
 *   · backfill de compradores: 12.540 / 44.464 (28,2%), ritmo 249/h, ETA 128 h
 *   · refill comercial:        840 revisados (Palacios), cursor en 12x2831596
 *   · curador de estándar:     20 contactos cada 20 min
 * Todos usan `tomarTurno('nivel2')`, así que el refill (que repara lo ya hecho)
 * le robaba el turno al backfill (que trae lo que falta). El avance histórico se
 * frenaba mientras el sistema "se curaba" en círculos.
 *
 * AHORA SON DOS CARRILES CON OBJETIVOS DISTINTOS:
 *   A · HISTÓRICO       → COBERTURA.  Recorre la cartera de vTiger de lo más
 *                        nuevo a lo más antiguo (backfill de compradores, fechas,
 *                        leads). Es el que cierra la brecha.
 *   B · RECONCILIACIÓN  → COMPLETITUD. Recorre lo YA sincronizado y repara huecos
 *                        (refill comercial, curador de estándar, re-etiquetado).
 *
 * REGLAS DE CONVIVENCIA:
 *   1. Un carril corre a la vez (nunca dos jobs de fondo escribiendo en paralelo).
 *   2. Si A y B quieren arrancar juntos, gana A: traer lo que falta vale más que
 *      volver a revisar lo que ya está.
 *   3. B usa lotes pequeños (≤ 20) para no bloquear a A más de ~30 s.
 *   4. La cuota REAL la sigue controlando `ghlFetch` / `hayCuotaRealDeFondo`: los
 *      carriles solo deciden el ORDEN, no el permiso.
 * ==============================================================================
 */

export const CARRILES = {
  HISTORICO: {
    id: 'N2A',
    nombre: 'Histórico',
    objetivo: 'cobertura',
    descripcion: 'trae de vTiger lo que todavía no está en GHL (nuevo → antiguo)',
    peso: 3,
    loteSugerido: 100
  },
  RECONCILIACION: {
    id: 'N2B',
    nombre: 'Reconciliación',
    objetivo: 'completitud',
    descripcion: 'repara huecos y etiquetas de lo que ya está en GHL',
    peso: 2,
    loteSugerido: 20
  }
};

const estado = {
  N2A: { ocupado: false, desde: 0, ultimoInicio: 0, ultimoFin: 0, ciclos: 0, contactos: 0 },
  N2B: { ocupado: false, desde: 0, ultimoInicio: 0, ultimoFin: 0, ciclos: 0, contactos: 0 }
};

/** ¿El carril está ocupado ahora mismo? */
export function carrilOcupado(id) {
  return Boolean(estado[id]?.ocupado);
}

/**
 * Intenta tomar el turno de un carril.
 *
 * @param {'N2A'|'N2B'} id
 * @returns {boolean} true si puede arrancar el ciclo
 */
export function tomarTurnoCarril(id) {
  const propio = estado[id];
  if (!propio || propio.ocupado) return false;

  const otroId = id === 'N2A' ? 'N2B' : 'N2A';
  const otro = estado[otroId];

  if (otro?.ocupado) {
    // Si el que corre es el HISTÓRICO, la reconciliación espera (prioridad A).
    // Si el que corre es la RECONCILIACIÓN, A solo espera si B lleva poco tiempo:
    // un lote de B es de ≤20 contactos, así que la espera está acotada.
    if (id === 'N2B') return false;
    const transcurrido = Date.now() - (otro.desde || 0);
    if (transcurrido < 90 * 1000) return false;
    // B se excedió del lote esperado: se considera trabado y A lo releva.
  }

  propio.ocupado = true;
  propio.desde = Date.now();
  propio.ultimoInicio = propio.desde;
  propio.ciclos += 1;
  return true;
}

/** Libera el turno del carril. */
export function liberarTurnoCarril(id, contactos = 0) {
  const reg = estado[id];
  if (!reg) return;
  reg.ocupado = false;
  reg.ultimoFin = Date.now();
  if (Number.isFinite(contactos) && contactos > 0) reg.contactos += contactos;
}

/** Estado de los dos carriles (para /api/nivel2/carriles y el panel). */
export function getEstadoCarriles() {
  const total = CARRILES.HISTORICO.peso + CARRILES.RECONCILIACION.peso;
  const salida = {};
  for (const c of Object.values(CARRILES)) {
    const reg = estado[c.id];
    salida[c.id] = {
      nombre: c.nombre,
      objetivo: c.objetivo,
      descripcion: c.descripcion,
      cuotaRelativaPct: Math.round((c.peso / total) * 100),
      loteSugerido: c.loteSugerido,
      ocupado: reg.ocupado,
      ciclos: reg.ciclos,
      contactos: reg.contactos,
      ultimoInicio: reg.ultimoInicio ? new Date(reg.ultimoInicio).toISOString() : null,
      ultimoFin: reg.ultimoFin ? new Date(reg.ultimoFin).toISOString() : null
    };
  }
  return {
    carriles: salida,
    corriendo: Object.entries(estado).filter(([, r]) => r.ocupado).map(([id]) => id),
    regla: 'un carril a la vez; si ambos quieren arrancar, gana el HISTÓRICO (N2A)'
  };
}

/** Reinicia el estado en memoria (útil en pruebas y tras un redeploy). */
export function reiniciarCarriles() {
  for (const id of Object.keys(estado)) {
    estado[id] = { ocupado: false, desde: 0, ultimoInicio: 0, ultimoFin: 0, ciclos: 0, contactos: 0 };
  }
}
