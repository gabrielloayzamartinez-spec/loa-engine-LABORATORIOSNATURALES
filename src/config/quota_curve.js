/**
 * ==============================================================================
 * CURVA DE CUOTA POR HORA — DISTRIBUCIÓN INTELIGENTE EN 24 HORAS
 * ==============================================================================
 * PEDIDO DEL USUARIO
 * "La cuota de cada sede debe distribuirse de forma inteligente, en porcentajes de
 * uso durante 24 horas, para el trabajo de nivel 1 y nivel 2. La prioridad es el
 * nivel 1."
 *
 * CÓMO LO RESUELVE
 * Cada hora del día tiene un PESO (un porcentaje del presupuesto diario del trabajo
 * de fondo). Ese porcentaje se ACUMULA hora a hora:
 *
 *     permiso(hora) = SUMA de los pesos de las horas ya transcurridas
 *
 * El trabajo de fondo sólo puede usar lo que ya se ganó. Consecuencia práctica:
 *
 *   · Si el fondo NO gastó su cuota de la madrugada, ese saldo NO se pierde: queda
 *     acumulado y puede usarlo más tarde (la cuota no caduca dentro del día).
 *   · Si en la hora pico el fondo ya gastó de más, se queda SIN permiso hasta que la
 *     curva avance. Así el día se reparte solo, sin picos y sin agotar la subcuenta.
 *
 * EL NIVEL 1 SIEMPRE MANDA
 * El nivel 1 (los leads que escriben) NO se limita ni se reparte: consume cuando
 * necesita. La curva y el tope diario aplican EXCLUSIVAMENTE al nivel 2 (fondo:
 * backfill, re-llenado, guardianes, curadores). Además, el 40% del límite de GHL
 * queda RESERVADO para el nivel 1 y el fondo no puede tocarlo nunca.
 *
 * LOS PESOS (sobre el presupuesto diario del fondo)
 *   MADRUGADA  00-06   poca atención en vivo  -> el fondo trabaja a gusto
 *   PICO       06-13   máxima carga de GHL/vTiger -> el fondo casi se detiene
 *   TARDE      13-20   carga media            -> ritmo moderado
 *   NOCHE      20-24   baja actividad         -> empuje final
 *
 * Los pesos son configurables por entorno: GHL_CURVA_CUOTA="6,7,7,..." (24 valores).
 * ==============================================================================
 */

/**
 * Peso (%) de cada hora de Lima (UTC-5, sin horario de verano).
 * La suma de los 24 pesos se normaliza al 100%, así que pueden expresarse como
 * valores relativos sin preocuparse porque sumen exacto.
 */
export const PESOS_HORA_DEFECTO = [
  6.0,  // 00 — arranque de la madrugada
  7.0,  // 01
  7.0,  // 02
  7.0,  // 03
  7.0,  // 04
  7.0,  // 05 — última hora de la madrugada
  1.5,  // 06 — empieza el pico de la mañana
  1.5,  // 07
  1.5,  // 08
  1.5,  // 09
  1.5,  // 10
  1.5,  // 11
  1.5,  // 12
  4.0,  // 13 — baja el pico
  4.0,  // 14
  4.0,  // 15
  4.0,  // 16
  4.0,  // 17
  4.0,  // 18
  4.0,  // 19
  5.0,  // 20 — empuje de la noche
  5.0,  // 21
  5.0,  // 22
  5.0   // 23 — cierre del día
];

/** Nombre de la franja operativa de una hora (para logs y reportes). */
export function franjaDeHora(hora) {
  if (hora >= 0 && hora < 6) return 'MADRUGADA';
  if (hora >= 6 && hora < 13) return 'PICO-MANANA';
  if (hora >= 13 && hora < 20) return 'TARDE';
  return 'NOCHE';
}

/** Pesos configurados (por entorno) o los de defecto. */
export function pesosHora() {
  const env = process.env.GHL_CURVA_CUOTA;
  if (env) {
    const partes = String(env).split(',').map(v => parseFloat(v.trim())).filter(v => Number.isFinite(v) && v >= 0);
    if (partes.length === 24) return partes;
  }
  return PESOS_HORA_DEFECTO;
}

/** Hora actual en Lima (0-23, UTC-5 sin horario de verano). */
export function horaLima(ahoraMs = Date.now()) {
  return new Date(ahoraMs - 5 * 3600 * 1000).getUTCHours();
}

/**
 * Fracción ACUMULADA del presupuesto diario que ya está disponible a esta hora.
 * Incluye la hora en curso de forma proporcional, para que el permiso crezca de
 * manera continua dentro de la hora y no a saltos.
 *
 * @param {number} [ahoraMs]
 * @returns {number} entre 0 y 1
 */
export function fraccionDisponible(ahoraMs = Date.now()) {
  const pesos = pesosHora();
  const total = pesos.reduce((a, b) => a + b, 0) || 1;
  const hora = horaLima(ahoraMs);
  const minuto = new Date(ahoraMs - 5 * 3600 * 1000).getUTCMinutes();

  let acumulado = 0;
  for (let h = 0; h < hora; h++) acumulado += pesos[h];
  // Dentro de la hora en curso se libera de forma proporcional al minuto.
  acumulado += pesos[hora] * (minuto / 60);

  return Math.min(1, acumulado / total);
}

/**
 * Presupuesto del fondo DISPONIBLE a esta hora, en número de peticiones.
 *
 * @param {number} presupuestoDiario tope diario del fondo (p. ej. 120,000)
 * @param {number} [ahoraMs]
 */
export function presupuestoDisponible(presupuestoDiario, ahoraMs = Date.now()) {
  return Math.floor(presupuestoDiario * fraccionDisponible(ahoraMs));
}

/**
 * Plan completo del día: qué porcentaje y cuántas peticiones corresponden a cada hora.
 * Sirve para mostrarlo en /api/health y para verificar el reparto de un vistazo.
 */
export function planDelDia(presupuestoDiario) {
  const pesos = pesosHora();
  const total = pesos.reduce((a, b) => a + b, 0) || 1;
  const acumulado = [];
  let suma = 0;
  for (let h = 0; h < 24; h++) {
    suma += pesos[h];
    acumulado.push({
      hora: h,
      franja: franjaDeHora(h),
      pesoPct: Math.round((pesos[h] / total) * 1000) / 10,
      acumuladoPct: Math.round((suma / total) * 1000) / 10,
      disponibleAcumulado: Math.floor(presupuestoDiario * (suma / total))
    });
  }
  return acumulado;
}
