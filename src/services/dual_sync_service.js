/**
 * ==============================================================================
 * LOA ENGINE - MIDDLEWARE DE SINCRONIZACIÓN DUAL vTiger -> GHL (TICKET 1)
 * ==============================================================================
 * Flujo:
 *   1. VALIDACIÓN : sin teléfono válido (E.164) se descarta y se audita.
 *   2. MACRO      : upsert hacia la Cuenta Empresa (analítica, sin chats).
 *   3. OPERATIVA  : upsert hacia la subcuenta de la sede indicada por `cf_3451`.
 *   4. MERGE SOP  : si el contacto ya existe, NO se sobrescribe el historial
 *                   financiero (total_compras, fecha_ultima_compra, precio_venta,
 *                   estado comercial) ni la etiqueta `convertido`.
 *
 * DECISIONES DE DISEÑO (y por qué):
 *
 * - **Cero hardcoding de IDs.** Los Custom Field IDs de GHL son POR LOCATION: el
 *   mismo campo tiene un ID distinto en la Central y en cada sede. Hardcodearlos
 *   los rompe ante cualquier recreación de campo. El middleware los DESCUBRE en
 *   runtime vía `GET /locations/{id}/customFields` y los cachea. Se puede
 *   sobrescribir con `GHL_FIELD_<nombre>` si el negocio quiere fijarlos.
 *
 * - **La Central NO rutea.** Recibe el 100% de los contactos como Data Warehouse,
 *   pero el motor no crea oportunidades ni asigna asesores ahí. El ruteo vive en
 *   la subcuenta operativa, lo que evita el cruce de sedes.
 *
 * - **Teléfono prioritario: `homephone`.** Medido en vivo sobre 60 contactos de
 *   Palacios: 100% tienen teléfono y el 100% está SOLO en `homephone`;
 *   `phone` y `mobile` están vacíos. Usar `phone` como primera opción descartaría
 *   todos los registros reales.
 *
 * - **Rate limit.** No se implementa un limitador propio: `ghlFetch` ya pasa por
 *   el `TokenBucketQueue` global y aplica backoff por subcuenta ante 429. Un
 *   segundo limitador duplicaría la throttlación.
 * ==============================================================================
 */

import { SEDES_GATEWAY, resolveSedeContext } from '../config/index.js';
import { ghlFetch } from '../utils/ghl_http_client.js';
import { normalizeToE164, buildSanitizedGeoFields, splitCityAndState, isUsStateCode, isUsStateName, normalizeUsState } from '../utils/geo_phone_sanitizer.js';
import { normalizeTreatment } from '../domain/clinical_vocabulary.js';
import { recordAuditEvent } from './audit_logger.js';
import { readSecret } from '../config/secrets.js';

// ------------------------------------------------------------------------------
// 1. CONFIGURACIÓN (todo por entorno; nada hardcodeado)
// ------------------------------------------------------------------------------
const CENTRAL_LOCATION_ID = readSecret('GHL_LOCATION_ID_CENTRAL');
const CENTRAL_API_KEY = readSecret('GHL_API_KEY_CENTRAL');

/** ¿Está configurada la Cuenta Empresa? Si no, el middleware opera sólo por sede. */
export function isCentralConfigured() {
  return Boolean(CENTRAL_LOCATION_ID && CENTRAL_API_KEY);
}

/**
 * Nombres lógicos de campo que el middleware necesita resolver a IDs reales.
 *
 * Los nombres provienen del diccionario REAL de la sede (verificado en vivo):
 *   "vTiger Total Compras"        -> contact.vtiger_total_compras      (NUMERICAL)
 *   "vTiger Fecha Última Compra"  -> contact.vtiger_fecha_ltima_compra (typo en la key)
 *   "vTiger Sede / Tienda Compra" -> contact.vtiger_sede__tienda_compra
 *   "Precio venta"                -> contact.precio_venta
 *   "Ultima Interaccion"          -> contact.ultima_interaccion
 * Las claves traen acentos, dobles guiones y erratas, por eso el matching
 * normaliza (minusculas, sin acentos, sin puntuacion) en lugar de comparar literal.
 */
const CAMPOS_REQUERIDOS = {
  oficinaOrigen: ['oficina_origen', 'oficina origen', 'sede origen', 'v tiger sede tienda compra', 'sede asignada'],
  totalCompras: ['v tiger total compras', 'total compras', 'numero de compras', 'num compras'],
  fechaUltimaCompra: ['v tiger fecha ultima compra', 'fecha ultima compra', 'ultima compra'],
  fechaPrimeraCompra: ['v tiger fecha primera compra', 'fecha primera compra'],
  precioVenta: ['precio venta', 'v tiger precio venta', 'monto invertido'],
  // La Cuenta Empresa expone campos comerciales mas ricos que las sedes
  // (verificado en vivo): el gasto historico acumulado del cliente.
  totalHistorico: ['v tiger total historico gastado usd', 'total historico gastado', 'total historico'],
  ultimaInteraccion: ['ultima interaccion'],
  campanaOrigen: ['v tiger campana origen', 'utm campaign', 'campana origen', 'origen lead'],
  idClienteVt: ['v tiger id cliente', 'id cliente', 'v tiger contact no'],
  // RELACION DE ORIGEN: vTiger ya la trae armada en `cf_3472` con el formato
  // SEDE-PROVEEDOR-CANAL-PADECIMIENTO (verificado identico en 20/20 contactos
  // de Palacios y en todos los de Benavides). Se lee directo, no se compone.
  origenLead: ['origen lead', 'origen del lead'],
  // SEXO: vTiger lo guarda en cf_2821 con valores "Mujer" / "Hombre" / "TERCER".
  // Se publica TAL CUAL viene para no alterar el dato. Cuando no exista el campo
  // en GHL, el descubrimiento no lo resuelve y simplemente no se envía.
  sexo: ['sexo', 'ssexo', 'genero', 'g nero'],
  // --- Campos de negocio que el comprador debe llevar completo ---
  proveedor: ['proveedor', 'v tiger proveedor'],
  canalCaptacion: ['v tiger canal captacion', 'canal captacion', 'canal'],
  tratamientoComprado: ['tratamiento comprado', 'v tiger tratamiento comprado', 'tratamiento'],
  estadoComercial: ['v tiger estado comercial', 'estado comercial'],
  // [IMPORTANTE - NO USAR "Estado de Compra"] Ese campo es DEL NEGOCIO y usa el
  // vocabulario Comprador / No Comprador, con el que ya estan construidas sus
  // Smart Lists. Escribir ahi la etapa de vTiger mezclaba dos vocabularios
  // incompatibles y ROMPIA los filtros: un cliente que si compro pero figuraba
  // como "EN LLAMADA" no aparecia al filtrar por "Comprador".
  // La etapa de vTiger va a su PROPIO campo para no contaminar el del negocio.
  etapaComercial: ['v tiger etapa comercial', 'etapa comercial', 'v tiger estado venta'],
  contactoNo: ['v tiger contact no', 'contact no', 'numero de contacto'],
  asesorAsignado: ['v tiger asesor asignado', 'asesor asignado'],
  fechaCreacion: ['v tiger fecha creacion', 'fecha creacion'],
  anotacionesRedes: ['v tiger anotaciones redes', 'anotaciones redes'],
  // Campo LARGE_TEXT que aloja el detalle de órdenes.
  historialCompleto: ['v tiger historial completo', 'historial completo']
};

// ------------------------------------------------------------------------------
// 2. DESCUBRIMIENTO Y CACHÉ DE CUSTOM FIELDS POR LOCATION
// ------------------------------------------------------------------------------
const fieldCache = new Map(); // locationId -> { nombreNormalizado: fieldId }

function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')      // quita acentos: "Última" -> "ultima"
    .replace(/^contact\./, '')            // quita el prefijo de fieldKey de GHL
    .replace(/[^a-z0-9]+/g, ' ')          // puntuacion y dobles guiones -> espacio
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Elige el mejor campo candidato para un alias, con desambiguación por
 * especificidad: "fecha ultima compra" NO debe resolverse a "fecha compra".
 *
 * @param {Array} campos lista de custom fields de la location
 * @param {string[]} alias nombres aceptados, del más específico al más genérico
 * @returns {object|null}
 */
function elegirCampo(campos, alias) {
  let mejor = null;
  let mejorPuntaje = 0;

  for (const c of campos) {
    const nombre = normalizar(c.name);
    const clave = normalizar(c.fieldKey);
    for (let i = 0; i < alias.length; i++) {
      const a = normalizar(alias[i]);
      if (!a) continue;
      // Preferencia por orden de alias (los primeros son los más específicos)
      const pesoAlias = alias.length - i;

      // Coincidencia exacta: máxima prioridad
      if (nombre === a || clave === a) {
        const puntaje = 1000 * pesoAlias;
        if (puntaje > mejorPuntaje) { mejorPuntaje = puntaje; mejor = c; }
        continue;
      }
      // Coincidencia parcial: el alias está contenido en el nombre/clave
      if (nombre.includes(a) || clave.includes(a)) {
        // Penaliza cuando el nombre real contiene palabras extra no pedidas
        // (ej. "fecha compra" cuando buscamos "fecha ultima compra").
        const extra = Math.abs(nombre.length - a.length);
        const puntaje = 500 * pesoAlias - extra;
        if (puntaje > mejorPuntaje) { mejorPuntaje = puntaje; mejor = c; }
      }
    }
  }

  return mejorPuntaje > 0 ? mejor : null;
}

/**
 * Obtiene el mapa { nombreLogico: fieldId } de una location.
 * Cachea el resultado: el descubrimiento cuesta 1 request por location por proceso.
 *
 * @param {string} locationId
 * @param {object} headers
 */
export async function resolveCustomFieldIds(locationId, headers) {
  if (fieldCache.has(locationId)) return fieldCache.get(locationId);

  const mapa = {};
  try {
    const res = await ghlFetch(
      `https://services.leadconnectorhq.com/locations/${locationId}/customFields`,
      { headers },
      1,
      'Dual Sync'
    );
    if (res.status === 200) {
      const data = await res.json();
      const campos = data.customFields || [];
      for (const [logico, alias] of Object.entries(CAMPOS_REQUERIDOS)) {
        // Permite fijar el ID por entorno: GHL_FIELD_OFICINAORIGEN=xxxx
        const override = readSecret(`GHL_FIELD_${logico.toUpperCase()}`);
        if (override) { mapa[logico] = override; continue; }

        const encontrado = elegirCampo(campos, alias);
        if (encontrado?.id) mapa[logico] = encontrado.id;
      }
      console.log(`[Dual Sync] [FIELDS] Location ${String(locationId).slice(0, 8)}...: ${Object.keys(mapa).length}/${Object.keys(CAMPOS_REQUERIDOS).length} campos resueltos.`);
    } else {
      console.warn(`[Dual Sync] [FIELDS-WARN] No se pudieron leer los custom fields de ${locationId}: HTTP ${res.status}. Se continuará sin mapeo de campos.`);
    }
  } catch (err) {
    console.warn(`[Dual Sync] [FIELDS-WARN] Descubrimiento de campos falló: ${err.message}`);
  }

  fieldCache.set(locationId, mapa);
  return mapa;
}

/** Limpia la caché (pruebas / recreación de campos). */
export function clearFieldCache() {
  fieldCache.clear();
}

// ------------------------------------------------------------------------------
// 3. CLASIFICACIÓN DE CAMPOS: HISTORIAL FINANCIERO PROTEGIDO
// ------------------------------------------------------------------------------
/**
 * Nombres de campo (lógicos o reales) que NO deben sobrescribirse en un
 * reingreso. La protección es por NOMBRE porque el ID varía por location.
 */
export const CAMPOS_HISTORIAL_PROTEGIDOS = [
  'total_compras', 'numero_de_compras', 'num_compras',
  'fecha_ultima_compra', 'fecha_primera_compra', 'fecha_compra',
  'precio_venta', 'monto_invertido',
  'estado_comercial', 'estado_compra_lista'
];

/** Etiquetas de estatus comercial que nunca se retiran en un reingreso. */
export const TAGS_ESTATUS_PROTEGIDAS = [
  'convertido', 'compro', 'cliente-vtiger', 'cliente-comprador', 'venta-cerrada'
];

/** Etiquetas que el middleware está autorizado a gestionar (campaña/interacción). */
const TAGS_GESTIONADAS = ['vtiger', 'vtiger-sincronizado', 'campaña-nueva', 'campana-nueva', 'reingreso'];

/**
 * Limpia un componente del nombre.
 *
 * En vTiger el campo `salutationtype` vale `"."` y a veces ese punto termina en
 * el nombre, produciendo tarjetas como ". PEREZ". También hay valores con
 * espacios sobrantes que generan "ANA     LOPEZ". Se sanea para que la tarjeta
 * del contacto se lea correctamente.
 *
 * @param {string} valor
 * @returns {string} el valor limpio, o '' si no aporta nada
 */
export function limpiarNombre(valor = '') {
  // [DEFECTO CORREGIDO] Sin esta comprobación, `String(null)` produce "null" y
  // `String(0)` produce "0": la tarjeta habría mostrado el literal "null" como
  // nombre. Sólo se aceptan cadenas y números como texto válido.
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'boolean') return '';
  const limpio = String(valor)
    .replace(/\s+/g, ' ')
    .trim();
  // Marcadores vacíos que no son nombres reales
  if (!limpio) return '';
  if (/^[.\-_*]+$/.test(limpio)) return '';
  return limpio;
}

/**
 * Construye los tres campos de nombre que GHL usa, ya saneados.
 * @returns {{firstName: string, lastName: string, name: string|undefined}}
 */
export function buildNombreFields(vContact = {}) {
  const firstName = limpiarNombre(vContact.firstname);
  const lastName = limpiarNombre(vContact.lastname);
  const nombre = [firstName, lastName].filter(Boolean).join(' ').trim();
  return { firstName, lastName, name: nombre || undefined };
}

/**
 * [REGLA DE NEGOCIO - INNEGOCIABLE] Sólo se sincronizan COMPRADORES.
 *
 * Un contacto de vTiger sin compras es un LEAD, y los leads NO se mudan a GHL
 * por este conducto: entran cuando el negocio lo necesita o cuando hay un
 * RECONTACTO (que es otro flujo). Lo que es obligatorio tener sincronizado es la
 * cartera de compradores.
 *
 * Sin esta barrera, cualquier llamada directa (el webhook o un `soloCompradores:
 * false`) podía meter leads en GHL, y el filtro de la consulta no protege eso.
 */
export const SOLO_COMPRADORES = true;

/** ¿El registro de vTiger representa a un comprador? */
export function esRegistroComprador(vContact = {}) {
  return (parseInt(vContact.spl_num_compras || '0', 10) || 0) > 0;
}

/**
 * ¿El campo pertenece al historial financiero protegido?
 * @param {string} nombreCampo nombre lógico o real del campo
 */
export function esCampoHistorialProtegido(nombreCampo = '') {
  const n = normalizar(nombreCampo);
  return CAMPOS_HISTORIAL_PROTEGIDOS.some(p => n.includes(normalizar(p)));
}

/**
 * [MERGE SOP] Separa los custom fields en "seguros de actualizar" y "protegidos".
 *
 * @param {Array<{id:string, field_value:*, nombre?:string}>} campos
 * @param {boolean} contactoExiste si el contacto ya existe, se protege el historial
 * @returns {{ seguros: Array, protegidos: Array }}
 */
export function partitionFields(campos = [], contactoExiste = false) {
  if (!contactoExiste) return { seguros: campos, protegidos: [] };
  const seguros = [];
  const protegidos = [];
  for (const c of campos) {
    if (esCampoHistorialProtegido(c.nombre || c.id)) protegidos.push(c);
    else seguros.push(c);
  }
  return { seguros, protegidos };
}

// ------------------------------------------------------------------------------
// NORMALIZACIÓN DE VALORES MONÓTONOS
// ------------------------------------------------------------------------------
/**
 * Convierte a marca de tiempo cualquier formato de fecha que GHL devuelva.
 * Un campo DATE de GHL se lee como epoch en milisegundos (ej. 1763942400000);
 * vTiger entrega 'YYYY-MM-DD'. Sin normalizar, no se pueden comparar y cualquier
 * comparación daría un resultado falso.
 * @returns {number|null}
 */
export function parseFechaGhl(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const s = String(valor).trim();
  // Epoch en ms (lo que devuelve GHL para sus campos DATE)
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    const ms = s.length === 10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  // ISO / YYYY-MM-DD (lo que entrega vTiger)
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * [AVANCE MONÓTONO] Decide si el dato de vTiger debe ESCRIBIRSE sobre el que ya
 * tiene GHL.
 *
 * POR QUÉ: la protección de historial original era "si el contacto existe, no
 * toques sus campos de compra". Eso impedía que un cliente que VUELVE A COMPRAR
 * actualizara su `Fecha Ultima Compra` -> los campos quedaban congelados en el
 * valor de la primera sincronización. Consecuencia real: el 50% de los contactos
 * en GHL no tenía fecha de última compra, y una Smart List de "compras de la
 * última semana" (base de una campaña de SMS) no podía funcionar.
 *
 * La regla correcta NO es "no tocar", sino "no retroceder":
 *   - si el contacto no tiene el dato -> se escribe;
 *   - si el dato de vTiger es MÁS RECIENTE -> se escribe (hubo compra nueva);
 *   - si es más antiguo o igual -> NO se escribe (se protege lo que ya hay).
 *
 * @param {*} valorVtiger valor entrante (YYYY-MM-DD)
 * @param {*} valorGhl    valor actual en GHL (epoch ms o YYYY-MM-DD)
 * @returns {boolean} true si se debe escribir
 */
export function debeAvanzarFecha(valorVtiger, valorGhl) {
  const nuevo = parseFechaGhl(valorVtiger);
  if (nuevo === null) return false;            // sin dato válido no se escribe nada
  const actual = parseFechaGhl(valorGhl);
  if (actual === null) return true;            // GHL no tiene el dato: se escribe
  return nuevo > actual;                       // sólo avanza, nunca retrocede
}

/**
 * Aplica la regla monótona a una lista de campos ya construidos.
 * `existentes` es el mapa { nombreLogico: valorActualEnGhl } del contacto.
 * Los campos sin valor actual en GHL pasan siempre (son un alta de dato).
 *
 * @param {Array} campos
 * @param {object} existentes
 * @returns {{ avanzan: Array, congelados: Array }}
 */
export function splitCamposMonotonos(campos = [], existentes = {}) {
  const avanzan = [];
  const congelados = [];
  for (const c of campos) {
    const actual = existentes?.[c.nombre];
    if (actual === undefined || actual === null || actual === '') { avanzan.push(c); continue; }
    const entrante = c.field_value;
    // Se comparan como fechas sólo los campos que lo son; el resto (contadores)
    // avanza si el valor entrante es mayor numéricamente.
    const esFecha = /^\d{4}-\d{2}-\d{2}/.test(String(entrante));
    if (esFecha) {
      if (debeAvanzarFecha(entrante, actual)) avanzan.push(c); else congelados.push(c);
    } else {
      // Sólo los CONTADORES se comparan numéricamente (total de compras, monto,
      // gasto histórico). Un campo que no es número en ninguno de los dos lados
      // (ids, textos, códigos) NO es comparable: se deja pasar para que el dato
      // se mantenga al día en lugar de quedar bloqueado por un NaN.
      const n = parseFloat(String(entrante).replace(/[^0-9.-]/g, ''));
      const a = parseFloat(String(actual).replace(/[^0-9.-]/g, ''));
      const soloDigitos = (v) => /^[0-9]+([.,][0-9]+)?$/.test(String(v).trim());
      if (/^-?\d+(\.\d+)?$/.test(String(entrante).trim()) && /^-?\d+(\.\d+)?$/.test(String(actual).trim())
          && Number.isFinite(n) && Number.isFinite(a)) {
        if (soloDigitos(entrante) && !soloDigitos(actual)) { avanzan.push(c); }
        else if (n > a) avanzan.push(c);
        else congelados.push(c);
      } else {
        avanzan.push(c);   // no comparable: se deja pasar
      }
    }
  }
  return { avanzan, congelados };
}

/**
 * [MERGE SOP] Combina las etiquetas actuales con las nuevas preservando el estatus.
 *
 * @param {string[]} actuales etiquetas que ya tiene el contacto en GHL
 * @param {string[]} nuevas etiquetas que el middleware quiere añadir
 * @returns {{ tags: string[], preservadas: string[], removidas: string[] }}
 */
export function mergeTagsPreservingStatus(actuales = [], nuevas = []) {
  const set = new Set([...actuales, ...nuevas].map(t => String(t).trim()).filter(Boolean));
  const preservadas = [];
  const removidas = [];

  for (const tag of TAGS_ESTATUS_PROTEGIDAS) {
    if (set.has(tag)) preservadas.push(tag);
  }

  // Gestionadas: si el contacto ya tiene 'convertido', 'compro' se conserva y no
  // se intenta degradar el estado comercial por un reingreso.
  const tieneConvertido = set.has('convertido') || set.has('compro') || set.has('cliente-vtiger');
  if (tieneConvertido) {
    set.delete('no-compro');
    set.delete('prospecto-vtiger');
    if (set.has('no-compro')) removidas.push('no-compro');
  }

  return { tags: [...set], preservadas, removidas };
}

// ------------------------------------------------------------------------------
// 4. CONSTRUCCIÓN DEL PAYLOAD DESDE vTiger
// ------------------------------------------------------------------------------
/**
 * Extrae el teléfono de un registro de vTiger.
 * PRIORIDAD MEDIDA EN VIVO: `homephone` es donde está el 100% de los números
 * reales de los clientes con compra; `mobile`/`phone` suelen venir vacíos.
 */
export function pickPhone(vContact = {}) {
  return normalizeToE164(
    vContact.homephone || vContact.mobile || vContact.phone || vContact.otherphone || ''
  );
}

/**
 * Normaliza el nombre de sede de vTiger (`cf_3451`) al `sedeId` del gateway.
 * @returns {string|null}
 */
export function resolveSedeFromVtiger(vContact = {}) {
  const raw = String(vContact.cf_3451 || vContact.sede || '').toUpperCase().replace(/[^A-Z]/g, '');
  const conf = SEDES_GATEWAY[raw];
  if (!conf) return null;
  return conf.sedeId;
}

/**
 * Construye las dos cargas del upsert (macro y operativa) a partir del registro
 * de vTiger, ya saneadas.
 *
 * @param {object} vContact   registro de vTiger
 * @param {object} [opts]
 * @param {boolean} [opts.incluirHistorial=true] si el contacto es nuevo, el historial viaja
 * @param {object} [opts.fieldIdsCentral] mapa de IDs descubiertos de la Central
 * @param {object} [opts.fieldIdsSede]    mapa de IDs descubiertos de la sede
 * @param {object} [opts.ghlExistenteCentral] contacto actual en la Central
 * @param {object} [opts.ghlExistenteSede]    contacto actual en la sede
 */
export function buildUpsertPayloads(vContact = {}, opts = {}) {
  const {
    incluirHistorial = true,
    fieldIdsCentral = {},
    fieldIdsSede = {},
    ghlExistenteCentral = null,
    ghlExistenteSede = null
  } = opts;

  const phone = pickPhone(vContact);
  const sedeId = resolveSedeFromVtiger(vContact);
  const sedeConf = sedeId ? SEDES_GATEWAY[sedeId] : null;

  // --- Geografía saneada (ciudad vs estado) ---
  const geo = buildSanitizedGeoFields(vContact, {}, {});

  // --- Tratamiento canónico ---
  const tratamiento = normalizeTreatment(vContact.cf_2610) || '';

  const nombre = [vContact.firstname, vContact.lastname].filter(Boolean).join(' ').trim();
  // Nombre saneado: vTiger trae basura como salutationtype "." o espacios dobles.
  const nombreLimpio = buildNombreFields(vContact);
  const compras = parseInt(vContact.spl_num_compras || '0', 10) || 0;
  const esComprador = compras > 0;

  // ==========================================================================
  // MAPEO COMPLETO vTiger -> GHL (solo se publica en campos que EXISTEN)
  // ==========================================================================
  // Inventario verificado en vivo. vTiger expone 93 campos del contacto (40 con
  // valor). La Cuenta Empresa tiene 41 personalizados y las sedes 29. Se mapea
  // todo lo que tiene destino real; lo que no lo tiene se OMITE en vez de
  // inventar campos o escribir datos en el lugar equivocado.
  //
  // | vTiger                       | GHL                                    |
  // |------------------------------|----------------------------------------|
  // | firstname / lastname         | firstName / lastName (nativos)         |
  // | email                        | email (nativo)                         |
  // | homephone (prioritario)      | phone (nativo)                         |
  // | cf_2572 proveedor            | Proveedor (pendiente de crear)         |
  // | cf_2610 padecimiento         | Tratamiento comprado                   |
  // | cf_3507 canal                | vTiger Canal Captacion                 |
  // | cf_3472 campana              | vTiger Campana Origen / UTM Campaign   |
  // | splareacodes_state(_code)    | state (nativo, saneado)                |
  // | cf_1157 ciudad               | city (nativo)                          |
  // | spl_fecha_ultima_compra      | vTiger Fecha Ultima Compra             |
  // | spl_fecha_primera_compra     | vTiger Fecha Primera Compra            |
  // | spl_num_compras              | vTiger Total Compras                   |
  // | cf_3392 gasto ACUMULADO      | vTiger Total Historico Gastado USD     |
  // | cf_994 estado de venta       | Estado de Compra                       |
  // | cf_1876 estado del embudo    | vTiger Estado Comercial                |
  // | contact_no                   | vTiger Contact No                      |
  // | wcf_acf_atf_3390 asesor      | vTiger Asesor Asignado (solo Empresa)  |
  // | createdtime                  | vTiger Fecha Creacion (solo Empresa)   |
  // | Splash: sin campo destino    | cf_3561 (valor "49", no es anotacion)  |
  // |                              | se DESCARTA: no aporta informacion     |
  // ==========================================================================

  /** Valores comerciales ya normalizados, compartidos por ambas cargas. */
  // [ANTI-ALUCINACION] El estado SÓLO se publica si es un estado real de EE.UU.,
  // validado contra la lista oficial. Antes existía un fallback que escribía el
  // valor crudo sin validar y colaba códigos inválidos (se detectó "VI", que
  // además ni es Virginia: es VA). Es preferible dejar el campo vacío que
  // escribir un valor que no corresponde.
  const estadoResuelto = (() => {
    const codigo = String(vContact.splareacodes_state_code || '').trim().toUpperCase();
    const nombre = String(vContact.splareacodes_state || '').trim();
    if (isUsStateCode(codigo)) return codigo;
    if (isUsStateName(nombre)) return normalizeUsState(nombre);
    if (isUsStateName(codigo)) return normalizeUsState(codigo);
    if (isUsStateCode(nombre)) return nombre.toUpperCase();
    // Nada válido: se OMITE el estado (nunca se escribe un valor sin validar).
    return '';
  })();
  // La zona horaria de vTiger viene como "ESTE"/"PACIFICO"/"CENTRO"/"MONTAÑA" y
  // NO se publica en ningún campo: GHL gestiona su propio `timezone` y escribir
  // una zona inventada es precisamente lo que no debe hacerse.

  // --- Carga MACRO (Cuenta Empresa / Data Warehouse) ---
  const camposMacro = [];
  const push = (mapa, logico, valor) => {
    if (mapa?.[logico] && valor !== undefined && valor !== null && valor !== '') {
      camposMacro.push({ id: mapa[logico], nombre: logico, field_value: valor });
    }
  };

  // Identificación y origen (siempre, para que el contacto quede completo)
  push(fieldIdsCentral, 'oficinaOrigen', sedeId || vContact.cf_3451 || '');
  push(fieldIdsCentral, 'campanaOrigen', vContact.cf_3472 || '');
  // RELACION DE ORIGEN en el campo "Origen Lead": se publica EXACTAMENTE el valor
  // de vTiger (`cf_3472`), sin recomponerlo ni reformatearlo. Verificado identico
  // a la construccion SEDE-PROVEEDOR-CANAL-PADECIMIENTO en el 100% de la muestra.
  push(fieldIdsCentral, 'origenLead', vContact.cf_3472 || '');
  push(fieldIdsCentral, 'canalCaptacion', vContact.cf_3507 || '');
  push(fieldIdsCentral, 'tratamientoComprado', tratamiento || vContact.cf_2610 || '');
  push(fieldIdsCentral, 'contactoNo', vContact.contact_no || '');
  // SEXO: se publica EXACTAMENTE el valor de vTiger ("Mujer" / "Hombre" /
  // "TERCER"), sin normalizar mayusculas ni traducir, para no alterar el dato.
  push(fieldIdsCentral, 'sexo', String(vContact.cf_2821 || '').trim());
  push(fieldIdsCentral, 'etapaComercial', vContact.cf_994 || '');
  push(fieldIdsCentral, 'estadoComercial', vContact.cf_1876 || '');
  push(fieldIdsCentral, 'asesorAsignado', vContact.wcf_acf_atf_3390 || '');
  push(fieldIdsCentral, 'fechaCreacion', String(vContact.createdtime || '').slice(0, 10));
  if (vContact.cf_2572) {
    let prov = String(vContact.cf_2572).trim().toUpperCase();
    if (/pikalex|pikales/i.test(prov)) prov = 'CLICK2RING';
    push(fieldIdsCentral, 'proveedor', prov);
  }
  push(fieldIdsCentral, 'ultimaInteraccion', new Date().toISOString());

  if (incluirHistorial) {
    // [AVANCE MONÓTONO] El historial se construye SIEMPRE, aunque el contacto ya
    // exista. Antes se omitía para "proteger" el historial, pero eso CONGELABA
    // `Fecha Ultima Compra`: un cliente que volvía a comprar nunca actualizaba su
    // fecha, y la mitad de los contactos en GHL quedó sin ella. Ahora el filtro
    // `soloAvances` decide campo por campo: escribe si GHL no lo tiene o si el
    // dato de vTiger es más reciente, y lo omite si retrocedería.
    push(fieldIdsCentral, 'totalCompras', String(compras));
    push(fieldIdsCentral, 'fechaUltimaCompra', vContact.spl_fecha_ultima_compra || '');
    push(fieldIdsCentral, 'fechaPrimeraCompra', vContact.spl_fecha_primera_compra || '');
    push(fieldIdsCentral, 'precioVenta', String(vContact.cf_3392 || ''));
    push(fieldIdsCentral, 'idClienteVt', vContact.id || '');
    // `cf_3392` fue VERIFICADO en vivo como el GASTO TOTAL ACUMULADO.
    if (vContact.cf_3392) push(fieldIdsCentral, 'totalHistorico', String(vContact.cf_3392));
  }

  const macro = {
    locationId: CENTRAL_LOCATION_ID,
    phone,
    firstName: nombreLimpio.firstName,
    lastName: nombreLimpio.lastName,
    name: nombreLimpio.name,
    email: vContact.email || undefined,
    // La ciudad sale de cf_1157 (la operativa real); el estado de splareacodes_*
    // porque mailingcity/mailingstate están restringidos por rol.
    city: geo.find(g => g.key === 'city')?.field_value || undefined,
    state: geo.find(g => g.key === 'state')?.field_value || estadoResuelto || undefined,
    source: 'vTiger',
    customFields: camposMacro
  };

  // --- Carga OPERATIVA (subcuenta de la sede) ---
  const camposSede = [];
  const pushSede = (logico, valor) => {
    if (fieldIdsSede?.[logico] && valor !== undefined && valor !== null && valor !== '') {
      camposSede.push({ id: fieldIdsSede[logico], nombre: logico, field_value: valor });
    }
  };

  pushSede('oficinaOrigen', sedeId || '');
  pushSede('campanaOrigen', vContact.cf_3472 || '');
  // En la sede "Origen Lead" tambien recibe la relacion completa (es TEXT ahi).
  pushSede('origenLead', vContact.cf_3472 || '');
  pushSede('canalCaptacion', vContact.cf_3507 || '');
  pushSede('tratamientoComprado', tratamiento || vContact.cf_2610 || '');
  pushSede('contactoNo', vContact.contact_no || '');
  // La sede tambien recibe el sexo (es dato de atencion al cliente).
  pushSede('sexo', String(vContact.cf_2821 || '').trim());
  pushSede('etapaComercial', vContact.cf_994 || '');
  pushSede('estadoComercial', vContact.cf_1876 || '');
  if (vContact.cf_2572) {
    let prov = String(vContact.cf_2572).trim().toUpperCase();
    if (/pikalex|pikales/i.test(prov)) prov = 'CLICK2RING';
    pushSede('proveedor', prov);
  }
  pushSede('ultimaInteraccion', new Date().toISOString());

  if (incluirHistorial) {
    pushSede('totalCompras', String(compras));
    pushSede('fechaUltimaCompra', vContact.spl_fecha_ultima_compra || '');
    pushSede('fechaPrimeraCompra', vContact.spl_fecha_primera_compra || '');
    pushSede('precioVenta', String(vContact.cf_3392 || ''));
    pushSede('idClienteVt', vContact.id || '');
  }

  const operativa = {
    locationId: sedeConf?.ghl?.locationId || null,
    phone,
    firstName: nombreLimpio.firstName,
    lastName: nombreLimpio.lastName,
    name: nombreLimpio.name,
    email: vContact.email || undefined,
    city: geo.find(g => g.key === 'city')?.field_value || undefined,
    state: geo.find(g => g.key === 'state')?.field_value || estadoResuelto || undefined,
    source: vContact.cf_3472 || 'vTiger',
    customFields: camposSede
  };

  // [MERGE SOP -> AVANCE MONÓTONO] Ya NO se bloquea el historial cuando el
  // contacto existe. Bloquearlo congelaba `Fecha Ultima Compra` en el valor de la
  // primera sincronización, así que un cliente que VOLVÍA A COMPRAR nunca
  // actualizaba su fecha: el 50% de los contactos en GHL quedó sin fecha, y la
  // Smart List "compras de la última semana" (base de una campaña de SMS) no
  // podía funcionar. La regla correcta es "no retroceder", no "no tocar".
  //
  // `ghlExistente*` puede venir como objeto de contacto (con customFields) o como
  // simple booleano. Se extrae el valor actual de cada campo para compararlo.
  // Mapa { idDeCampoGHL: valorActual } a partir del contacto que ya existe en GHL.
  // Se indexa por ID porque es lo único estable entre las tres cuentas (los campos
  // lógicos se resuelven a IDs distintos en cada location).
  const valoresActuales = (existente) => {
    const mapa = {};
    if (!existente || typeof existente !== 'object') return mapa;
    for (const f of (existente.customFields || [])) {
      const valor = f.value ?? f.field_value;
      if (valor !== undefined && valor !== null && valor !== '') mapa[f.id] = valor;
    }
    return mapa;
  };
  const porIdMacro = valoresActuales(ghlExistenteCentral);
  const porIdSede = valoresActuales(ghlExistenteSede);

  /**
   * Deja pasar SÓLO los campos que aportan avance. Un campo cuyo valor actual en
   * GHL ya es igual o más reciente que el de vTiger se descarta del payload, así
   * no se pisa información buena con información vieja.
   */
  const soloAvances = (campos, porId) => campos.filter(c => {
    const actual = porId[c.id];
    if (actual === undefined) return true;   // GHL no tiene el dato: se escribe
    const r = splitCamposMonotonos([c], { [c.nombre]: actual });
    return r.avanzan.length > 0;
  });

  macro.customFields = soloAvances(macro.customFields, porIdMacro);
  operativa.customFields = soloAvances(operativa.customFields, porIdSede);

  const particionMacro = { protegidos: [] };
  const particionSede = { protegidos: [] };

  const tagsNuevas = ['vtiger', 'vtiger-sincronizado'];
  if (esComprador) tagsNuevas.push('compro', 'convertido', 'cliente-vtiger');
  if (tratamiento) tagsNuevas.push(`producto-${tratamiento.toLowerCase()}`);

  return {
    phone,
    sedeId,
    esComprador,
    tratamiento,
    macro,
    operativa,
    protegidos: {
      macro: particionMacro.protegidos,
      sede: particionSede.protegidos
    },
    tagsNuevas
  };
}

// ------------------------------------------------------------------------------
// 5. BÚSQUEDA PREVIA (necesaria para decidir si se protege el historial)
// ------------------------------------------------------------------------------
/**
 * Busca un contacto por teléfono dentro de una location.
 *
 * CORRECCIÓN VERIFICADA EN VIVO: `/contacts/search` responde **HTTP 400** en esta
 * cuenta, por lo que la búsqueda devolvía `null` siempre y el motor concluía
 * "no existe" aunque el contacto sí existiera. El endpoint correcto es
 * `/contacts/?locationId=...&query=...`.
 *
 * @returns {object|null} contacto existente o null
 */
export async function findContactByPhone(locationId, phone, headers) {
  if (!locationId || !phone) return null;
  const limpio = String(phone).replace(/\D/g, '');
  try {
    const res = await ghlFetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&query=${limpio}`,
      { headers },
      1,
      'Dual Sync'
    );
    if (res.status !== 200) {
      console.warn(`[Dual Sync] [SEARCH-WARN] Búsqueda de contacto HTTP ${res.status} en ${locationId}.`);
      return null;
    }
    const data = await res.json();
    const contactos = data.contacts || [];
    // Se prefiere el que coincida por los últimos 10 dígitos (NANP).
    return contactos.find(c => String(c.phone || '').replace(/\D/g, '').endsWith(limpio.slice(-10))) || contactos[0] || null;
  } catch (err) {
    console.warn(`[Dual Sync] [SEARCH-WARN] ${locationId}: ${err.message}`);
    return null;
  }
}

// ------------------------------------------------------------------------------
// 6. UPSERT CON PROTECCIÓN DE HISTORIAL
// ------------------------------------------------------------------------------
/**
 * Ejecuta un upsert hacia una location aplicando el MERGE SOP.
 *
 * @param {object} payload carga base (con locationId, phone, customFields…)
 * @param {object} ctx
 * @param {string} ctx.apiKey
 * @param {object} ctx.headers
 * @param {object|null} ctx.existente contacto ya existente en esa location
 * @param {string[]} ctx.tagsNuevas
 * @returns {Promise<{ok:boolean, created:boolean, contactId:string|null, status:number, error?:string, tagsPreservadas:string[]}>}
 */
export async function upsertWithHistoryProtection(payload, ctx = {}) {
  const { headers, existente = null, tagsNuevas = [] } = ctx;

  const body = { ...payload };
  if (!body.locationId) {
    return { ok: false, created: false, contactId: null, status: 0, error: 'locationId ausente', tagsPreservadas: [] };
  }

  // Etiquetas: en un reingreso se preserva el estatus comercial.
  const tagsActuales = (existente?.tags || []);
  const merged = mergeTagsPreservingStatus(tagsActuales, tagsNuevas);
  if (merged.tags.length > 0) body.tags = merged.tags;

  delete body.postalCode;

  const res = await ghlFetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers: { ...headers, 'Version': '2021-07-28' },
    body: JSON.stringify(body)
  }, 1, 'Dual Sync');

  if (res.status === 200 || res.status === 201) {
    const data = await res.json().catch(() => ({}));
    const contactId = data?.contact?.id || data?.id || null;
    // [FUENTE DE VERDAD] La respuesta del upsert trae `new: true` cuando CREA el
    // contacto y `new: false` cuando lo ACTUALIZA (verificado en vivo). Antes se
    // inferia de la busqueda previa, que falla por el retraso de indexacion de
    // GHL: recien creado el contacto, la busqueda devuelve vacio y el motor
    // reportaba `created: true` en cada corrida aunque ya existiera.
    const created = typeof data?.new === 'boolean' ? data.new : !existente;
    return {
      ok: true,
      created,
      contactId,
      status: res.status,
      tagsPreservadas: merged.preservadas
    };
  }

  const errorText = await res.text().catch(() => '');
  return {
    ok: false,
    created: false,
    contactId: null,
    status: res.status,
    error: errorText.slice(0, 300),
    tagsPreservadas: merged.preservadas
  };
}

// ------------------------------------------------------------------------------
// 7. ORQUESTADOR: SINCRONIZACIÓN DUAL
// ------------------------------------------------------------------------------
/**
 * Procesa UN registro de vTiger y lo distribuye a las cuentas configuradas.
 *
 * @param {object} vContact
 * @returns {Promise<object>} resultado discriminado
 */
export async function syncVtigerContactDual(vContact = {}, { permitirLead = false } = {}) {
  const phone = pickPhone(vContact);
  const nombre = `${vContact.firstname || ''} ${vContact.lastname || ''}`.trim();

  // --- [REGLA DE NEGOCIO] Sólo compradores ---
  // Los leads no se mudan por este conducto: entran por necesidad del negocio o
  // por RECONTACTO (otro flujo). `permitirLead` existe únicamente para ese caso
  // explícito; nunca se activa por defecto.
  if (SOLO_COMPRADORES && !permitirLead && !esRegistroComprador(vContact)) {
    recordAuditEvent({
      type: 'DUAL_SYNC_SKIPPED_NOT_BUYER',
      severity: 'info',
      vTigerId: vContact.id || null,
      nombre: nombre.slice(0, 60),
      sede: vContact.cf_3451 || null,
      compras: parseInt(vContact.spl_num_compras || '0', 10) || 0,
      reason: 'sólo se sincronizan compradores; los leads entran por recontacto'
    });
    console.log(`[Dual Sync] [SKIP-LEAD] ${nombre || vContact.id} no tiene compras: no se muda (regla: sólo compradores).`);
    return { ok: false, skipped: true, reason: 'no es comprador (los leads no se sincronizan)' };
  }

  // --- VALIDACIÓN (Drop Rule) ---
  if (!phone) {
    recordAuditEvent({
      type: 'DUAL_SYNC_DROPPED_NO_PHONE',
      severity: 'warn',
      vTigerId: vContact.id || null,
      nombre: nombre.slice(0, 60),
      sede: vContact.cf_3451 || null,
      reason: 'sin teléfono válido en formato E.164'
    });
    return { ok: false, skipped: true, reason: 'sin teléfono válido' };
  }

  const sedeId = resolveSedeFromVtiger(vContact);
  if (!sedeId) {
    recordAuditEvent({
      type: 'DUAL_SYNC_DROPPED_NO_SEDE',
      severity: 'warn',
      vTigerId: vContact.id || null,
      nombre: nombre.slice(0, 60),
      sedeRecibida: vContact.cf_3451 || '(vacío)',
      reason: 'sede no reconocida en cf_3451'
    });
    return { ok: false, skipped: true, reason: 'sede no reconocida' };
  }

  // La sede debe estar configurada (PIT + Location ID)
  if (SEDES_GATEWAY[sedeId].isConfigured === false) {
    recordAuditEvent({
      type: 'DUAL_SYNC_DROPPED_SEDE_UNCONFIGURED',
      severity: 'error',
      vTigerId: vContact.id || null,
      sede: sedeId
    });
    return { ok: false, skipped: true, reason: `sede ${sedeId} sin credenciales` };
  }

  const resultado = { ok: true, phone, sedeId, macro: null, operativa: null, contactId: null };

  // --- API KEY de cada destino (cada subcuenta usa la suya) ---
  const sedeHeaders = {
    'Authorization': `Bearer ${SEDES_GATEWAY[sedeId].ghl.apiKey}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  // ====== LLAMADA 1: MACRO (Cuenta Empresa) ======
  if (isCentralConfigured()) {
    const centralHeaders = {
      'Authorization': `Bearer ${CENTRAL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    const fieldsCentral = await resolveCustomFieldIds(CENTRAL_LOCATION_ID, centralHeaders);
    const existenteCentral = await findContactByPhone(CENTRAL_LOCATION_ID, phone, centralHeaders);

    const construido = buildUpsertPayloads(vContact, {
      incluirHistorial: !existenteCentral,
      fieldIdsCentral: fieldsCentral,
      ghlExistenteCentral: existenteCentral
    });

    resultado.macro = await upsertWithHistoryProtection(construido.macro, {
      headers: centralHeaders,
      existente: existenteCentral,
      tagsNuevas: construido.tagsNuevas
    });

    recordAuditEvent({
      type: construido.macro.ok ? 'DUAL_SYNC_MACRO_OK' : 'DUAL_SYNC_MACRO_FAIL',
      severity: construido.macro.ok ? 'info' : 'error',
      vTigerId: vContact.id,
      sede: sedeId,
      created: construido.macro.created,
      status: construido.macro.status,
      error: construido.macro.error
    });
  } else {
    console.log('[Dual Sync] [MACRO-SKIP] Cuenta Empresa no configurada (GHL_LOCATION_ID_CENTRAL / GHL_API_KEY_CENTRAL ausentes). Se sincroniza solo la sede.');
  }

  // ====== LLAMADA 2: OPERATIVA (subcuenta de la sede) ======
  const sedeLocId = SEDES_GATEWAY[sedeId].ghl.locationId;
  const fieldsSede = await resolveCustomFieldIds(sedeLocId, sedeHeaders);
  const existenteSede = await findContactByPhone(sedeLocId, phone, sedeHeaders);

  const construidoSede = buildUpsertPayloads(vContact, {
    incluirHistorial: !existenteSede,
    fieldIdsSede: fieldsSede,
    ghlExistenteSede: existenteSede
  });

  resultado.operativa = await upsertWithHistoryProtection(construidoSede.operativa, {
    headers: sedeHeaders,
    existente: existenteSede,
    tagsNuevas: construidoSede.tagsNuevas
  });
  resultado.contactId = resultado.operativa.contactId;
  resultado.created = resultado.operativa.created;

  recordAuditEvent({
    type: resultado.operativa.ok ? 'DUAL_SYNC_SEDE_OK' : 'DUAL_SYNC_SEDE_FAIL',
    severity: resultado.operativa.ok ? 'info' : 'error',
    vTigerId: vContact.id,
    sede: sedeId,
    locationId: sedeLocId,
    created: resultado.operativa.created,
    status: resultado.operativa.status,
    error: resultado.operativa.error,
    historialProtegido: resultado.operativa.tagsPreservadas
  });

  // ====== PASO 3: HISTORIAL DE COMPRAS (detalle de órdenes) ======
  // Se ejecuta DESPUÉS de crear/actualizar el contacto: el historial necesita que
  // el contacto ya exista para poder encontrar su id por teléfono.
  // [INTEGRACIÓN] Sin este paso, el puente de ventas creaba el contacto pero NO
  // publicaba el detalle de sus compras: quedaba como resumen sin desglose.
  // Import dinámico para evitar dependencia circular (el módulo de historial
  // importa utilidades de este servicio).
  if (resultado.operativa.ok) {
    try {
      const { syncContactOrderHistory } = await import('./vtiger_order_history_service.js');
      // Se pasan los ids que devolvió el upsert: evita depender del índice de
      // búsqueda de GHL, que tarda en reflejar un contacto recién creado.
      const historial = await syncContactOrderHistory({
        vContact,
        contactIdSede: resultado.operativa.contactId,
        contactIdMacro: resultado.macro?.contactId || null
      });
      resultado.historial = {
        ok: Boolean(historial?.operativa?.nota?.ok),
        ordenes: historial?.ordenes || 0,
        motivo: historial?.skipped ? historial.reason : null
      };
    } catch (err) {
      // El historial es un enriquecimiento: su fallo NO debe invalidar el alta
      // del contacto, que es el dato crítico.
      console.warn(`[Dual Sync] [HISTORIAL-WARN] No se pudo publicar el historial de ${vContact.id}: ${err.message}`);
      resultado.historial = { ok: false, error: err.message };
    }
  }

  // [CONTRATO DE SALIDA] Se normalizan `ok` y `skipped` a nivel RAIZ.
  // DEFECTO CORREGIDO: antes el camino de exito devolvia solo `resultado`
  // (con ok dentro de macro/operativa), asi que `syncVtigerBatchDual` no
  // encontraba `r.ok` y contaba TODO contacto sincronizado como FALLIDO.
  // El criterio de exito es la SUBCUENTA DE LA SEDE (el destino comercial);
  // la Cuenta Empresa es enriquecimiento y su fallo no invalida el alta.
  resultado.ok = Boolean(resultado.operativa?.ok);
  resultado.skipped = false;
  resultado.created = Boolean(resultado.operativa?.created);
  return resultado;
}

/**
 * Procesa un lote de registros de vTiger secuencialmente (respeta el rate limit
 * del cliente GHL compartido) y devuelve el resumen del lote.
 */
export async function syncVtigerBatchDual(registros = [], { pausaMs = 250 } = {}) {
  const resumen = { total: registros.length, creados: 0, actualizados: 0, descartados: 0, fallidos: 0, detalle: [] };

  for (const vContact of registros) {
    const nombre = `${vContact?.firstname || ''} ${vContact?.lastname || ''}`.trim();
    const telefono = pickPhone(vContact);
    const sede = String(vContact?.cf_3451 || '').toUpperCase().trim();
    try {
      const r = await syncVtigerContactDual(vContact);
      let accion;
      if (r.skipped) { resumen.descartados++; accion = 'descartado'; }
      else if (r.ok) {
        if (r.created) { resumen.creados++; accion = 'creado'; }
        else { resumen.actualizados++; accion = 'actualizado'; }
      } else { resumen.fallidos++; accion = 'fallido'; }

      // Detalle por contacto: permite auditar QUE paso con cada uno.
      resumen.detalle.push({
        accion,
        sede: sede || null,
        vTigerId: vContact?.id || null,
        nombre,
        telefono: telefono || null,
        macroOk: Boolean(r.macro?.ok),
        historialOk: Boolean(r.historial?.ok),
        motivo: r.reason || r.operativa?.reason || r.macro?.error || null
      });
    } catch (err) {
      resumen.fallidos++;
      resumen.detalle.push({
        accion: 'fallido', sede: sede || null, vTigerId: vContact?.id || null,
        nombre, telefono: telefono || null, motivo: err.message
      });
      recordAuditEvent({
        type: 'DUAL_SYNC_EXCEPTION',
        severity: 'error',
        vTigerId: vContact?.id || null,
        message: err.message
      });
    }
    if (pausaMs > 0) await new Promise(r => setTimeout(r, pausaMs));
  }

  console.log(`[Dual Sync] [BATCH] ${JSON.stringify({ ...resumen, detalle: resumen.detalle.length + ' contactos' })}`);
  return resumen;
}
