import crypto from 'crypto';
import { VTIGER_CONFIG, resolveSedeContext, getActiveSedes } from '../config/index.js';
import { normalizeTreatment } from '../domain/clinical_vocabulary.js';
import { learningBrain } from './learning_brain.js';
import { query as vtigerQuery, login as vtigerLogin, VTIGER_FIELDS, VTIGER_CONTACT_SELECT, VTIGER_SEDES_VALIDAS, sedeClause } from './vtigerClient.js';
import { sanitizeForVtigerQuery, digitsOnly } from '../utils/sanitize.js';
import { recordAuditEvent } from './audit_logger.js';

// [AUTENTICACIÓN CENTRALIZADA] Una sola sesión de Administrador global.
// El aislamiento multi-sede lo garantiza el campo nativo `cf_3451` en cada
// consulta, no credenciales separadas.
export async function checkVTigerHealth() {
  try {
    await vtigerLogin();
    return { status: 'OK' };
  } catch (e) {
    return { status: 'ERROR', message: e.message };
  }
}

/** Compatibilidad: el login del cliente centralizado (cuenta Admin global). */
export async function loginToVTiger() {
  return vtigerLogin();
}

/**
 * Ejecuta una consulta en vTiger con REINTENTOS SEGUROS (3 intentos, backoff
 * exponencial con jitter) delegando en el cliente centralizado `vtigerClient.js`.
 *
 * [SEDE-LOCK] `allowAggregate` sólo se habilita para el aprendizaje agregado
 * (patrones de campaña ↔ tratamiento). NUNCA para datos que se propaguen a GHL.
 *
 * @param {string} queryStr
 * @param {string} [sede] etiqueta de sede para el log de auditoría
 * @param {object} [options] `{ allowAggregate }`
 */
export async function queryVTiger(queryStr, sede = '', options = {}) {
  return vtigerQuery(queryStr, {
    context: `vtiger_api_service${sede ? `:${String(sede).toUpperCase()}` : ''}`,
    ...options
  });
}

/**
 * Sanitizado de valores para consultas vTiger.
 * Se importa la implementación endurecida de `src/utils/sanitize.js` (cubre
 * comillas, barras invertidas, controles, terminadores de sentencia y longitud).
 */

/**
 * ==============================================================================
 * [SEDE-LOCK] GUARDA DE SEDE ACTIVA — INVARIANTE DE AISLAMIENTO
 * ==============================================================================
 * Resuelve la sede activa a partir de la sede explícita o del locationId de GHL,
 * validándola contra la allow-list de sedes reales. Devuelve `null` cuando la
 * sede no es determinable: el llamante DEBE abortar la operación.
 *
 * @returns {string|null} 'PALACIOS' | 'BENAVIDES' | ... | null
 */
export function resolveActiveSede(ghlContact = {}, targetSede = '') {
  const candidata = String(targetSede || ghlContact?.targetSede || ghlContact?.sede || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');

  if (VTIGER_SEDES_VALIDAS.includes(candidata)) return candidata;

  if (ghlContact?.locationId) {
    const resolved = resolveSedeContext({ locationId: ghlContact.locationId });
    const vtigerSede = String(resolved?.vtigerSedeName || '').toUpperCase();
    if (!resolved?.isUnresolved && VTIGER_SEDES_VALIDAS.includes(vtigerSede)) {
      return vtigerSede;
    }
    console.warn(`[VTiger API] [SEDE-UNRESOLVED] locationId ${ghlContact.locationId} no pertenece a ninguna sede registrada.`);
  }

  return null;
}

/**
 * Cláusula SQL de aislamiento por el campo nativo de sede.
 * Se apoya en `sedeClause()` del cliente vTiger: si la sede no es válida,
 * devuelve un filtro imposible (`__SIN_SEDE__`) en lugar de una cláusula vacía
 * que consultaría la base global (violación del Sede-Lock).
 */
function vtigerSedeClause(sede) {
  return sedeClause(sede);
}

/**
 * Verifica que un registro devuelto por vTiger pertenezca a la sede activa.
 * Segunda barrera (defensa en profundidad): aunque la consulta ya filtre en SQL,
 * un registro ajeno NUNCA debe propagarse hacia GHL.
 *
 * [SEDE-SHIELD] Si el registro es de otra sede, se descarta y se audita.
 */
function belongsToSede(vRecord = {}, sedeActiva = '') {
  const vSede = String(vRecord.cf_3451 || '').toUpperCase().trim();
  const ok = Boolean(sedeActiva) && vSede === sedeActiva;
  if (!ok && vSede) {
    recordAuditEvent({
      type: 'SEDE_SHIELD_BLOCKED',
      severity: 'warn',
      sedeActiva,
      sedeRegistro: vSede,
      vTigerId: vRecord.id || null,
      reason: 'registro de otra sede descartado antes de propagarse a GHL'
    });
  }
  return ok;
}

/**
 * Compara dos cadenas de teléfono por los últimos N dígitos (10 dígitos en Estados Unidos - NANP).
 */
function phonesMatch(phone1, phone2, digits = 10) {
  if (!phone1 || !phone2) return false;
  const p1 = String(phone1).replace(/\D/g, '');
  const p2 = String(phone2).replace(/\D/g, '');
  if (p1.length < 7 || p2.length < 7) return false;
  const d = Math.min(digits, Math.min(p1.length, p2.length));
  return p1.slice(-d) === p2.slice(-d);
}

export async function findVTigerContact(ghlContact, targetSede = null) {
  const cleanPhone = ghlContact.phone ? ghlContact.phone.replace(/\D/g, '') : '';
  
  // [REGLA DE ORO: SIN NÚMERO NO HAY BÚSQUEDA]
  // Previene falsos positivos por nombres comunes (ej. "Maria Rodriguez") en leads que aún no han dejado su celular.
  if (cleanPhone.length < 7) {
    console.log(`[VTiger API] [SHIELD] Lead sin teléfono válido detectado (${ghlContact.firstName || 'Desconocido'}). Búsqueda en vTiger abortada para evitar homonimia.`);
    return null;
  }

  const firstName = sanitizeForVtigerQuery(ghlContact.firstName);
  const lastName = sanitizeForVtigerQuery(ghlContact.lastName);

  // ============================================================================
  // [SEDE-LOCK] RESOLUCIÓN OBLIGATORIA DE LA SEDE ACTIVA
  // ============================================================================
  // INVARIANTE DEL PROTOCOLO: ninguna consulta a vTiger puede ejecutarse sin
  // estar parametrizada por `cf_3451`. Si la sede no se puede determinar, la
  // búsqueda se ABORTA (no se degrada a una consulta global).
  const sedeActiva = resolveActiveSede(ghlContact, targetSede);
  if (!sedeActiva) {
    console.warn('[VTiger API] [SEDE-LOCK] Sede activa indeterminada. Búsqueda abortada: no se consulta la base global de vTiger.');
    recordAuditEvent({
      type: 'SEDE_LOCK_ABORT',
      severity: 'warn',
      contactId: ghlContact?.id || null,
      locationId: ghlContact?.locationId || null,
      reason: 'sede activa no resoluble'
    });
    return null;
  }
  const targetSedeUpper = sedeActiva;
  const sedeClause = vtigerSedeClause(targetSedeUpper);
  
  // ────────────────────────────────────────────
  // ESTRATEGIA 0: Búsqueda Directa por Teléfono (10 dígitos exactos - Estados Unidos NANP)
  // En EE.UU. los números telefónicos tienen 10 dígitos (Código de Área 3 dígitos + 7 dígitos locales).
  // Con prefijo internacional +1 son 11 dígitos. Al extraer los últimos 10 dígitos (last10),
  // se empata inmediatamente (0.2s) con el número registrado en vTiger (mobile, phone, homephone).
  // ────────────────────────────────────────────
  if (cleanPhone && cleanPhone.length >= 10) {
    const last10 = digitsOnly(cleanPhone).slice(-10);
    try {
      // [SEDE-LOCK] El aislamiento se aplica EN SQL (no filtrando en JavaScript).
      // NOTA vTiger: el parser del Webservice NO admite paréntesis en el WHERE
      // (Syntax Error "PARENOPEN"), por eso la condición es plana: la cláusula de
      // sede se une con OR y sigue aplicándose a toda la expresión.
      // [DATOS PARA EL MERGE SOP] Se añaden los campos comerciales al SELECT:
      // sin ellos el resolvedor de colisiones no sabe quién tiene compras y
      // podría rescatar al contacto equivocado (defecto detectado y corregido).
      const qPhone = `SELECT ${VTIGER_CONTACT_SELECT}, ${VTIGER_FIELDS.NUM_COMPRAS}, ${VTIGER_FIELDS.MONTO_INVERTIDO}, ${VTIGER_FIELDS.ESTADO_VENTA} FROM Contacts WHERE homephone = '${last10}' OR mobile = '${last10}' OR phone = '${last10}'${sedeClause} LIMIT 10;`;
      let phoneMatches = await queryVTiger(qPhone, targetSedeUpper);

      // [SEDE-SHIELD] Segunda barrera: cualquier registro ajeno se descarta.
      phoneMatches = (phoneMatches || []).filter(v => belongsToSede(v, targetSedeUpper));

      if (phoneMatches.length > 0) {
        // ======================================================================
        // [REGLA DEL NEGOCIO] EL TELÉFONO ES EL ÚNICO FACTOR QUE RELACIONA.
        //
        // Antes había un "escudo de homonimia" que cruzaba nombre y apellido para
        // decidir si dos registros con el mismo teléfono eran la misma persona, y
        // un resolvedor que comparaba similitud de nombres. Esa lógica se RETIRA:
        // el match se resuelve SOLO por el número.
        //
        // Justificación operativa: en GHL el teléfono ya es único por subcuenta
        // (la plataforma no admite dos contactos con el mismo número en la misma
        // location). El número es la llave del dato comercial y el nombre no
        // participa en la decisión.
        //
        // Si varios registros de vTiger comparten el número, se prefiere el que
        // TIENE COMPRAS (es la cartera que interesa); si ninguno tiene, se toma el
        // primero. La decisión queda auditada para poder rastrearla.
        // ======================================================================
        if (phoneMatches.length > 1) {
          recordAuditEvent({
            type: 'VTIGER_PHONE_MULTI_MATCH',
            severity: 'warn',
            telefono: last10,
            sede: targetSedeUpper,
            candidatos: phoneMatches.length,
            conCompras: phoneMatches.filter(v => parseInt(v.spl_num_compras || '0', 10) > 0).length,
            reason: 'varios registros comparten el teléfono: se elige por compras, sin usar el nombre'
          });
        }

        const conCompras = phoneMatches.find(v => parseInt(v.spl_num_compras || '0', 10) > 0);
        const elegido = conCompras || phoneMatches[0];
        if (phoneMatches.length > 1) {
          console.log(`[VTiger API] [TELEFONO] ${last10} coincide con ${phoneMatches.length} registros de ${targetSedeUpper}; se elige ${elegido.firstname} ${elegido.lastname} (compras=${elegido.spl_num_compras || 0}) por tener compras.`);
        }
        return elegido;
      }
    } catch (pErr) {
      console.warn(`[VTiger API] [WARN] Error en búsqueda directa por teléfono (${last10}):`, pErr.message);
    }
  }
  
  // ============================================================================
  // [REGLA DE ORO — SOLO TELÉFONO] Se ELIMINAN las búsquedas por NOMBRE, EMAIL o
  // APELLIDO. El teléfono es el ÚNICO factor de relación con vTiger (gobernanza
  // innegociable). Sin match de teléfono, NO hay vinculación: se evita la
  // homonimia y la contaminación de datos comerciales entre personas distintas
  // que comparten el mismo nombre.
  //
  // DEFECTO CORREGIDO (reportado por el usuario): existían "Estrategia 1/2/3"
  // que consultaban vTiger por nombre, email o apellido como fallback. Esa es
  // la "acción antigua" que violaba el matching exclusivo por teléfono.
  // ============================================================================
  return null;
}

/**
 * Historial de compras (SalesOrder) de un contacto EN UNA SEDE CONCRETA.
 *
 * [SEDE-SHIELD — CERO RASTRO DE VENTAS AJENAS]
 * La sede es OBLIGATORIA. Antes esta función consultaba `SalesOrder` por
 * contact_id sin filtro de sede: si el contacto tenía compras registradas en
 * otra sede, ese historial (montos en USD, fechas y número de órdenes) viajaba
 * hacia el GHL de la sede receptora, rompiendo la confidencialidad financiera.
 *
 * @param {string} contactId id de vTiger (ej. "12x456")
 * @param {string} sedeActiva sede que recibe al lead (OBLIGATORIA)
 * @returns {Promise<{records: Array, salesCount: number, totalSpent: number, blocked: boolean, sede: string|null}>}
 */
export async function getSalesHistory(contactId, sedeActiva = '') {
  const sede = String(sedeActiva || '').toUpperCase().replace(/[^A-Z]/g, '');
  const empty = { records: [], salesCount: 0, totalSpent: 0, blocked: false, sede: null };

  if (!contactId) return empty;

  if (!VTIGER_SEDES_VALIDAS.includes(sede)) {
    // Sin sede válida NO se consulta: historial vacío (el lead queda como
    // SIN VENTA para la sede receptora) y el intento queda auditado.
    console.error(`[VTiger API] [SEDE-LOCK] getSalesHistory invocado sin sede válida (recibido: "${sedeActiva}"). Historial NO consultado.`);
    recordAuditEvent({
      type: 'SEDE_LOCK_ABORT',
      severity: 'error',
      operation: 'getSalesHistory',
      contactId: String(contactId).slice(0, 40),
      sedeRecibida: String(sedeActiva || '').slice(0, 24)
    });
    return { ...empty, blocked: true };
  }

  const safeContactId = sanitizeForVtigerQuery(contactId, 40);
  try {
    // [SEDE-SHIELD] SalesOrder NO posee el campo de sede (verificado contra la
    // API: cf_3451 devuelve "Permission to access cf_3451 attribute denied"). Su
    // aislamiento es ESTRUCTURAL: el contacto ya fue seleccionado bajo Sede-Lock
    // y las órdenes se piden por su vínculo nativo `contact_id`. La sede heredada
    // se declara explícitamente para que el gate de aislamiento pueda auditarla.
    const orders = await queryVTiger(
      `SELECT * FROM SalesOrder WHERE contact_id = '${safeContactId}';`,
      sede,
      { inheritedSede: sede }
    );

    const salesCount = orders.length;
    const totalSpent = orders.reduce((sum, o) => {
      const amount = parseFloat(o?.cf_3392 ?? o?.total ?? 0);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);

    return { records: orders, salesCount, totalSpent, blocked: false, sede };
  } catch (e) {
    console.log(`[VTiger API] [WARN] No se pudo consultar SalesOrder para la sede ${sede}: ${e.message}`);
    // Ante un fallo de lectura se devuelve historial VACÍO, jamás de otra sede.
    return { ...empty, sede };
  }
}

/**
 * Contactos recientes de UNA sede para alimentar el Cerebro.
 * [SEDE-LOCK] La sede es obligatoria: antes esta consulta leía la base completa
 * (`SELECT ... FROM Contacts ORDER BY createdtime DESC` sin cláusula), mezclando
 * las 2 sedes en el aprendizaje.
 */
export async function fetchRecentConfirmedSales(limit = 25, sedeActiva = '') {
  const sede = String(sedeActiva || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!VTIGER_SEDES_VALIDAS.includes(sede)) {
    console.error(`[VTiger API] [SEDE-LOCK] fetchRecentConfirmedSales sin sede válida ("${sedeActiva}"). Consulta omitida.`);
    recordAuditEvent({ type: 'SEDE_LOCK_ABORT', severity: 'warn', operation: 'fetchRecentConfirmedSales', sedeRecibida: String(sedeActiva || '').slice(0, 24) });
    return [];
  }

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);
  try {
    // NOTA vTiger: `WHERE 1=1` NO es válido para su parser ("Permission to access
    // 1 attribute denied"). El WHERE se construye con la cláusula de sede directa.
    //
    // [RENDIMIENTO — FIX CRÍTICO] ANTES: `ORDER BY createdtime DESC`. Ese campo NO
    // tiene índice: vTiger escaneaba la tabla completa (399k contactos) y ordenaba,
    // provocando timeouts ("This operation was aborted"). Esos fallos disparaban el
    // CIRCUIT BREAKER, que pausaba TODAS las consultas — incluidas las búsquedas por
    // teléfono del PRIMER NIVEL. Es decir: una tarea de MANTENIMIENTO (alimentar el
    // Cerebro) tumbaba el trabajo EN VIVO.
    //
    // AHORA: `ORDER BY id DESC`. El `id` (CRMID) es la CLAVE PRIMARIA y es
    // cronológicamente creciente, así que devuelve los mismos "contactos recientes"
    // pero usando el índice → respuesta en milisegundos, sin timeouts.
    const q = `SELECT ${VTIGER_FIELDS.ID}, ${VTIGER_FIELDS.FIRST_NAME}, ${VTIGER_FIELDS.LAST_NAME}, ${VTIGER_FIELDS.TRATAMIENTO}, ${VTIGER_FIELDS.CAMPANA}, ${VTIGER_FIELDS.CREATED_TIME}, ${VTIGER_FIELDS.SEDE} FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${sede}' ORDER BY ${VTIGER_FIELDS.ID} DESC LIMIT 0, ${safeLimit};`;
    const contacts = await queryVTiger(q, sede);
    // Trazabilidad del origen de cada registro.
    return (contacts || []).map(c => ({ ...c, __sedeOrigen: sede }));
  } catch (err) {
    console.error(`[VTiger API] Error al obtener ventas recientes de ${sede}:`, err.message);
    return [];
  }
}

/**
 * Sincroniza el Ground Truth de vTiger hacia el Cerebro de Autoaprendizaje.
 *
 * [SEDE-LOCK] Recorre las sedes operativas UNA POR UNA, cada una con su propia
 * consulta filtrada por `cf_3451`. El Cerebro aprende PATRONES agregados
 * (campaña ↔ tratamiento); nunca se exponen montos, fechas ni número de compras
 * de una sede a la otra.
 */
export async function syncVtigerGroundTruthToBrain(limit = 25, sedes = null) {
  try {
    const sedesObjetivo = (sedes && sedes.length ? sedes : getActiveSedes().map(s => s.sedeId))
      .map(s => String(s).toUpperCase())
      .filter(s => VTIGER_SEDES_VALIDAS.includes(s));

    if (sedesObjetivo.length === 0) {
      console.warn('[VTiger Sync] [SEDE-LOCK] Sin sedes válidas que sincronizar. Operación omitida.');
      return { success: false, trainedCount: 0, reason: 'sin sedes válidas' };
    }

    console.log(`[VTiger Sync] [SYNC] Calibrando el Cerebro desde vTiger (sede por sede): ${sedesObjetivo.join(', ')}...`);
    let trainedCount = 0;
    const porSede = {};

    for (const sede of sedesObjetivo) {
      const recentContacts = await fetchRecentConfirmedSales(limit, sede);
      let entrenadosSede = 0;

      for (const c of recentContacts) {
        // [SEDE-SHIELD] Doble verificación: el registro debe ser de la sede en curso.
        if (!belongsToSede(c, sede)) continue;

        const campaign = c.cf_3472 || '';
        const treatment = normalizeTreatment(c.cf_2610 || '');

        if (treatment) {
          learningBrain.learnFromVtigerSale({
            treatment,
            // El texto de entrenamiento NO incluye datos financieros ni identificadores.
            chatText: `${campaign}`,
            campaignName: campaign
          });
          entrenadosSede++;
          trainedCount++;
        }
      }

      porSede[sede] = { consultados: recentContacts.length, entrenados: entrenadosSede };
      console.log(`[VTiger Sync] [SEDE] ${sede}: ${entrenadosSede} registros entrenaron el Cerebro.`);
    }

    console.log(`[VTiger Sync] [SUCCESS] Calibración completada por sede: ${JSON.stringify(porSede)}. Total: ${trainedCount}.`);
    recordAuditEvent({ type: 'VTIGER_BRAIN_SYNC', severity: 'info', porSede, trainedCount });
    return { success: true, trainedCount, porSede };
  } catch (err) {
    console.error(`[VTiger Sync] [WARN] Error en calibración de vTiger:`, err.message);
    return { success: false, error: err.message };
  }
}

