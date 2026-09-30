/**
 * ==============================================================================
 * LOA ENGINE - RESOLUCIÓN DE COLISIONES DE CONTACTO (MERGE SOP)
 * ==============================================================================
 * PROBLEMA QUE RESUELVE:
 * El "escudo de homonimia" actual descarta el candidato y **pierde sus datos**:
 * cuando el teléfono coincide pero el nombre no, registra un `warn` y continúa,
 * y el asesor nunca se entera de que hubo DOS contactos. No hay fusión, no hay
 * rescate de información relevante y no hay trazabilidad.
 *
 * DOS NIVELES DE COLISIÓN (ambos reales, vistos en producción):
 *
 *  A) INTERNA (misma sede): el mismo teléfono pertenece a 2+ contactos de la
 *     MISMA sede. Suele ser un familiar que comparte celular, o un contacto
 *     duplicado con el nombre escrito distinto.
 *
 *  B) EXTERNA (entre sedes): el mismo teléfono está registrado en Palacios y en
 *     Benavides con nombres distintos. Aquí el Sede-Lock es ABSOLUTO: la sede
 *     receptora no puede ver los datos de la otra, pero SÍ debe saber que existe
 *     un conflicto, sin exponer el detalle ajeno.
 *
 * CRITERIO DE RESOLUCIÓN (rescate de datos relevantes):
 *   1. VENTAS MANDAN: si sólo un candidato tiene compras, ése es la persona
 *      real y se rescatan su historial y sus datos comerciales.
 *   2. Si ambos tienen compras -> CONFLICTO CRÍTICO: no se elige en automático,
 *      se marca para revisión humana (elegir mal fusiona dos clientes reales).
 *   3. Si ninguno tiene compras -> gana la mejor coincidencia de nombre; si no
 *      hay coincidencia de nombre, se marca para revisión.
 *   4. Sin certeza -> SIEMPRE revisión humana. Nunca se fusiona a ciegas.
 * ==============================================================================
 */

import { queryVTiger } from './vtiger_api_service.js';
import { SEDES_GATEWAY, getActiveSedes } from '../config/index.js';
import { sedeClause } from './vtigerClient.js';
import { normalizeToE164 } from '../utils/geo_phone_sanitizer.js';
import { recordAuditEvent } from './audit_logger.js';

/** Tipos de colisión detectados. */
export const TIPO_COLISION = {
  NINGUNA: 'NINGUNA',
  INTERNA: 'INTERNA',       // 2+ contactos con el mismo teléfono en la MISMA sede
  EXTERNA: 'EXTERNA',       // el mismo teléfono existe en OTRA sede
  AMBAS: 'AMBAS'            // colisión interna y externa a la vez
};

/** Niveles de confianza de la resolución automática. */
export const CONFIANZA = {
  ALTA: 'ALTA',       // resoluble en automático con seguridad
  MEDIA: 'MEDIA',     // resoluble, pero conviene revisar
  REVISION: 'REVISION' // requiere criterio humano obligatorio
};

// ------------------------------------------------------------------------------
// UTILIDADES DE COMPARACIÓN DE NOMBRES
// ------------------------------------------------------------------------------
function normalizarNombre(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensNombre(contacto = {}) {
  const n = normalizarNombre(`${contacto.firstname || ''} ${contacto.lastname || ''}`);
  return new Set(n.split(' ').filter(t => t.length >= 3));
}

/** Índice de Jaccard entre los tokens del nombre (0 = nada, 1 = idéntico). */
export function similitudNombre(a = {}, b = {}) {
  const ta = tokensNombre(a);
  const tb = tokensNombre(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let comunes = 0;
  for (const t of ta) if (tb.has(t)) comunes++;
  return comunes / new Set([...ta, ...tb]).size;
}

/** Compara teléfonos por los últimos 10 dígitos (NANP). */
export function mismoTelefono(telA, telB) {
  const a = String(telA || '').replace(/\D/g, '');
  const b = String(telB || '').replace(/\D/g, '');
  if (a.length < 10 || b.length < 10) return false;
  return a.slice(-10) === b.slice(-10);
}

// ------------------------------------------------------------------------------
// DETECCIÓN
// ------------------------------------------------------------------------------
/**
 * Busca TODOS los contactos de vTiger que comparten el teléfono, dentro de una
 * sede. vTiger no soporta paréntesis, por eso la condición es plana.
 *
 * @param {string} telefono E.164 o dígitos
 * @param {string} sedeActiva sede sobre la que se consulta (Sede-Lock)
 * @returns {Promise<Array>} contactos que comparten el teléfono
 */
export async function findContactsByPhoneInSede(telefono, sedeActiva) {
  const e164 = normalizeToE164(telefono);
  if (!e164) return [];
  const ultimos10 = e164.replace(/\D/g, '').slice(-10);
  if (ultimos10.length < 10) return [];

  const q = `SELECT id, firstname, lastname, email, homephone, mobile, phone, cf_3451, spl_num_compras, cf_3392, cf_2610, modifiedtime FROM Contacts WHERE homephone = '${ultimos10}' OR mobile = '${ultimos10}' OR phone = '${ultimos10}'`;

  try {
    const filas = await queryVTiger(q, sedeActiva);
    return (filas || []).filter(c => mismoTelefono(
      c.homephone || c.mobile || c.phone,
      ultimos10
    ));
  } catch (err) {
    console.warn(`[Collision] [WARN] Búsqueda de colisión falló en ${sedeActiva}: ${err.message}`);
    return [];
  }
}

/**
 * Evalúa si un contacto colisiona con otros y clasifica el tipo.
 *
 * @param {object} vContact contacto base (el que se está procesando)
 * @param {object} opts
 * @param {string} opts.sedeActiva
 * @param {Array}  [opts.candidatos] contactos YA traídos con el mismo teléfono.
 *        Si se entrega, se usa tal cual: así el resolvedor ve los datos
 *        financieros correctos y se evita una consulta extra a vTiger.
 * @returns {Promise<object>} informe de colisión
 */
export async function detectCollision(vContact = {}, { sedeActiva = '', candidatos = null } = {}) {
  const sede = String(sedeActiva || vContact.cf_3451 || '').toUpperCase().trim();
  const telefono = vContact.homephone || vContact.mobile || vContact.phone || '';

  const informe = {
    telefono: normalizeToE164(telefono),
    sedeActiva: sede || null,
    tipo: TIPO_COLISION.NINGUNA,
    candidatos: [],
    interna: null,
    externa: null,
    resolucion: null
  };

  if (!sede || !SEDES_GATEWAY[sede]) return informe;
  if (!informe.telefono) return informe;

  // --- A) COLISIÓN INTERNA: dentro de la sede activa ---
  // Se aprovechan los candidatos ya traídos (con sus campos financieros) cuando
  // el llamante los aporta; si no, se consulta vTiger.
  const enSede = Array.isArray(candidatos) && candidatos.length > 0
    ? candidatos.filter(c => mismoTelefono(c.homephone || c.mobile || c.phone, informe.telefono))
    : await findContactsByPhoneInSede(telefono, sede);

  const otros = enSede.filter(c => String(c.id) !== String(vContact.id));

  if (otros.length > 0 || enSede.length > 1) {
    informe.interna = {
      sede,
      total: enSede.length,
      contactos: enSede.map(c => ({
        vTigerId: c.id,
        nombre: `${c.firstname || ''} ${c.lastname || ''}`.trim(),
        compras: parseInt(c.spl_num_compras || '0', 10) || 0,
        monto: parseFloat(c.cf_3392 || '0') || 0,
        tratamiento: c.cf_2610 || '',
        modificado: String(c.modifiedtime || '').slice(0, 10),
        similitudConBase: Number(similitudNombre(vContact, c).toFixed(2))
      }))
    };
  }

  // --- B) COLISIÓN EXTERNA: el mismo teléfono en OTRAS sedes ---
  // Se consulta SEDE POR SEDE (cada una con su Sede-Lock). De la sede ajena sólo
  // se registra la EXISTENCIA: nunca identidad, montos ni historial.
  const otrasSedes = getActiveSedes().map(s => s.sedeId).filter(s => s !== sede);
  const halladas = [];
  const ultimos10 = informe.telefono.replace(/\D/g, '').slice(-10);

  for (const otra of otrasSedes) {
    try {
      const q = `SELECT id FROM Contacts WHERE homephone = '${ultimos10}'${sedeClause(otra)}`;
      const r = await queryVTiger(q, otra);
      if (r && r.length > 0) {
        halladas.push({ sede: otra, existe: true, contactos: r.length });
      }
    } catch (err) {
      // Una sede no accesible no debe romper la detección de colisiones.
      console.warn(`[Collision] [WARN] No se pudo verificar conflicto en ${otra}: ${err.message}`);
    }
  }
  if (halladas.length > 0) {
    informe.externa = {
      sedesConElMismoTelefono: halladas.map(h => h.sede),
      // NUNCA se detalla la identidad ni el historial de la otra sede.
      nota: 'El mismo teléfono existe en otra sede. Los datos ajenos no se exponen (Sede-Shield).'
    };
  }

  // --- Clasificación ---
  if (informe.interna && informe.externa) informe.tipo = TIPO_COLISION.AMBAS;
  else if (informe.interna) informe.tipo = TIPO_COLISION.INTERNA;
  else if (informe.externa) informe.tipo = TIPO_COLISION.EXTERNA;

  return informe;
}

// ------------------------------------------------------------------------------
// RESOLUCIÓN (rescate de datos relevantes)
// ------------------------------------------------------------------------------
/**
 * Decide qué contacto es la persona real y qué datos se rescatan.
 *
 * CRITERIO:
 *   1. Las VENTAS mandan: si sólo uno tiene compras, ése gana (confianza ALTA).
 *   2. Si 2+ tienen compras -> REVISION (fusionar mal une dos clientes reales).
 *   3. Si ninguno tiene compras -> gana la mejor similitud de nombre si supera
 *      0.5; si no, REVISION.
 *
 * @param {object} informe resultado de `detectCollision`
 * @param {object} vContactBase contacto que se está procesando
 * @returns {object} resolución
 */
export function resolveCollision(informe = {}, vContactBase = {}) {
  const res = {
    elegido: null,
    descartados: [],
    datosRescatados: {},
    confianza: CONFIANZA.ALTA,
    requiereRevision: false,
    motivo: ''
  };

  if (!informe.interna || !informe.interna.contactos?.length) {
    // Sin colisión interna: el contacto base es el elegido.
    res.elegido = {
      vTigerId: vContactBase.id,
      nombre: `${vContactBase.firstname || ''} ${vContactBase.lastname || ''}`.trim(),
      compras: parseInt(vContactBase.spl_num_compras || '0', 10) || 0,
      monto: parseFloat(vContactBase.cf_3392 || '0') || 0
    };
    res.motivo = 'sin colisión interna';
    return res;
  }

  const candidatos = informe.interna.contactos;
  const conVentas = candidatos.filter(c => c.compras > 0);

  if (conVentas.length === 1) {
    // Caso ideal: una sola persona con ventas -> se rescata su historial completo.
    res.elegido = conVentas[0];
    res.descartados = candidatos.filter(c => c.vTigerId !== conVentas[0].vTigerId);
    res.confianza = CONFIANZA.ALTA;
    res.motivo = 'sólo un candidato tiene compras: se rescata su historial';
    res.datosRescatados = {
      compras: conVentas[0].compras,
      monto: conVentas[0].monto,
      tratamiento: conVentas[0].tratamiento
    };
  } else if (conVentas.length > 1) {
    // CRÍTICO: dos clientes reales con el mismo teléfono. No se puede automatizar.
    res.confianza = CONFIANZA.REVISION;
    res.requiereRevision = true;
    res.motivo = `${conVentas.length} contactos con compras comparten el teléfono: fusionar en automático uniría dos clientes reales`;
    res.elegido = conVentas.sort((a, b) => b.monto - a.monto)[0]; // propuesta, NO decisión
    res.descartados = candidatos.filter(c => c.vTigerId !== res.elegido.vTigerId);
  } else {
    // Ninguno con ventas: se decide por similitud de nombre.
    const ordenados = [...candidatos].sort((a, b) => b.similitudConBase - a.similitudConBase);
    const mejor = ordenados[0];
    if (mejor && mejor.similitudConBase >= 0.5) {
      res.elegido = mejor;
      res.descartados = candidatos.filter(c => c.vTigerId !== mejor.vTigerId);
      res.confianza = CONFIANZA.MEDIA;
      res.motivo = `sin ventas en ninguno: se eligió por similitud de nombre (${mejor.similitudConBase})`;
    } else {
      res.confianza = CONFIANZA.REVISION;
      res.requiereRevision = true;
      res.motivo = 'sin ventas y sin coincidencia de nombre suficiente: requiere criterio humano';
    }
  }

  // Auditoría SIEMPRE: una colisión no puede pasar desapercibida.
  recordAuditEvent({
    type: 'CONTACT_COLLISION',
    severity: res.requiereRevision ? 'critical' : 'warn',
    sede: informe.sedeActiva,
    telefono: informe.telefono,
    tipo: informe.tipo,
    candidatos: candidatos.length,
    conVentas: conVentas.length,
    confianza: res.confianza,
    elegido: res.elegido?.vTigerId || null,
    motivo: res.motivo
  });

  return res;
}

// ------------------------------------------------------------------------------
// NOTA PARA LA TARJETA DEL CONTACTO
// ------------------------------------------------------------------------------
/**
 * Genera la nota que documenta el enfrentamiento, para que el asesor sepa qué
 * pasó y qué datos se rescataron.
 *
 * AISLAMIENTO: si la colisión es externa, la nota indica "OTRA SEDE" sin exponer
 * identidad, montos ni historial ajeno.
 *
 * @param {object} informe resultado de `detectCollision`
 * @param {object} resolucion resultado de `resolveCollision`
 */
export function buildCollisionNote(informe = {}, resolucion = {}) {
  if (!informe.interna && !informe.externa) return null;

  const lineas = [];
  lineas.push('[LOA-COLLISION] ENFRENTAMIENTO DE CONTACTOS - vTiger CRM');
  lineas.push('=========================================');
  lineas.push(`Telefono en conflicto: ${informe.telefono || 'N/D'}`);
  lineas.push(`Tipo de colision: ${informe.tipo}`);
  lineas.push('');

  if (informe.interna) {
    lineas.push(`CONTACTOS EN ESTA SEDE (${informe.interna.sede}): ${informe.interna.total}`);
    lineas.push('');
    for (const c of informe.interna.contactos) {
      const marca = c.vTigerId === resolucion.elegido?.vTigerId ? '<< ELEGIDO' : '(descartado)';
      lineas.push(`- ${c.nombre || '(sin nombre)'} ${marca}`);
      lineas.push(`  vTiger ID: ${c.vTigerId} | Compras: ${c.compras} | Monto: $${c.monto.toFixed(2)}`);
      if (c.tratamiento) lineas.push(`  Tratamiento: ${c.tratamiento}`);
      if (c.modificado) lineas.push(`  Ultima modificacion: ${c.modificado}`);
      lineas.push(`  Similitud de nombre con el lead: ${c.similitudConBase}`);
      lineas.push('');
    }
  }

  if (informe.externa) {
    lineas.push('CONFLICTO ENTRE SEDES');
    lineas.push(`  El mismo telefono existe en: ${informe.externa.sedesConElMismoTelefono.join(', ')}`);
    lineas.push('  [SEDE-SHIELD] No se expone la identidad ni el historial de la otra sede.');
    lineas.push('');
  }

  lineas.push('RESOLUCION');
  lineas.push(`  Confianza: ${resolucion.confianza}`);
  lineas.push(`  Motivo: ${resolucion.motivo}`);
  if (resolucion.datosRescatados?.compras) {
    lineas.push(`  Datos rescatados: ${resolucion.datosRescatados.compras} compras por $${(resolucion.datosRescatados.monto || 0).toFixed(2)}`);
  }
  if (resolucion.requiereRevision) {
    lineas.push('');
    lineas.push('  *** REQUIERE REVISION HUMANA ***');
    lineas.push('  No se fusiono en automatico. Un agente debe decidir cual contacto es la persona real.');
  }
  lineas.push('');
  lineas.push('Sincronizado por LOA Engine - solo lectura desde vTiger');

  return lineas.join('\n');
}
