/**
 * ==============================================================================
 * AUDITORÍA TÉCNICA Y DE FUNCIONES — SALUD DEL MOTOR, NO DE LOS DATOS
 * ==============================================================================
 * CRÍTICA DEL USUARIO (justa)
 * "Te pedí numerosas veces auditar el trabajo considerando aspectos técnicos y de
 * funciones." Las auditorías existentes revisaban la EXACTITUD DE LOS DATOS (campos
 * comerciales, ruteo por página, atribución del Ad ID). NINGUNA revisaba la SALUD DE
 * LAS FUNCIONES: cuánto cuesta cada proceso, si un proceso se repite más de lo
 * debido, o si algún bucle consume la cuota. Por ese hueco pasó inadvertido un bucle
 * infinito que reprocesaba los mismos contactos cada 5 s y consumía ~13,300
 * llamadas/hora, agotando la cuota de Palacios.
 *
 * QUÉ AUDITA ESTA HERRAMIENTA (por función, no por dato)
 *   1. CONSUMO POR PROCESO ....... quién gasta la cuota y a qué velocidad (llamadas/h)
 *   2. BUCLES / REPROCESOS ....... contactos ruteados de más en la última hora
 *   3. COSTO UNITARIO ............ llamadas reales que cuesta atender un contacto
 *   4. CUOTA REAL ................ lo que GHL dice que queda, por subcuenta
 *   5. PRESUPUESTO DEL FONDO ..... cuánto gastó el nivel 2 contra su tope
 *   6. EFICIENCIA DEL NIVEL 1 .... qué porcentaje de los ruteos fue trabajo útil
 *   7. VEREDICTOS ................ alertas concretas con su causa
 *
 * Es SOLO LECTURA: no modifica nada.
 * ==============================================================================
 */

import { getConsumoPorServicio, getGhlRateState, getPresupuestoFondo, getRepartoCuota } from '../utils/ghl_http_client.js';
import { getCostoRuteo, getReprocesos } from '../agents/chat_router_agent.js';

// Muestra anterior para calcular VELOCIDADES (llamadas/hora). La primera llamada
// sólo devuelve totales; a partir de la segunda ya hay una tasa real medida.
let muestraPrevia = null;

/** Servicios que pertenecen al NIVEL 1 (atención en vivo de un lead). */
const SERVICIOS_NIVEL_1 = ['Agente 3', 'Router', 'Radar', 'Webhook-Meta'];
/** Servicios que pertenecen al NIVEL 2 (trabajo de fondo). */
const SERVICIOS_NIVEL_2 = ['Dual Sync', 'Order History', 'Backfill-Conteo', 'Reverse Sync', 'Curador-Purga', 'Curador-BACKFILL'];

function clasificar(servicio) {
  if (SERVICIOS_NIVEL_1.some(s => servicio.startsWith(s))) return 'NIVEL_1';
  if (SERVICIOS_NIVEL_2.some(s => servicio.startsWith(s))) return 'NIVEL_2';
  // Los curadores por sede y el resto son fondo.
  return servicio.startsWith('Curador') || servicio.includes('Backfill') ? 'NIVEL_2' : 'OTRO';
}

/**
 * Ejecuta la auditoría técnica completa.
 * @param {object} [opts]
 * @param {number} [opts.umbralBucle=3] ruteos por contacto que se considera excesivo
 */
export async function auditarTecnico({ umbralBucle = 3 } = {}) {
  const ahora = Date.now();
  const consumo = getConsumoPorServicio();
  const reprocesos = getReprocesos(umbralBucle);
  const costo = getCostoRuteo();
  const cuota = getGhlRateState();
  const presupuesto = getPresupuestoFondo();
  const reparto = getRepartoCuota('PALACIOS');

  // ---- Velocidad por servicio (requiere dos lecturas separadas en el tiempo) ----
  const velocidades = [];
  if (muestraPrevia) {
    const segundos = Math.max((ahora - muestraPrevia.ts) / 1000, 1);
    for (const [servicio, valor] of Object.entries(consumo.porServicio || {})) {
      const antes = muestraPrevia.porServicio[servicio] || 0;
      const delta = valor - antes;
      velocidades.push({
        servicio,
        nivel: clasificar(servicio),
        llamadas: valor,
        deltaVentana: delta,
        porHora: Math.round((delta / segundos) * 3600)
      });
    }
  }

  const totalLlamadas = consumo.total || 0;
  const nivel1 = Object.entries(consumo.porServicio || {})
    .filter(([s]) => clasificar(s) === 'NIVEL_1')
    .reduce((a, [, v]) => a + v, 0);
  const nivel2 = Object.entries(consumo.porServicio || {})
    .filter(([s]) => clasificar(s) === 'NIVEL_2')
    .reduce((a, [, v]) => a + v, 0);

  const tasaTotalHora = velocidades.reduce((a, v) => a + v.porHora, 0);

  // ---- Alertas técnicas con su causa ----
  const alertas = [];

  if (reprocesos.contactosEnBucle > 0) {
    alertas.push({
      nivel: reprocesos.desperdicioPct > 50 ? 'CRITICO' : 'ALTO',
      codigo: 'BUCLE_DE_REPROCESO',
      mensaje: `${reprocesos.contactosEnBucle} contactos se rutearon ${umbralBucle}+ veces en la última hora (desperdicio ${reprocesos.desperdicioPct}%).`,
      causa: 'Un proceso vuelve a marcar el contacto como "nuevo" (típicamente porque NUESTRA propia escritura actualiza el campo que se usa para comparar).'
    });
  }

  if (costo.promedio && costo.promedio > 12) {
    alertas.push({
      nivel: 'MEDIO',
      codigo: 'COSTO_UNITARIO_ALTO',
      mensaje: `Atender un contacto cuesta ${costo.promedio} llamadas (lo normal es 6-9).`,
      causa: 'Reintentos, búsquedas por nombre que no resuelven, o conversaciones con muchas páginas de mensajes.'
    });
  }

  if (tasaTotalHora > 6000) {
    alertas.push({
      nivel: tasaTotalHora > 12000 ? 'CRITICO' : 'ALTO',
      codigo: 'CONSUMO_EXCESIVO',
      mensaje: `El motor consume ~${tasaTotalHora} llamadas/hora. A ese ritmo agota 200,000 en ${Math.max(1, Math.round(200000 / Math.max(tasaTotalHora, 1)))} h.`,
      causa: 'Bucle de reproceso, exceso de procesos de fondo, o ambos.'
    });
  }

  for (const [sede, st] of Object.entries(cuota)) {
    if (Number.isFinite(st.dailyRemaining) && st.dailyRemaining === 0) {
      alertas.push({
        nivel: 'CRITICO',
        codigo: 'CUOTA_AGOTADA',
        mensaje: `La subcuenta ${sede} está en 0 peticiones: su atención en vivo no puede trabajar.`,
        causa: 'Consumo excesivo previo. La cuota se libera de forma progresiva (ventana móvil de 24 h).'
      });
    }
  }

  for (const [sede, p] of Object.entries(presupuesto)) {
    if (p.presupuesto > 0 && p.consumidas >= p.presupuesto) {
      alertas.push({
        nivel: 'INFO',
        codigo: 'FONDO_EN_TOPE',
        mensaje: `El trabajo de fondo de ${sede} agotó su presupuesto diario (${p.consumidas}/${p.presupuesto}).`,
        causa: 'Comportamiento esperado: protege la reserva del nivel 1.'
      });
    }
  }

  if (alertas.length === 0) {
    alertas.push({ nivel: 'OK', codigo: 'SIN_HALLAZGOS', mensaje: 'No se detectaron problemas técnicos en las funciones auditadas.', causa: '' });
  }

  // ---- Veredicto global ----
  const criticas = alertas.filter(a => a.nivel === 'CRITICO').length;
  const altas = alertas.filter(a => a.nivel === 'ALTO').length;
  const salud = criticas > 0 ? '🔴 CRITICO' : (altas > 0 ? '🟠 ATENCION' : (alertas[0].nivel === 'MEDIO' ? '🟡 ACEPTABLE' : '🟢 SANO'));

  // Guardar la muestra para la próxima medición de velocidad.
  muestraPrevia = { ts: ahora, porServicio: { ...(consumo.porServicio || {}) }, total: totalLlamadas };

  return {
    ok: true,
    ts: new Date(ahora).toISOString(),
    saludTecnica: salud,
    alertas,
    // 1. Consumo por proceso
    consumoPorProceso: velocidades.sort((a, b) => b.porHora - a.porHora),
    resumenConsumo: {
      total: totalLlamadas,
      nivel1: { llamadas: nivel1, pct: totalLlamadas ? Math.round((nivel1 / totalLlamadas) * 1000) / 10 : 0 },
      nivel2: { llamadas: nivel2, pct: totalLlamadas ? Math.round((nivel2 / totalLlamadas) * 1000) / 10 : 0 },
      tasaTotalPorHora: velocidades.length ? tasaTotalHora : null,
      notaVelocidad: velocidades.length ? 'Tasa medida entre esta lectura y la anterior.' : 'Primera lectura: vuelve a llamar en 1-2 minutos para obtener velocidades.'
    },
    // 2. Bucles
    bucles: reprocesos,
    // 3. Costo unitario
    costoNivel1: costo,
    // 4. Cuota real
    cuotaReal: cuota,
    // 5. Presupuesto del fondo
    presupuestoFondo: presupuesto,
    // 6. Reparto horario vigente
    repartoHorario: { hora: reparto.hora, franja: reparto.franja, liberadoDelDiaPct: reparto.liberadoDelDiaPct, disponibleHastaAhora: reparto.disponibleHastaAhora }
  };
}
