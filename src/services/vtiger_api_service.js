import crypto from 'crypto';
import { VTIGER_CONFIG, resolveSedeContext, getActiveSedes } from '../config/index.js';
import { normalizeTreatment } from '../domain/clinical_vocabulary.js';
import { learningBrain } from './learning_brain.js';
import { query as vtigerQuery, login as vtigerLogin, VTIGER_FIELDS, VTIGER_CONTACT_SELECT, VTIGER_SEDES_VALIDAS, sedeClause } from './vtigerClient.js';
import { sanitizeForVtigerQuery, digitsOnly } from '../utils/sanitize.js';
import { recordAuditEvent } from './audit_logger.js';
import { detectCollision, resolveCollision } from './contact_collision_service.js';

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
        {
          // [ESCUDO DE HOMONIMIA ESTRICTA]: Cruzar el nombre/apellido.
          // Previene que familiares que comparten celular (ej. Perez vs Martinez) sean fusionados.
          const strictMatches = phoneMatches.filter(v => {
            const vFirst = sanitizeForVtigerQuery(v.firstname || '');
            const vLast = sanitizeForVtigerQuery(v.lastname || '');
            
            // Si en GHL no tenemos nombre, lo dejamos pasar (no hay forma de validar).
            if (!firstName && !lastName) return true;

            // Validar que al menos el Nombre o el Apellido (mínimo 3 letras) compartan raíz
            // Ej: "MART" y "MARTINEZ" coincidirán. "PEREZ" y "MARTINEZ" fallarán.
            const lastMatch = (lastName.length >= 3 && vLast.includes(lastName)) || (vLast.length >= 3 && lastName.includes(vLast));
            const firstMatch = (firstName.length >= 3 && vFirst.includes(firstName)) || (vFirst.length >= 3 && firstName.includes(vFirst));

            // Debe coincidir apellido O nombre para considerarse la misma persona.
            return lastMatch || firstMatch;
          });

          if (strictMatches.length > 0) {
            // Prioridad A: Match con compras registradas
            const withSales = strictMatches.find(v => parseInt(v.spl_num_compras || '0', 10) > 0);
            if (withSales) return withSales;

            // Prioridad B: Primer match disponible dentro de la sede
            return strictMatches[0];
          } else {
            // [MERGE SOP - RESCATE DE DATOS]
            // ANTES: se descartaba el candidato y sus datos se PERDÍAN, con un
            // `warn` que nadie leía. Ahora se resuelve el enfrentamiento: si uno
            // de los contactos con el mismo teléfono tiene compras, ése es la
            // persona real y se rescata su historial; si hay conflicto real, se
            // marca para revisión humana y se documenta en la tarjeta.
            console.warn(`[VTiger API] [COLISION] El teléfono ${last10} existe con ${phoneMatches.length} contacto(s) pero los nombres no coinciden. Aplicando MERGE SOP para rescatar datos.`);
            try {
              // Se pasan TODOS los candidatos con el mismo teléfono (no sólo el
              // primero): el resolvedor necesita ver quién tiene compras.
              const informe = await detectCollision(
                { ...phoneMatches[0], homephone: last10 },
                { sedeActiva: targetSedeUpper, candidatos: phoneMatches }
              );
              const resolucion = resolveCollision(informe, phoneMatches[0]);

              if (resolucion.elegido && !resolucion.requiereRevision) {
                const elegidoId = String(resolucion.elegido.vTigerId);
                const encontrado = phoneMatches.find(v => String(v.id) === elegidoId);
                if (encontrado) {
                  console.log(`[VTiger API] [COLISION-RESUELTA] Se rescata ${resolucion.elegido.nombre} (${resolucion.elegido.compras} compras) — ${resolucion.motivo}`);
                  return encontrado;
                }
              }

              if (resolucion.requiereRevision) {
                // No se elige a ciegas: se devuelve el candidato para no romper el
                // flujo, pero la colisión queda auditada y documentada.
                console.error(`[VTiger API] [COLISION-REVISION] ${resolucion.motivo}. Se requiere criterio humano; la colisión quedó registrada en auditoría.`);
                return phoneMatches[0];
              }
            } catch (colErr) {
              console.warn(`[VTiger API] [COLISION-WARN] No se pudo resolver el enfrentamiento: ${colErr.message}`);
            }
          }
        }
      }
    } catch (pErr) {
      console.warn(`[VTiger API] [WARN] Error en búsqueda directa por teléfono (${last10}):`, pErr.message);
    }
  }
  
  // ────────────────────────────────────────────
  // ESTRATEGIA 1: Búsqueda por Nombre + Apellido
  // ────────────────────────────────────────────
  if (firstName.length >= 2 && lastName.length >= 2) {
    // 1. Intentar primero con igualdad exacta + filtro de sede
    let q = `SELECT * FROM Contacts WHERE firstname = '${firstName}' AND lastname = '${lastName}'${sedeClause};`;
    let potentialContacts = await queryVTiger(q, targetSedeUpper);
    
    // 2. Si no hay resultados exactos, intentar con LIKE + filtro de sede
    if (!potentialContacts || potentialContacts.length === 0) {
      const fnPrefix = firstName.substring(0, Math.min(4, firstName.length));
      const lnPrefix = lastName.substring(0, Math.min(4, lastName.length));
      q = `SELECT * FROM Contacts WHERE firstname LIKE '${fnPrefix}%' AND lastname LIKE '${lnPrefix}%'${sedeClause};`;
      potentialContacts = await queryVTiger(q, targetSedeUpper);
    }
    
    if (potentialContacts && potentialContacts.length > 0) {
      // [SEDE-SHIELD] Segunda barrera: toda fila ajena se descarta y se audita.
      potentialContacts = potentialContacts.filter(v => belongsToSede(v, targetSedeUpper));

      // Si no hay ningún contacto para esta sede, retorno NULL de inmediato (CERO FALLBACK A OTRAS SEDES)
      if (potentialContacts.length === 0) {
        return null;
      }

      // [REGLA 2 - BLINDAJE DE HOMÓNIMOS POR TELÉFONO]:
      // Si el lead en GHL ya tiene un número telefónico conocido,
      // comparamos contra los teléfonos que tenga el candidato en vTiger.
      // Si el candidato tiene teléfonos y NINGUNO coincide con el lead, es un homónimo diferente -> DESCARTADO.
      if (cleanPhone) {
        const matchingByPhone = [];
        const withoutPhone = [];
        
        for (const v of potentialContacts) {
          const vPhones = [v.homephone, v.mobile, v.phone, v.otherphone].filter(Boolean);
          if (vPhones.length > 0) {
            if (vPhones.some(p => phonesMatch(cleanPhone, p))) {
              matchingByPhone.push(v);
            }
            // Si tiene teléfonos pero ninguno coincide, NO se agrega (homónimo rechazado)
          } else {
            // El candidato en vTiger no tiene teléfono registrado
            withoutPhone.push(v);
          }
        }

        if (matchingByPhone.length > 0) {
          const withSales = matchingByPhone.find(v => parseInt(v.spl_num_compras || '0', 10) > 0);
          return withSales || matchingByPhone[0];
        }

        // Si todos los candidatos tenían teléfonos y ninguno coincidió, ABORTAR vinculación
        if (withoutPhone.length === 0) {
          console.log(`[VTiger API] [SEDE-SHIELD] Homónimo de ${firstName} ${lastName} en sede ${targetSedeUpper} descartado por teléfono en conflicto.`);
          return null;
        }

        // Si hay candidatos en la misma sede sin teléfono registrado, nos quedamos con ellos
        potentialContacts = withoutPhone;
      }

      // Prioridad: El que tenga compras dentro de la sede
      const withSales = potentialContacts.find(v => parseInt(v.spl_num_compras || '0', 10) > 0);
      if (withSales) return withSales;
      
      return potentialContacts[0];
    }
  }
  
  // ────────────────────────────────────────────
  // ESTRATEGIA 2: Búsqueda por Email
  // ────────────────────────────────────────────
  const email = ghlContact.email;
  if (email && email.includes('@')) {
    const cleanEmail = sanitizeForVtigerQuery(email);
    const q = `SELECT * FROM Contacts WHERE email = '${cleanEmail}'${sedeClause} LIMIT 1;`;
    let contacts = await queryVTiger(q, targetSedeUpper);
    if (contacts && contacts.length > 0) {
      if (targetSedeUpper) {
        contacts = contacts.filter(v => belongsToSede(v, targetSedeUpper));
      }
      if (contacts.length > 0) return contacts[0];
    }
  }
  
  // ────────────────────────────────────────────
  // ESTRATEGIA 3: Búsqueda por solo nombre O solo apellido (último recurso)
  // ────────────────────────────────────────────
  if (cleanPhone && (firstName.length >= 3 || lastName.length >= 3)) {
    const nameToSearch = lastName.length >= 3 ? lastName : firstName;
    const field = lastName.length >= 3 ? 'lastname' : 'firstname';
    const q = `SELECT * FROM Contacts WHERE ${field} = '${nameToSearch}'${sedeClause} LIMIT 20;`;
    try {
      let contacts = await queryVTiger(q, targetSedeUpper);
      if (contacts && contacts.length > 0) {
        if (targetSedeUpper) {
          contacts = contacts.filter(v => belongsToSede(v, targetSedeUpper));
        }
        // Solo devolver si hay match de teléfono estricto
        for (const v of contacts) {
          const vPhones = [v.homephone, v.mobile, v.phone, v.otherphone].filter(Boolean);
          if (vPhones.some(p => phonesMatch(cleanPhone, p))) {
            return v;
          }
        }
      }
    } catch (e) {
      // Silenciar errores de esta búsqueda de último recurso
    }
  }
  
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
    const q = `SELECT ${VTIGER_FIELDS.ID}, ${VTIGER_FIELDS.FIRST_NAME}, ${VTIGER_FIELDS.LAST_NAME}, ${VTIGER_FIELDS.TRATAMIENTO}, ${VTIGER_FIELDS.CAMPANA}, ${VTIGER_FIELDS.CREATED_TIME}, ${VTIGER_FIELDS.SEDE} FROM Contacts WHERE ${VTIGER_FIELDS.SEDE} = '${sede}' ORDER BY ${VTIGER_FIELDS.CREATED_TIME} DESC LIMIT 0, ${safeLimit};`;
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

