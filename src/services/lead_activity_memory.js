/**
 * ==============================================================================
 * MEMORIA DE ACTIVIDAD DEL LEAD — EL ARMONIZADOR
 * ==============================================================================
 * EL PROBLEMA (medido en producción)
 * Cinco procesos distintos llaman al router del nivel 1 sobre el MISMO universo de
 * contactos (PALACIOS y BENAVIDES):
 *
 *   · Radar ......................... cada 5 s
 *   · Curador forward ............... cada 25 s
 *   · Guardián de bandejas .......... cada 60 s
 *   · Trabajo del día ............... cada 10 min
 *   · Webhook ....................... por evento
 *
 * Cada uno tenía su PROPIA memoria (o ninguna), así que el mismo lead se atendía
 * varias veces: se midió un desperdicio del 61% y ~13,000-16,000 llamadas/hora. Y
 * peor: los procesos de nivel 2 (backfill, sales bridge, reverse sync) ESCRIBEN los
 * contactos, lo que mueve su `date_updated`, y el curador forward —que selecciona
 * justo por ese campo— los volvía a rutear. El nivel 2 disparaba el gasto del nivel 1.
 *
 * LA SOLUCIÓN: UNA SOLA VERDAD
 * Un único registro compartido de "hasta qué MENSAJE atendí a cada contacto". Se
 * consulta en el router (el punto por el que pasan TODOS los caminos) y se marca
 * después de atenderlo. Da igual cuántos procesos lo pidan:
 *
 *     un mensaje del lead = una sola atención, sin importar quién la pida.
 *
 * Es la señal correcta porque la fecha del último mensaje SOLO cambia cuando el lead
 * escribe: ninguna escritura interna (backfill, curación, asignación) la mueve.
 *
 * Se persiste para sobrevivir a los reinicios (un despliegue no debe re-atender todo).
 * ==============================================================================
 */

import { getStateStore } from './state/state_store.js';

const store = getStateStore('actividad_leads');
const CLAVE = 'atendidos_v1';
const TTL_MS = 48 * 60 * 60 * 1000;     // 48 h, igual que la ventana del radar
const MAX_ENTRADAS = 20000;
// Ventana de gracia para contactos SIN fecha de mensaje (formularios, SMS, o
// contactos que solo aparecen porque el nivel 2 los escribió). Evita re-atenderlos
// en cada ciclo. Configurable con GHL_VENTANA_SIN_MENSAJE_HORAS.
const VENTANA_SIN_MENSAJE_MS = Math.max(
  (parseInt(process.env.GHL_VENTANA_SIN_MENSAJE_HORAS || '12', 10) || 12) * 60 * 60 * 1000,
  30 * 60 * 1000
);

/** contactId -> { mensajeMs, atendidoEn } */
const memoria = new Map();
let cargada = false;

/** Carga la memoria persistida (se llama al arrancar). */
export async function cargarMemoriaActividad() {
  try {
    const guardado = await store.get(CLAVE, null);
    if (guardado && typeof guardado === 'object') {
      const corte = Date.now() - TTL_MS;
      let n = 0;
      for (const [id, reg] of Object.entries(guardado)) {
        if (reg && Number(reg.atendidoEn) >= corte) {
          memoria.set(id, { mensajeMs: Number(reg.mensajeMs) || 0, atendidoEn: Number(reg.atendidoEn) });
          n++;
        }
      }
      console.log(`[Armonizador] Memoria de actividad cargada: ${n} leads ya atendidos (un reinicio NO los repite).`);
    }
  } catch (err) {
    console.warn(`[Armonizador] No se pudo cargar la memoria: ${err.message}`);
  } finally {
    cargada = true;
  }
}

/** Persiste la memoria (acotada por TTL y por tamaño). */
export async function persistirMemoriaActividad() {
  try {
    const corte = Date.now() - TTL_MS;
    const entradas = [...memoria.entries()]
      .filter(([, r]) => r.atendidoEn >= corte)
      .sort((a, b) => b[1].atendidoEn - a[1].atendidoEn)
      .slice(0, MAX_ENTRADAS);
    await store.set(CLAVE, Object.fromEntries(entradas));
  } catch (err) {
    console.warn(`[Armonizador] No se pudo persistir: ${err.message}`);
  }
}

/**
 * ¿Ya se atendió este mensaje (o uno más nuevo) de este contacto?
 *
 * DOS CASOS:
 *  · CON fecha de mensaje: se compara contra la marca. Un mensaje posterior al
 *    último atendido se atiende; el mismo mensaje (o uno anterior) no.
 *  · SIN fecha de mensaje (un formulario, un SMS, o un contacto que el nivel 2
 *    acaba de escribir y por eso aparece en la lista por `date_updated`): se usa una
 *    VENTANA DE GRACIA desde la última atención.
 *
 * EL SEGUNDO CASO ERA EL RESIDUO MEDIDO: los contactos sin mensaje se marcaban con
 * fecha 0, y la comparación `0 <= 0` nunca bloqueaba nada, así que volvían a
 * atenderse en CADA ciclo (medido: 2,320 ruteos/hora para ~40 mensajes reales).
 *
 * @param {string} contactId
 * @param {number} mensajeMs fecha del último mensaje del lead (ms). 0 si no hay.
 */
export function yaAtendido(contactId, mensajeMs) {
  if (!contactId) return false;
  const reg = memoria.get(contactId);
  if (!reg) return false;

  if (Number.isFinite(mensajeMs) && mensajeMs > 0) {
    return mensajeMs <= reg.mensajeMs;
  }
  // Sin evidencia de mensaje: ventana de gracia (por defecto 12 h).
  return (Date.now() - reg.atendidoEn) <= VENTANA_SIN_MENSAJE_MS;
}

/**
 * Marca que se atendió al contacto.
 * Solo avanza: una fecha de mensaje más antigua nunca retrocede la marca.
 */
export function marcarAtendido(contactId, mensajeMs) {
  if (!contactId) return;
  const ahora = Date.now();
  const reg = memoria.get(contactId);
  const nuevoMs = Math.max(Number(mensajeMs) || 0, reg?.mensajeMs || 0);
  // `atendidoEn` SIEMPRE se refresca: es lo que sostiene la ventana de gracia para
  // los contactos que no traen fecha de mensaje.
  memoria.set(contactId, { mensajeMs: nuevoMs, atendidoEn: ahora });

  // Poda oportunista.
  if (memoria.size > MAX_ENTRADAS * 1.5) {
    const corte = ahora - TTL_MS;
    for (const [id, r] of memoria) if (r.atendidoEn < corte) memoria.delete(id);
  }
}

/** Estadísticas para /api/health y la auditoría técnica. */
export function getEstadoMemoriaActividad() {
  const ahora = Date.now();
  let vigentes = 0;
  for (const r of memoria.values()) if ((ahora - r.atendidoEn) <= TTL_MS) vigentes++;
  return { cargada, leadsEnMemoria: vigentes, totalEntradas: memoria.size };
}
