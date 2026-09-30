/**
 * ==============================================================================
 * CRITERIO COMERCIAL DE FUSIÓN (MERGE)
 * ==============================================================================
 * Calibrado con datos reales. Lo que decide NO es cuántas compras tiene cada uno,
 * sino si son LA MISMA PERSONA:
 *
 * | Similitud | Caso medido                                    | Acción          |
 * |-----------|------------------------------------------------|-----------------|
 * | 1.00      | MIGUEL REVILLA / MIGUEL REVILLA                 | mismo registro  |
 * | 0.67      | MIGUEL REVILLA / MIGUEL REVILLA SANCHEZ         | MISMA PERSONA -> fusionar |
 * | 0.67      | ANA UMAÑA / ANA MARIA UMAÑA                     | MISMA PERSONA -> fusionar |
 * | 0.50      | JOSE JAIME REYES OVALLE / JOSE REYES            | MISMA PERSONA -> fusionar |
 * | 0.33      | MIGUEL REVILLA / MARIA REVILLA (esposa)         | PERSONAS DISTINTAS -> revisión |
 * | 0.00      | MIGUEL REVILLA / JUAN PEREZ                     | PERSONAS DISTINTAS -> revisión |
 *
 * REGLA: se conserva el contacto MÁS RECIENTE (el registro vigente) y se le
 * rescatan los datos relevantes del otro: si el descartado tiene compras que el
 * reciente no registra, ese historial NO se pierde.
 *
 * Si los nombres NO coinciden, es un enfrentamiento real (familiar que comparte
 * celular): NO se fusiona y se marca para revisión humana. Fusionar ahí uniría
 * dos clientes de verdad.
 * ==============================================================================
 */

/** Umbral de similitud a partir del cual se considera la MISMA persona. */
export const UMBRAL_MISMA_PERSONA = 0.5;

/** Motivos de resolución. */
export const MOTIVO = {
  SIN_COLISION: 'sin colisión',
  SIN_COLISION_MISMO_NOMBRE: 'sin colisión: el nombre coincide con el contacto encontrado',
  NOMBRE_DISCREPANTE: 'el teléfono coincidió pero el nombre difería; se conserva el contacto por ser el único con ese número',
  MISMA_PERSONA: 'mismo cliente registrado dos veces: se conserva el más reciente',
  PERSONAS_DISTINTAS: 'personas distintas con el mismo teléfono: requiere revisión humana'
};

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
 * [SEDE-LOCK] El filtro de sede es OBLIGATORIO: sin él el gate de aislamiento
 * rechaza la consulta y la función devolvería cero contactos en silencio,
 * ocultando colisiones reales. Es el mismo patrón de fallo que provocó la
 * interrupción del Reverse Sync; se aplica aquí de forma explícita.
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

  // Los campos comerciales son imprescindibles: el resolvedor decide con ellos.
  // SEXO (cf_2821) incluido: debe SOBREVIVIR al merge, y para eso el resolvedor
  // necesita verlo en los candidatos. Antes se consultaba una lista fija que no
  // lo traía, así que el sexo se perdía al resolver un enfrentamiento.
  const campos = [
    'id', 'firstname', 'lastname', 'email',
    'homephone', 'mobile', 'phone',
    'cf_3451', 'spl_num_compras', 'cf_3392', 'cf_2610', 'cf_3472',
    'cf_2821',            // SEXO
    'modifiedtime', 'createdtime'
  ].join(', ');
  const condicionTelefono = `homephone = '${ultimos10}' OR mobile = '${ultimos10}' OR phone = '${ultimos10}'`;
  const q = `SELECT ${campos} FROM Contacts WHERE ${condicionTelefono}${sedeClause(sedeActiva)}`;

  try {
    const filas = await queryVTiger(q, sedeActiva);
    return (filas || []).filter(c => mismoTelefono(
      c.homephone || c.mobile || c.phone,
      ultimos10
    ));
  } catch (err) {
    // Un fallo NO puede pasar desapercibido: se audita y se advierte fuerte.
    console.error(`[Collision] [ERROR] La búsqueda de colisión falló en ${sedeActiva}: ${err.message}`);
    recordAuditEvent({
      type: 'COLLISION_QUERY_FAILED',
      severity: 'critical',
      sede: sedeActiva,
      telefono: e164,
      message: err.message
    });
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
        nombrePila: c.firstname || '',
        apellido: c.lastname || '',
        compras: parseInt(c.spl_num_compras || '0', 10) || 0,
        monto: parseFloat(c.cf_3392 || '0') || 0,
        tratamiento: c.cf_2610 || '',
        // SEXO: se arrastra al candidato para que sobreviva a la fusión.
        sexo: String(c.cf_2821 || '').trim(),
        campana: c.cf_3472 || '',
        modificado: String(c.modifiedtime || '').slice(0, 10),
        creado: String(c.createdtime || '').slice(0, 10),
        etiquetas: Array.isArray(c.tags) ? c.tags : [],
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
 * Decide qué contacto se conserva y qué datos se rescatan.
 *
 * CRITERIO COMERCIAL (calibrado con datos reales):
 *   1. ¿Son la MISMA persona? -> similitud de nombre >= UMBRAL_MISMA_PERSONA (0.5).
 *      Si sí: se conserva el MÁS RECIENTE y se rescata lo relevante del otro
 *      (compras, monto, tratamiento, etiquetas). Esto es el MERGE de duplicados.
 *   2. Si los nombres NO coinciden -> PERSONAS DISTINTAS que comparten celular
 *      (familiar). NO se fusiona: requiere revisión humana.
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
    // Sin enfrentamiento. Si quien consultó reportó candidatos con nombre
    // discrepante, se declara: el teléfono coincidió pero el nombre difería.
    const discrepo = Array.isArray(informe.discrepanciaNombre) && informe.discrepanciaNombre.length > 0;
    const fuente = discrepo ? informe.discrepanciaNombre[0] : vContactBase;
    res.elegido = {
      vTigerId: fuente.id,
      nombre: `${fuente.firstname || ''} ${fuente.lastname || ''}`.trim(),
      compras: parseInt(fuente.spl_num_compras || '0', 10) || 0,
      monto: parseFloat(fuente.cf_3392 || '0') || 0,
      modificado: String(fuente.modifiedtime || '').slice(0, 10)
    };
    res.motivo = discrepo ? MOTIVO.NOMBRE_DISCREPANTE : MOTIVO.SIN_COLISION;
    return res;
  }

  const candidatos = informe.interna.contactos;

  // ---------------------------------------------------------------------------
  // 1. ¿MISMA PERSONA? Se mide entre TODOS los pares, no sólo contra la base.
  //    Un duplicado real tiene nombres casi idénticos (>= 0.5).
  // ---------------------------------------------------------------------------
  const similitudes = [];
  for (let i = 0; i < candidatos.length; i++) {
    for (let j = i + 1; j < candidatos.length; j++) {
      similitudes.push(similitudNombre(
        { firstname: candidatos[i].nombre, lastname: '' },
        { firstname: candidatos[j].nombre, lastname: '' }
      ));
    }
  }
  const similitudMinima = similitudes.length > 0 ? Math.min(...similitudes) : 1;
  const mismaPersona = similitudMinima >= UMBRAL_MISMA_PERSONA;

  if (mismaPersona) {
    // ---- MERGE DE DUPLICADO: se conserva el MÁS RECIENTE ----
    const porFecha = [...candidatos].sort((a, b) => String(b.modificado).localeCompare(String(a.modificado)));
    const reciente = porFecha[0];
    res.elegido = reciente;
    res.descartados = candidatos.filter(c => c.vTigerId !== reciente.vTigerId);

    // [RESCATE] Se combinan los datos relevantes de TODOS los registros, para que
    // la fusión no pierda nada: compras, monto, tratamiento y SEXO. Si el
    // registro reciente no trae sexo pero el antiguo sí, se rescata el del
    // antiguo: un dato presente nunca debe perderse al unificar.
    const totalCompras = Math.max(...candidatos.map(c => c.compras || 0));
    const conMasCompras = [...candidatos].sort((a, b) => (b.compras || 0) - (a.compras || 0))[0];
    const monto = conMasCompras?.monto || Math.max(...candidatos.map(c => c.monto || 0));
    const tratamiento = conMasCompras?.tratamiento || candidatos.find(c => c.tratamiento)?.tratamiento || '';
    // Sexo: se prefiere el del contacto conservado; si viene vacío, se toma de
    // cualquier otro candidato que sí lo tenga.
    const sexo = reciente.sexo || candidatos.find(c => c.sexo)?.sexo || '';
    const campana = reciente.campana || candidatos.find(c => c.campana)?.campana || '';

    res.datosRescatados = {
      compras: totalCompras,
      monto,
      tratamiento,
      sexo,
      campana,
      fuenteCompras: conMasCompras?.vTigerId || null,
      fuenteSexo: reciente.sexo ? reciente.vTigerId : (candidatos.find(c => c.sexo)?.vTigerId || null),
      etiquetas: [...new Set(candidatos.flatMap(c => c.etiquetas || []))]
    };
    res.confianza = similitudMinima >= 0.9 ? CONFIANZA.ALTA : CONFIANZA.MEDIA;
    res.requiereRevision = false;
    res.motivo = MOTIVO.MISMA_PERSONA;
    res.requiereRevision = false;
  } else {
    // ---- PERSONAS DISTINTAS: familiar que comparte celular ----
    res.confianza = CONFIANZA.REVISION;
    res.requiereRevision = true;
    res.motivo = MOTIVO.PERSONAS_DISTINTAS;
    // Se propone el más reciente como referencia, pero NO se decide.
    const porFecha = [...candidatos].sort((a, b) => String(b.modificado).localeCompare(String(a.modificado)));
    res.elegido = porFecha[0];
    res.descartados = candidatos.filter(c => c.vTigerId !== res.elegido.vTigerId);
  }

  // Auditoría SIEMPRE: una colisión no puede pasar desapercibida.
  recordAuditEvent({
    type: 'CONTACT_COLLISION',
    severity: res.requiereRevision ? 'critical' : 'warn',
    sede: informe.sedeActiva,
    telefono: informe.telefono,
    tipo: informe.tipo,
    candidatos: candidatos.length,
    similitudMinima: Number(similitudMinima.toFixed(2)),
    mismaPersona,
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
  if (resolucion.motivo === MOTIVO.MISMA_PERSONA) {
    lineas.push('  Resultado: MISMO CLIENTE con registro duplicado.');
    lineas.push(`  Se conserva el registro mas reciente (${resolucion.elegido?.nombre || 'N/D'}).`);
    lineas.push('  Datos rescatados del registro anterior:');
    lineas.push(`    - Compras totales: ${resolucion.datosRescatados?.compras ?? 0}`);
    lineas.push(`    - Monto acumulado: $${(resolucion.datosRescatados?.monto || 0).toFixed(2)}`);
    if (resolucion.datosRescatados?.tratamiento) {
      lineas.push(`    - Tratamiento: ${resolucion.datosRescatados.tratamiento}`);
    }
    if (resolucion.datosRescatados?.etiquetas?.length) {
      lineas.push(`    - Etiquetas unificadas: ${resolucion.datosRescatados.etiquetas.join(', ')}`);
    }
  } else {
    lineas.push(`  Confianza: ${resolucion.confianza}`);
    lineas.push(`  Motivo: ${resolucion.motivo}`);
  }
  if (resolucion.requiereRevision) {
    lineas.push('');
    lineas.push('  *** REQUIERE REVISION HUMANA ***');
    lineas.push('  No se fusiono en automatico: los nombres NO coinciden, por lo que');
    lineas.push('  probablemente son dos personas distintas compartiendo el telefono');
    lineas.push('  (familiar). Un agente debe decidir cual contacto es la persona real.');
  }
  lineas.push('');
  lineas.push('Sincronizado por LOA Engine - solo lectura desde vTiger');

  return lineas.join('\n');
}
