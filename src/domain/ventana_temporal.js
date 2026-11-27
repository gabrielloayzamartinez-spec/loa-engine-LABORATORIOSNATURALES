/**
 * ==============================================================================
 * VENTANA TEMPORAL — FRONTERA N1 (HOY) / N2 (HISTÓRICO)
 * ==============================================================================
 * REGLA DEL NEGOCIO (27/11/2026):
 *   · NIVEL 1 = SOLO el trabajo de HOY (hora Lima). Es la armonía de los asesores
 *     de redes: lo que el lead escribe hoy.
 *   · NIVEL 2 = TODO lo anterior a HOY (histórico hasta el día anterior). Toda la
 *     data de vTiger, con todos sus CF, sincronizada.
 *
 * La frontera es SIEMPRE medianoche de Lima (UTC-5, sin horario de verano). Se
 * centraliza aquí para que radar, backfills y auditorías usen el MISMO corte: si
 * cada módulo calcula su propia medianoche, tarde o temprano discrepan.
 * ==============================================================================
 */

const OFFSET_LIMA_MS = 5 * 3600 * 1000; // UTC-5 fijo

/** Inicio del día de HOY en Lima, en milisegundos UTC. */
export function inicioDiaLima(ts = Date.now()) {
  const lima = new Date(ts - OFFSET_LIMA_MS);
  return Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate()) + OFFSET_LIMA_MS;
}

/** ¿El instante pertenece al día de HOY (Lima)? */
export function esDeHoy(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return false;
  return n >= inicioDiaLima();
}

/** Fecha de HOY en Lima, formato AAAA-MM-DD. */
export function fechaLimaISO(ts = Date.now()) {
  return new Date(ts - OFFSET_LIMA_MS).toISOString().slice(0, 10);
}

/** Fecha de AYER en Lima, formato AAAA-MM-DD. */
export function fechaAyerLimaISO(ts = Date.now()) {
  return new Date(inicioDiaLima(ts) - OFFSET_LIMA_MS - 1000).toISOString().slice(0, 10);
}

/**
 * Cláusula para vTiger que acota a HISTÓRICO (antes de hoy).
 * vTiger guarda las fechas en hora de Lima, así que el corte es la medianoche local.
 *
 * @param {string} campo campo de fecha (por defecto createdtime)
 * @returns {string} ` AND <campo> < 'AAAA-MM-DD 00:00:00'`
 */
export function filtroVtigerAntesDeHoy(campo = 'createdtime', ts = Date.now()) {
  const permitido = String(campo).replace(/[^a-zA-Z_]/g, '');
  return ` AND ${permitido} < '${fechaLimaISO(ts)} 00:00:00'`;
}

/** ¿Está activo el recorte histórico de N2? (N2_HASTA_AYER=true por defecto) */
export function n2SoloHistorico() {
  return String(process.env.N2_HASTA_AYER ?? 'true').toLowerCase() !== 'false';
}
