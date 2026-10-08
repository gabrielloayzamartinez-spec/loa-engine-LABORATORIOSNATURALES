/**
 * ==============================================================================
 * LOA ENGINE - BACKFILL DE COMPRADORES vTiger -> GHL (reanudable)
 * ==============================================================================
 * POR QUÉ EXISTE:
 * El puente de ventas (`vtiger_sales_bridge`) barre por `modifiedtime` y está
 * TOPADO en 25 contactos por sede y por ciclo. Como no lleva memoria, cada ciclo
 * vuelve a tomar los MISMOS 25 más recientes: si ya estaban sincronizados, el
 * ciclo no aporta nada y el resto de la cartera (miles de compradores) nunca se
 * alcanza. Eso se veía como "no se actualiza en vivo".
 *
 * Este módulo recorre la cartera COMPLETA de compradores con un cursor
 * persistente, de modo que cada ejecución avanza y el progreso sobrevive a un
 * redeploy. Es el mismo patrón ya probado en el historial de órdenes.
 *
 * REGLAS QUE RESPETA:
 *  - SÓLO COMPRADORES (`spl_num_compras > 0`). Los leads no se mudan.
 *  - Teléfono válido obligatorio (validación NANP estricta): es la llave de fusión.
 *  - Sede-Lock: cada consulta va acotada por `cf_3451`.
 *  - Destino: subcuenta de la sede + Cuenta Empresa (si está configurada).
 * ==============================================================================
 */

import { queryVTiger } from './vtiger_api_service.js';
import { sedeClause, VTIGER_CONTACT_SELECT, VTIGER_SEDES_VALIDAS, VTIGER_FIELDS } from './vtigerClient.js';
import { sanitizeForVtigerQuery } from '../utils/sanitize.js';
import { SEDES_GATEWAY } from '../config/index.js';
import { readSecret } from '../config/secrets.js';
import { syncVtigerContactDual, pickPhone } from './dual_sync_service.js';
import { recordAuditEvent } from './audit_logger.js';
import { getStateStore } from './state/state_store.js';
import { ghlFetch, hayCuotaRealDeFondo } from '../utils/ghl_http_client.js';
import { tokenBucketQueue } from './token_bucket_queue.js';

const backfillStore = getStateStore('buyers_backfill');
const CURSOR_KEY = 'cursor_v2_desc';

// [CONTEO REAL POR SEDE] Medido en vTiger con `SELECT count(*) FROM Contacts
// WHERE spl_num_compras > 0 AND cf_3451 = '<SEDE>'` el 2026-10-05. Es la base para
// calcular lo implementado vs lo pendiente en tiempo real. Si la cartera crece,
// se recalibra con el endpoint /api/vtiger/buyers-backfill/recontar.
export const COMPRADORES_POR_SEDE = {
  PALACIOS: 36652,
  BENAVIDES: 5301,
  ROOSEVELT: 1908,
  PIURA: 603
};
export const TOTAL_COMPRADORES = Object.values(COMPRADORES_POR_SEDE).reduce((a, b) => a + b, 0);

/**
 * [CONTADOR REAL DE CONTACTOS]
 *
 * POR QUE EXISTE: el backfill reportaba `creados: 0` aunque SI estaba creando
 * contactos (medido en vivo: la cuenta de Palacios crecia +4 en 3 minutos). La
 * causa es que `creados` depende del campo `new` de la respuesta del upsert, que
 * no siempre viene, y del fallback `!existente`, que es fragil porque la busqueda
 * por telefono de GHL tiene retraso de indexacion.
 *
 * El conteo de contactos de la subcuenta es la FUENTE DE VERDAD: no depende de lo
 * que responda el upsert. Con el antes/despues se obtiene el avance real.
 *
 * @param {string} locationId
 * @returns {Promise<number|null>} total de contactos, o null si no se pudo leer
 */
export async function contarContactosGhl(locationId) {
  const sedeConf = Object.values(SEDES_GATEWAY).find(s => s?.ghl?.locationId === locationId);
  // [CUENTA EMPRESA] La Empresa NO vive en SEDES_GATEWAY: es el macro de BI, no una
  // sede. Sin este caso, el conteo de la Empresa devolvia null y el panel mostraba
  // la celda vacia. Su credencial se resuelve con las variables GHL_*_CENTRAL.
  const esEmpresa = Boolean(locationId) && locationId === readSecret('GHL_LOCATION_ID_CENTRAL');
  const apiKey = sedeConf?.ghl?.apiKey || (esEmpresa ? readSecret('GHL_API_KEY_CENTRAL') : null);
  if (!locationId || !apiKey) return null;
  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  try {
    const r = await ghlFetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=1`,
      { headers }, 1, 'Backfill-Conteo'
    );
    if (r.status !== 200) return null;
    const d = await r.json();
    const total = d?.meta?.total;
    return typeof total === 'number' ? total : null;
  } catch {
    return null;
  }
}

/** Estado del backfill de compradores (para /api/health y diagnóstico). */
export async function getBuyersBackfillStatus() {
  const estado = await backfillStore.get(CURSOR_KEY, null) || {
    completo: false,
    porSede: {},
    ultimaEjecucion: null,
    totales: { contactos: 0, creados: 0, actualizados: 0, descartados: 0, fallidos: 0 }
  };

  // [TIEMPO REAL] Enriquece cada sede con lo implementado vs lo pendiente, contra
  // el conteo real de compradores en vTiger. Asi el dashboard responde "cuanto
  // falta" en lugar de solo "cuanto llevamos".
  const porSede = {};
  let procesadosTotal = 0;
  for (const sede of VTIGER_SEDES_VALIDAS) {
    const compradoresTotal = COMPRADORES_POR_SEDE[sede] || null;
    const procesados = parseInt(estado.porSede?.[sede]?.offset || 0, 10) || 0;
    procesadosTotal += procesados;
    porSede[sede] = {
      ...(estado.porSede?.[sede] || {}),
      compradoresTotal,
      procesados,
      pendientes: compradoresTotal != null ? Math.max(compradoresTotal - procesados, 0) : null,
      pct: compradoresTotal ? Math.round((procesados / compradoresTotal) * 10000) / 100 : null
    };
  }

  return {
    ...estado,
    porSede,
    compradoresTotal: TOTAL_COMPRADORES,
    procesadosTotal,
    pendientesTotal: Math.max(TOTAL_COMPRADORES - procesadosTotal, 0),
    pctTotal: Math.round((procesadosTotal / TOTAL_COMPRADORES) * 10000) / 100,
    ritmo: calcularRitmo(estado.historial)
  };
}

/**
 * Calcula el ritmo real (contactos/hora) y el ETA a partir del historial de avance.
 *
 * [RESET-SAFE] Se suman los DELTAS POSITIVOS sede por sede en lugar de restar el
 * total. Motivo real: al reiniciar el cursor de Roosevelt y Piura (para reescribir
 * en sus subcuentas nuevas) el total BAJO de 3,826 a 2,568 y la formula anterior
 * devolvio un ritmo de -646/hora. Con deltas por sede, un reset de una sede no
 * contamina la medicion de las demas.
 */
function calcularRitmo(historial = []) {
  if (!Array.isArray(historial) || historial.length < 2) {
    return { contactosPorHora: null, etaHoras: null, etaDias: null, muestras: (historial || []).length };
  }
  const a = historial[historial.length - 2];
  const b = historial[historial.length - 1];
  const horas = (new Date(b.ts).getTime() - new Date(a.ts).getTime()) / 3600000;

  // Delta total (puede ser negativo si hubo reset) y delta por sede (solo positivos).
  const deltaTotal = (b.procesadosTotal || 0) - (a.procesadosTotal || 0);
  let deltaPositivo = 0;
  let sedesMedidas = 0;
  if (a.porSede && b.porSede) {
    for (const sede of Object.keys(b.porSede)) {
      const d = (b.porSede[sede] || 0) - (a.porSede[sede] || 0);
      if (d > 0) { deltaPositivo += d; sedesMedidas++; }
    }
  }
  // Si hubo reset (delta total negativo) se usa el avance positivo real.
  const delta = deltaTotal > 0 ? deltaTotal : deltaPositivo;

  const contactosPorHora = horas > 0 && delta > 0 ? Math.round(delta / horas) : null;
  const pendientes = Math.max(TOTAL_COMPRADORES - (b.procesadosTotal || 0), 0);
  const etaHoras = contactosPorHora ? Math.round(pendientes / contactosPorHora) : null;
  return {
    contactosPorHora,
    etaHoras,
    etaDias: etaHoras != null ? Math.round((etaHoras / 24) * 10) / 10 : null,
    muestras: historial.length,
    ultimoProcesados: b.procesadosTotal || 0,
    huboReset: deltaTotal < 0,
    sedesMedidas
  };
}

/** Reinicia el cursor para volver a recorrer toda la cartera desde cero. */
export async function resetBuyersBackfill() {
  await backfillStore.set(CURSOR_KEY, {
    completo: false,
    porSede: {},
    ultimaEjecucion: null,
    totales: { contactos: 0, creados: 0, actualizados: 0, descartados: 0, fallidos: 0 }
  });
  console.log('[Buyers Backfill] [RESET] Cursor reiniciado.');
}

/**
 * [RESET SELECTIVO] Reinicia el cursor SOLO de las sedes indicadas.
 *
 * Caso de uso real: al estrenar una subcuenta. Mientras Roosevelt y Piura no
 * tuvieron credenciales, el backfill avanzo su cursor pero solo espejo esos
 * contactos a la Empresa: la subcuenta nueva nacio vacia y el cursor ya habia
 * pasado de largo (tenian 70 y 67 contactos con el cursor en 906 y 602).
 *
 * Se reinician solo esas sedes para NO repetir el trabajo ya hecho en Palacios.
 *
 * @param {string[]} sedes nombres de sede a reiniciar
 * @returns {Promise<string[]>} sedes efectivamente reiniciadas
 */
export async function resetBuyersBackfillSede(sedes = []) {
  const pedidas = [...new Set((sedes || []).map(s => String(s).toUpperCase().trim()).filter(Boolean))]
    .filter(s => VTIGER_SEDES_VALIDAS.includes(s));
  if (pedidas.length === 0) return [];

  const estado = await getBuyersBackfillStatus();
  const reiniciadas = [];
  for (const sede of pedidas) {
    if (!estado.porSede || !(sede in estado.porSede)) continue;
    delete estado.porSede[sede];
    reiniciadas.push(sede);
  }
  if (reiniciadas.length > 0) {
    // `completo` deja de ser valido: hay sedes que deben recorrerse de nuevo.
    estado.completo = false;
    await backfillStore.set(CURSOR_KEY, estado);
    console.log(`[Buyers Backfill] [RESET SELECTIVO] Reiniciadas: ${reiniciadas.join(', ')}.`);
    recordAuditEvent({ type: 'BUYERS_BACKFILL_RESET_SEDE', severity: 'info', sedes: reiniciadas });
  }
  return reiniciadas;
}

/**
 * [DESATASCAR] Corrige el flag `completo` mal puesto que detiene el backfill.
 *
 * A diferencia de `resetBuyersBackfillSede` (que BORRA el cursor y repite todo el
 * trabajo), este SOLO baja `completo: false` y conserva el `offset`: el backfill
 * retoma EXACTAMENTE donde quedo. Es la recuperacion ante un falso `completo` por
 * un lote vacio transitorio de vTiger.
 *
 * @param {string[]} sedes nombres de sede a desatascar
 * @returns {Promise<string[]>} sedes efectivamente desatascadas
 */
export async function desatascarBackfill(sedes = []) {
  const pedidas = [...new Set((sedes || []).map(s => String(s).toUpperCase().trim()).filter(Boolean))]
    .filter(s => VTIGER_SEDES_VALIDAS.includes(s));
  if (pedidas.length === 0) return [];

  const estado = await getBuyersBackfillStatus();
  const desatascadas = [];
  for (const sede of pedidas) {
    if (estado.porSede && estado.porSede[sede]) {
      estado.porSede[sede].completo = false;
      estado.porSede[sede].vaciosConsecutivos = 0;
      desatascadas.push(sede);
    }
  }
  if (desatascadas.length > 0) {
    estado.completo = false;
    await backfillStore.set(CURSOR_KEY, estado);
    console.log(`[Buyers Backfill] [DESATASCAR] Sede(s) retomadas: ${desatascadas.join(', ')}.`);
    recordAuditEvent({ type: 'BUYERS_BACKFILL_DESATASCADO', severity: 'warn', sedes: desatascadas });
  }
  return desatascadas;
}

/**
 * Ejecuta un lote de backfill de compradores.
 *
 * @param {object} opts
 * @param {number} [opts.tamanoLote=50] contactos por sede y por lote
 * @param {number} [opts.maxLotes=1]    lotes a procesar en esta ejecución
 * @param {number} [opts.pausaMs=300]   respiro entre contactos (rate limit GHL)
 * @param {string[]} [opts.sedes]       sedes a procesar (por defecto las activas)
 * @returns {Promise<object>} resumen acumulado de la ejecución
 */
export async function runBuyersBackfill({
  tamanoLote = 50,
  maxLotes = 1,
  pausaMs = 300,
  sedes = null,
  concurrencia = null
} = {}) {
  // [LAS 4 SEDES] Se recorren TODAS las sedes presentes en vTiger (PALACIOS,
  // BENAVIDES, ROOSEVELT, PIURA), no solo las "activas". Roosevelt y Piura estan
  // en standby (sin subcuenta GHL propia), pero sus compradores DEBEN espejarse a
  // la Cuenta Empresa para que sea la copia fiel y medible de vTiger.
  const sedesSolicitadas = (sedes && sedes.length ? sedes : [...VTIGER_SEDES_VALIDAS])
    .map(s => String(s).toUpperCase())
    .filter(s => VTIGER_SEDES_VALIDAS.includes(s));

  if (sedesSolicitadas.length === 0) {
    console.warn('[Buyers Backfill] [SKIP] No hay sedes configuradas.');
    return { ok: false, reason: 'sin sedes' };
  }

  // [GUARDIAN DE CUOTA DIARIA] Se comprueba ANTES de empezar. Toda sede escribe a
  // la EMPRESA (ademas de su propia subcuenta cuando la tiene), asi que se
  // verifica el cupo de LA SEDE y de LA EMPRESA: si cualquiera se acerco a su
  // techo del dia, esa sede se excluye del ciclo. Si NINGUNA tiene cupo, el ciclo
  // se omite y se audita. GHL: 200,000/dia por location.
  //
  // [UMBRAL PESADO] El backfill es el consumidor MAS pesado (~8 llamadas por
  // contacto). Usa el umbral PESADO (80% del techo = 120,000): al alcanzarlo se
  // detiene solo y deja el resto de la cuota al trabajo EN VIVO. Antes seguia
  // consumiendo hasta el 93% y empujaba a GHL al 429, que despues frenaba a los
  // leads que escribian.
  const empresaConCupo = tokenBucketQueue.hayCupoPesado('EMPRESA') && hayCuotaRealDeFondo('EMPRESA');
  const sedesObjetivo = sedesSolicitadas.filter(s =>
    tokenBucketQueue.hayCupoPesado(s) && hayCuotaRealDeFondo(s) && empresaConCupo
  );
  if (sedesObjetivo.length === 0) {
    const cuota = tokenBucketQueue.getCuotaDiaria();
    recordAuditEvent({
      type: 'BUYERS_BACKFILL_QUOTA_PAUSED',
      severity: 'warn',
      message: 'Cuota diaria agotada en todas las sedes objetivo o en la Empresa: ciclo omitido para proteger la atencion en vivo.',
      cuota
    });
    console.warn('[Buyers Backfill] [CUOTA] Techo diario alcanzado: ciclo omitido.');
    return { ok: false, reason: 'cuota diaria agotada', sedes: sedesSolicitadas, cuota };
  }

  const estado = await getBuyersBackfillStatus();
  const inicio = Date.now();

  // [AUTO-RECUPERACION] Un falso `completo` se corrige SOLO, sin intervencion humana.
  // Si una sede figura completa pero su offset es MENOR que el total de compradores,
  // es un lote vacio transitorio mal interpretado (el defecto que detuvo Palacios en
  // el 12.86%). Se baja el flag para que el scheduler la retome en el proximo ciclo.
  {
    let autoSanado = 0;
    for (const sede of VTIGER_SEDES_VALIDAS) {
      const porSede = estado.porSede?.[sede];
      const total = COMPRADORES_POR_SEDE[sede];
      if (!porSede || !total) continue;
      if (porSede.completo && (parseInt(porSede.offset, 10) || 0) < total) {
        porSede.completo = false;
        porSede.vaciosConsecutivos = 0;
        autoSanado++;
        recordAuditEvent({ type: 'BUYERS_BACKFILL_AUTO_DESATASCADO', severity: 'warn', sede, offset: porSede.offset, total });
        console.warn(`[Buyers Backfill] [AUTO-HEAL] ${sede} figura completa con offset ${porSede.offset}/${total}: flag corregido solo.`);
      }
    }
    if (autoSanado > 0) {
      estado.completo = false;
      await backfillStore.set(CURSOR_KEY, estado);
    }
  }
  const resumen = { lotes: 0, contactos: 0, creados: 0, actualizados: 0, descartados: 0, fallidos: 0, porSede: {} };
  const limite = Math.min(Math.max(parseInt(tamanoLote, 10) || 50, 1), 150);

  // [CONTADOR REAL] Foto inicial de contactos por sede. El campo `new` del upsert
  // no es fiable (ver contarContactosGhl), asi que el avance se mide por diferencia
  // de conteo: es la unica cifra que refleja la realidad.
  const conteoAntes = {};
  for (const sede of sedesObjetivo) {
    const loc = SEDES_GATEWAY[sede]?.ghl?.locationId;
    if (loc) conteoAntes[sede] = await contarContactosGhl(loc);
  }

  for (let lote = 0; lote < Math.min(Math.max(parseInt(maxLotes, 10) || 1, 1), 20); lote++) {
    let procesadosEnLote = 0;

    // ========================================================================
    // [PARALELIZACION POR SEDE] Las sedes se procesan EN PARALELO.
    //
    // La cuota de GHL es "per app PER RESOURCE": cada location tiene su propio
    // presupuesto de 100 requests / 10 s, independiente de las demas. Antes este
    // bucle era secuencial, asi que Benavides esperaba a que Palacios terminara su
    // lote aunque tuviera su propia cuota sin usar. Medido: 1.61x mas rapido.
    //
    // Cada sede conserva SU PROPIO cursor y se consolida al final, asi que un fallo
    // en una sede no afecta el avance de la otra.
    // ========================================================================
    const resultadosSede = await Promise.all(sedesObjetivo.map(async (sede) => {
      const cursorSede = estado.porSede?.[sede] || {};
      const ultimoId = cursorSede.ultimoId || null;
      const offset = cursorSede.offset || 0;

      // ======================================================================
      // PAGINACION POR KEYSET, NO POR OFFSET — EN ORDEN DESCENDENTE.
      //
      // [PRIORIDAD: DATOS RECIENTES PRIMERO] Se recorre `ORDER BY id DESC`: los
      // compradores MAS RECIENTES (los de ayer, los de esta semana) se sincronizan
      // PRIMERO, de modo que al entrar a una sede se ven las ventas recientes de
      // inmediato. El backlog historico (compradores viejos) se rellena despues.
      //
      // Keyset descendente: `WHERE id < ultimoId ORDER BY id DESC LIMIT n`.
      // El cursor vivo es `cursor_v2_desc` (clave distinta): el cursor viejo
      // ascendente se abandona, asi que no hay mezcla de direcciones.
      // ======================================================================
      // [PRIORIDAD PALACIOS] La sede principal (mayor cartera) recibe el DOBLE de
      // ancho de banda por ciclo: se sincroniza mas rapido que el resto, respetando
      // el tope de 150 contactos por lote que impone vTiger (100-row cap).
      const limiteSede = sede === 'PALACIOS' ? Math.min(limite * 2, 150) : limite;
      const filtroCursor = ultimoId
        ? ` AND id < '${sanitizeForVtigerQuery(String(ultimoId), 20)}'`
        : '';
      const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.NUM_COMPRAS} > 0${sedeClause(sede)}${filtroCursor} ORDER BY id DESC LIMIT ${limiteSede};`;

      let contactos = [];
      try {
        // TIMEOUT AMPLIADO PARA EL RECORRIDO MASIVO. Se registraron 8 fallos
        // criticos VTIGER_QUERY_FAILED ("This operation was aborted"): vTiger
        // respondio lento de forma transitoria y los 3 intentos de 12 s no
        // alcanzaron. El backfill avanza por cursor, asi que una respuesta lenta NO
        // debe abortar el trabajo: puede esperar mas.
        contactos = await queryVTiger(q, sede, { timeoutMs: 30000, maxAttempts: 5 });
      } catch (err) {
        console.error(`[Buyers Backfill] [ERROR] Consulta fallida en ${sede}: ${err.message}`);
        recordAuditEvent({
          type: 'BUYERS_BACKFILL_QUERY_FAILED',
          severity: 'error',
          sede,
          message: err.message,
          ultimoId: ultimoId || null,
          offset
        });
        return { sede, leidos: 0, creados: 0, actualizados: 0, descartados: 0, fallidos: 1, cursor: cursorSede, completo: false };
      }

      if (contactos.length === 0) {
        // [DEFECTO CORREGIDO] Antes un lote vacio marcaba `completo: true` DE INMEDIATO.
        // Pero vTiger puede devolver 0 filas de forma TRANSITORIA (saturacion, timeout
        // silencioso): un solo vacio no es prueba de que la cartera termino. Ese falso
        // `completo` dejaba el backfill PARADO en el 12.86% (Palacios), sin retomar.
        // Ahora se exigen 3 vacios CONSECUTIVOS antes de declarar la cartera completa.
        const vacios = parseInt(cursorSede?.vaciosConsecutivos || 0, 10) + 1;
        const esCompleto = vacios >= 3;
        console.log(`[Buyers Backfill] [${sede}] Lote vacio (vacio #${vacios}${esCompleto ? ' -> COMPLETA' : ' -> reintentara'}).`);
        if (vacios === 1) {
          recordAuditEvent({ type: 'BUYERS_BACKFILL_EMPTY_BATCH', severity: 'warn', sede, ultimoId: ultimoId || null, offset, vacios });
        }
        return {
          sede, leidos: 0, creados: 0, actualizados: 0, descartados: 0, fallidos: 0,
          cursor: { ...cursorSede, offset, completo: esCompleto, vaciosConsecutivos: vacios, ultimaEjecucion: new Date().toISOString() },
          completo: esCompleto
        };
      }

      const conteoSede = { sede, leidos: contactos.length, creados: 0, actualizados: 0, descartados: 0, fallidos: 0 };

      // ======================================================================
      // [PARALELIZACION ACOTADA — 100% DE EXITO]
      //
      // Antes los contactos se procesaban UNO a uno (secuencial): cada contacto
      // esperaba ~60 s (la mayor parte por vTiger). Eso daba ~60 contactos/hora.
      //
      // Ahora se procesan en GRUPOS de `concurrencia` contactos a la vez. La
      // ganancia viene de que vTiger (el cuello) atiende varias consultas en
      // paralelo dentro del gate (VTIGER_MAX_CONCURRENT). El manejo de errores es
      // POR CONTACTO: si uno falla, se cuenta y se sigue con el resto — el lote
      // nunca se rompe, y el 100% de exito se mide contactos-ok sobre totales.
      //
      // Concurrencia por defecto 3 (configurable con VTIGER_BACKFILL_CONCURRENCY):
      //   - 1 = secuencial (el comportamiento anterior)
      //   - 3 = ~3x mas rapido sin saturar vTiger
      //   - 5 = agresivo (solo si vTiger aguanta, monitorear 190)
      // ======================================================================
      // [MULTISISTEMATICO] La concurrencia la puede fijar el scheduler por ciclo
      // (p. ej. mas alta de madrugada). Si no viene, se usa la variable de entorno
      // VTIGER_BACKFILL_CONCURRENCY y, en ultimo caso, 3.
      const CONCURRENCIA = Math.min(
        Math.max(parseInt(concurrencia ?? process.env.VTIGER_BACKFILL_CONCURRENCY ?? '3', 10) || 3, 1),
        8
      );

      // [TIMEOUT POR CONTACTO — DEFECTO CORREGIDO]
      // DEFECTO REAL EN PRODUCCION: un contacto se quedo colgado (alguna llamada a
      // GHL/vTiger que nunca resolvio). Como el grupo se espera con Promise.all, el
      // lote NUNCA cerro, `runBuyersBackfill` nunca resolvio, y la guarda
      // `buyersBackfillCorriendo` del scheduler quedo TRABADA en true: durante 30
      // horas el backfill no volvio a ejecutarse (el scheduler se saltaba cada
      // disparo). El motor seguia vivo, pero el trabajo de fondo estaba muerto.
      //
      // Ahora cada contacto tiene un tope de tiempo. Si se pasa, se cuenta como
      // fallido y el lote CONTINUA: un contacto problematico ya no puede detener la
      // carga completa.
      const TIMEOUT_CONTACTO_MS = Math.min(Math.max(parseInt(process.env.BACKFILL_TIMEOUT_CONTACTO_MS || '120000', 10) || 120000, 15000), 600000);

      // [DEADLINE DE CICLO — BLINDAJE CONTRA ESTANCAMIENTOS]
      // DEFECTO REAL EN PRODUCCION: un lote lento (cada contacto puede quemar hasta
      // 120 s entre reintentos de GHL y del historial de ordenes) tarda ~34 min.
      // Mientras ese lote no cierra, `buyersBackfillCorriendo` sigue en true y el
      // scheduler se salta TODOS los disparos: el trabajo de 2do nivel queda muerto
      // en silencio hasta el proximo redeploy (caso observado: 20:06 -> 21:26 sin
      // avanzar; 126 contactos sincronizados y 107 timeouts sin que el cursor se
      // moviera ni una vez).
      //
      // Ahora el ciclo tiene un tope de tiempo. Al vencer, se CORTA el lote de forma
      // ORDENADA: se persiste el avance REAL (solo los contactos ya procesados) y el
      // ciclo siguiente retoma exactamente donde quedo. La clave: el cursor AVANZA
      // AUNQUE el lote no termine, asi que el 2do nivel nunca mas se ve congelado.
      //
      // Se deja en 55 min (>34 min que tarda un lote normal) para NO cortar ciclos
      // sanos: solo actua como red de seguridad ante un lote patologico.
      const MAX_CICLO_MS = Math.min(Math.max(parseInt(process.env.BACKFILL_MAX_CICLO_MS || '3300000', 10) || 3300000, 60000), 3600000);
      const deadlineCiclo = Date.now() + MAX_CICLO_MS;

      const procesarUno = async (vContact) => {
        let temporizador = null;
        try {
          const r = await Promise.race([
            syncVtigerContactDual(vContact),
            new Promise((resolve) => {
              temporizador = setTimeout(
                () => resolve({ __timeout: true }),
                TIMEOUT_CONTACTO_MS
              );
            })
          ]);
          if (r && r.__timeout) {
            recordAuditEvent({ type: 'BUYERS_BACKFILL_CONTACT_TIMEOUT', severity: 'warn', sede, vTigerId: vContact?.id, timeoutMs: TIMEOUT_CONTACTO_MS });
            return { ok: false, skipped: false, created: false, fallido: true };
          }
          return { ok: r.ok, skipped: r.skipped, created: r.created, fallido: false };
        } catch (err) {
          recordAuditEvent({ type: 'BUYERS_BACKFILL_CONTACT_FAIL', severity: 'warn', sede, vTigerId: vContact?.id, message: err.message });
          return { ok: false, skipped: false, created: false, fallido: true };
        } finally {
          if (temporizador) clearTimeout(temporizador);
        }
      };

      let procesadosLote = 0;
      let ultimoIdLote = ultimoId;
      for (let i = 0; i < contactos.length; i += CONCURRENCIA) {
        // Se exige al menos UN grupo por ciclo (si no, el offset no avanzaria y el
        // ciclo se repetiria infinitamente sobre el mismo lote).
        if (i > 0 && Date.now() > deadlineCiclo) {
          console.warn(`[Buyers Backfill] [${sede}] Deadline de ciclo alcanzado: ${procesadosLote}/${contactos.length} procesados. Avance persistido; el proximo ciclo retoma aqui.`);
          recordAuditEvent({
            type: 'BUYERS_BACKFILL_CICLO_ACOTADO',
            severity: 'warn',
            sede,
            procesados: procesadosLote,
            tamanoLote: contactos.length,
            maxCicloMs: MAX_CICLO_MS,
            reason: 'lote lento: se corta ordenadamente para no trabar la guarda'
          });
          break;
        }
        const grupo = contactos.slice(i, i + CONCURRENCIA);
        const resultados = await Promise.all(grupo.map(procesarUno));
        for (const r of resultados) {
          if (r.fallido) conteoSede.fallidos++;
          else if (r.skipped) conteoSede.descartados++;
          else if (r.ok) { if (r.created) conteoSede.creados++; else conteoSede.actualizados++; }
          else conteoSede.fallidos++;
        }
        procesadosLote = Math.min(i + grupo.length, contactos.length);
        ultimoIdLote = grupo[grupo.length - 1]?.id || ultimoIdLote;
        if (pausaMs > 0) await new Promise(res => setTimeout(res, pausaMs));
      }

      // [AVANCE REAL] El cursor avanza SOLO por los contactos efectivamente
      // procesados: si el deadline corto el lote, el proximo ciclo retoma en el
      // contacto exacto donde quedo (cero saltos, cero repeticiones).
      const nuevoUltimoId = ultimoIdLote;
      console.log(`[Buyers Backfill] [${sede}] ${JSON.stringify(conteoSede)} (cursor id -> ${nuevoUltimoId}, total leidos ${offset + procesadosLote}, concurrencia ${CONCURRENCIA})`);

      return {
        sede,
        leidos: conteoSede.leidos,
        creados: conteoSede.creados,
        actualizados: conteoSede.actualizados,
        descartados: conteoSede.descartados,
        fallidos: conteoSede.fallidos,
        cursor: {
          ultimoId: nuevoUltimoId,
          offset: offset + procesadosLote,
          ultimaEjecucion: new Date().toISOString(),
          ultimoLote: procesadosLote,
          // Un lote con contactos restablece el contador de vacios: hay trabajo real.
          completo: false,
          vaciosConsecutivos: 0
        },
        completo: false
      };
    }));

    // Consolidacion: cada sede aporta su cursor y sus conteos.
    for (const r of resultadosSede) {
      estado.porSede[r.sede] = r.cursor;
      resumen.porSede[r.sede] = {
        sede: r.sede, leidos: r.leidos, creados: r.creados,
        actualizados: r.actualizados, descartados: r.descartados, fallidos: r.fallidos
      };
      resumen.contactos += r.leidos;
      resumen.creados += r.creados;
      resumen.actualizados += r.actualizados;
      resumen.descartados += r.descartados;
      resumen.fallidos += r.fallidos;
      procesadosEnLote += r.leidos;
    }

    resumen.lotes++;

    // El cursor se persiste tras CADA lote: un redeploy no reinicia el trabajo.
    estado.ultimaEjecucion = new Date().toISOString();
    estado.totales = {
      contactos: (estado.totales?.contactos || 0) + resumen.contactos,
      creados: (estado.totales?.creados || 0) + resumen.creados,
      actualizados: (estado.totales?.actualizados || 0) + resumen.actualizados,
      descartados: (estado.totales?.descartados || 0) + resumen.descartados,
      fallidos: (estado.totales?.fallidos || 0) + resumen.fallidos
    };
    estado.completo = sedesObjetivo.every(s => estado.porSede?.[s]?.completo);

    // [HISTORIAL DE AVANCE] Se guarda una foto (timestamp + procesados totales +
    // detalle por sede) tras cada lote para poder CALCULAR EL RITMO real y el ETA.
    // El detalle por sede permite medir el avance aunque una sede se reinicie.
    // Se conservan las ultimas 30 fotos (suficiente para una ventana estable).
    const porSedeSnapshot = {};
    let procesadosSnapshot = 0;
    for (const s of VTIGER_SEDES_VALIDAS) {
      const n = parseInt(estado.porSede?.[s]?.offset || 0, 10) || 0;
      porSedeSnapshot[s] = n;
      procesadosSnapshot += n;
    }
    estado.historial = [...(estado.historial || []).slice(-29), {
      ts: new Date().toISOString(),
      procesadosTotal: procesadosSnapshot,
      porSede: porSedeSnapshot
    }];

    await backfillStore.set(CURSOR_KEY, estado);

    if (procesadosEnLote === 0) break; // nada más que recorrer
  }

  // [CONTADOR REAL] Foto final y calculo del avance verdadero por sede.
  const conteoDespues = {};
  const creadosReales = {};
  let totalCreadosReales = 0;
  for (const sede of sedesObjetivo) {
    const loc = SEDES_GATEWAY[sede]?.ghl?.locationId;
    if (!loc) continue;
    const n = await contarContactosGhl(loc);
    conteoDespues[sede] = n;
    if (typeof n === 'number' && typeof conteoAntes[sede] === 'number') {
      const delta = n - conteoAntes[sede];
      creadosReales[sede] = delta;
      if (delta > 0) totalCreadosReales += delta;
    }
  }
  estado.contactosGhl = conteoDespues;
  estado.creadosReales = creadosReales;
  await backfillStore.set(CURSOR_KEY, estado);

  resumen.contactosGhl = conteoDespues;
  resumen.creadosReales = creadosReales;
  resumen.ms = Date.now() - inicio;
  resumen.completo = estado.completo;
  recordAuditEvent({ type: 'BUYERS_BACKFILL_CYCLE', severity: resumen.fallidos > 0 ? 'warn' : 'info', ...resumen });
  console.log(`[Buyers Backfill] [DONE] ${JSON.stringify({ ...resumen, porSede: undefined })}`);
  return resumen;
}
