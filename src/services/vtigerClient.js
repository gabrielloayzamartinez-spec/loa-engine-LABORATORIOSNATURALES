/**
 * ==============================================================================
 * LOA ENGINE - VTIGER CLIENT (AUTENTICACIÓN CENTRALIZADA + REINTENTOS SEGUROS)
 * ==============================================================================
 * MODELO DE ACCESO VIGENTE:
 * UNA (1) cuenta de Administrador con acceso global. La datación se separa por
 * el campo nativo de sede (`cf_3451`), no por credenciales distintas.
 *
 * RESPONSABILIDADES DE ESTE MÓDULO:
 * 1. Leer las credenciales EXCLUSIVAMENTE de `process.env` (cero hardcoding).
 * 2. Validarlas en el arranque SIN matar el proceso (fail-safe de Render):
 *    si faltan, el motor arranca degradado y vTiger queda "no configurado".
 * 3. Ejecutar `operation=query` con 3 reintentos y backoff exponencial + jitter.
 * 4. Registrar cada fallo en un log de auditoría estructurado (JSONL).
 * 5. Exponer el diccionario NATIVO de vTiger (módulos y campos `cf_`), para que
 *    ningún otro módulo invente nombres intermedios.
 *
 * La capa de sanitización es obligatoria: `sanitizeForVtigerQuery` / `digitsOnly`.
 * ==============================================================================
 */

import crypto from 'crypto';
import { readSecret, envInt } from '../config/secrets.js';
import { sanitizeForVtigerQuery, digitsOnly } from '../utils/sanitize.js';
import { recordAuditEvent } from './audit_logger.js';

// ------------------------------------------------------------------------------
// 0. CANDADO DE SOLO LECTURA (INNEGOCIABLE)
// ------------------------------------------------------------------------------
/**
 * ==============================================================================
 * LOA ENGINE **NO ESCRIBE, NO MODIFICA Y NO INYECTA** DATOS EN VTIGER. NUNCA.
 * ==============================================================================
 * vTiger es un SENSOR CONSULTIVO: el motor lo lee (ver y oír) y jamás lo altera.
 * Esa regla NO puede depender de la disciplina del desarrollador: se impone en
 * tres capas, de modo que una escritura sea ESTRUCTURALMENTE IMPOSIBLE.
 *
 *   CAPA 1 — Método HTTP : sólo GET (lecturas). POST se admite ÚNICAMENTE para
 *                          el handshake de login. PUT/PATCH/DELETE: prohibidos.
 *   CAPA 2 — Operación   : allow-list estricta (`query`, `getchallenge`, `login`).
 *                          `create`, `update`, `delete`, `revise`, `save`, etc.
 *                          se rechazan antes de tocar la red.
 *   CAPA 3 — Sentencia   : toda consulta debe empezar con SELECT. `UPDATE`,
 *                          `DELETE`, `INSERT`, `DROP`, `ALTER`, `TRUNCATE` y
 *                          cualquier `INTO` se bloquean en el borde.
 *
 * HALLAZGO QUE ORIGINÓ ESTE CANDADO: el gate de aislamiento sólo verificaba la
 * presencia de `cf_3451`, así que `DELETE FROM Contacts WHERE cf_3451 = 'PALACIOS'`
 * pasaba como "consulta válida". La regla estaba documentada, no impuesta.
 * ==============================================================================
 */

// ------------------------------------------------------------------------------
// 1. DICCIONARIO NATIVO DE VTIGER (modulos y campos reales del CRM)
// ------------------------------------------------------------------------------

/** Operaciones de vTiger PERMITIDAS (allow-list, no deny-list). */
export const VTIGER_ALLOWED_OPERATIONS = ['query', 'getchallenge', 'login'];

/** Verbos SQL de escritura/DDL que jamás deben salir del motor. */
const SQL_WRITE_VERBS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|MERGE|GRANT|REVOKE|EXEC|EXECUTE|CALL)\b/i;

/** Excepción de violación del candado de solo lectura. */
export class VtigerReadOnlyViolation extends Error {
  constructor(message, { stage = null, detail = null } = {}) {
    super(message);
    this.name = 'VtigerReadOnlyViolation';
    this.code = 'VTIGER_READ_ONLY_VIOLATION';
    this.stage = stage;
    this.detail = detail;
  }
}

/** Contador de intentos de escritura bloqueados (observabilidad / alerta). */
export const readOnlyGuardStats = { blocked: 0, lastBlockedAt: null, lastReason: null };

function reportViolation(stage, reason, detail) {
  readOnlyGuardStats.blocked++;
  readOnlyGuardStats.lastBlockedAt = new Date().toISOString();
  readOnlyGuardStats.lastReason = reason;
  console.error(`[vTiger] [READ-ONLY-VIOLATION] Etapa ${stage}: ${reason}`);
  recordAuditEvent({
    type: 'VTIGER_READ_ONLY_VIOLATION',
    severity: 'critical',
    stage,
    reason,
    detail: detail ? String(detail).slice(0, 200) : null,
    message: 'Intento de escritura/modificación sobre vTiger BLOQUEADO. LOA Engine es solo lectura.'
  });
}

/**
 * CAPA 1: valida el método HTTP. Sólo GET, o POST exclusivamente para login.
 */
export function assertReadOnlyHttpMethod(method = 'GET', { isLogin = false } = {}) {
  const m = String(method).toUpperCase();
  if (m === 'GET') return true;
  if (m === 'POST' && isLogin) return true;

  reportViolation('HTTP_METHOD', `Método HTTP '${m}' no permitido sobre vTiger (solo lectura).`, isLogin ? 'POST solo para login' : null);
  throw new VtigerReadOnlyViolation(`vTiger es solo lectura: método '${m}' prohibido.`, { stage: 'HTTP_METHOD', detail: m });
}

/**
 * CAPA 2: valida la operación solicitada a la Webservice API.
 */
export function assertAllowedOperation(operation = '') {
  const op = String(operation).toLowerCase().trim();
  if (VTIGER_ALLOWED_OPERATIONS.includes(op)) return true;

  reportViolation('OPERATION', `Operación '${op}' no permitida sobre vTiger (allow-list: ${VTIGER_ALLOWED_OPERATIONS.join(', ')}).`, op);
  throw new VtigerReadOnlyViolation(`Operación vTiger '${op}' prohibida: el motor no escribe en el CRM.`, { stage: 'OPERATION', detail: op });
}

/**
 * CAPA 3: valida que la sentencia sea de LECTURA.
 * Se aplica a toda consulta antes de salir a la red.
 */
export function assertReadOnlyStatement(sql = '') {
  const statement = String(sql).trim();

  if (!/^\s*SELECT\b/i.test(statement)) {
    reportViolation('STATEMENT', 'La sentencia no comienza con SELECT.', statement);
    throw new VtigerReadOnlyViolation('Solo se permiten sentencias SELECT sobre vTiger.', { stage: 'STATEMENT', detail: redactQuery(statement) });
  }

  const writeMatch = SQL_WRITE_VERBS.exec(statement);
  if (writeMatch) {
    reportViolation('STATEMENT', `Verbo SQL de escritura detectado: ${writeMatch[1].toUpperCase()}.`, statement);
    throw new VtigerReadOnlyViolation(`Sentencia con verbo de escritura '${writeMatch[1].toUpperCase()}' bloqueada: vTiger es solo lectura.`, { stage: 'STATEMENT', detail: redactQuery(statement) });
  }

  // `SELECT ... INTO` crea tablas: también es escritura.
  if (/\bINTO\b/i.test(statement)) {
    reportViolation('STATEMENT', 'Sentencia SELECT ... INTO detectada (crea objetos).', statement);
    throw new VtigerReadOnlyViolation('SELECT ... INTO está prohibido: crea objetos en el CRM.', { stage: 'STATEMENT', detail: redactQuery(statement) });
  }

  return true;
}

/**
 * Envoltorio único de TODAS las llamadas HTTP a vTiger.
 * Ninguna otra parte del código debe llamar a `fetch()` contra el CRM.
 */
async function vtigerFetch(url, options = {}, meta = {}) {
  assertReadOnlyHttpMethod(options.method || 'GET', { isLogin: Boolean(meta.isLogin) });

  if (meta.operation) assertAllowedOperation(meta.operation);

  return fetchWithTimeout(url, options);
}

/**
 * LÍMITES DEL PARSER DE LA WEBSERVICE API DE VTIGER (verificados en vivo)
 * ==============================================================================
 * Estos comportamientos NO son documentados por vTiger y cada uno provocó un bug
 * real de sincronización silenciosa. Respetarlos es obligatorio:
 *
 * 1. SIN PARÉNTESIS en el WHERE:
 *    `WHERE (a = '1' OR b = '1')` -> "Syntax Error: token '(' Unexpected PARENOPEN"
 *    Las condiciones compuestas deben ser PLANAS: `WHERE a = '1' OR b = '1' AND c = 'x'`.
 *
 * 2. SIN `WHERE 1=1`:
 *    -> "Permission to access 1 attribute denied" (lo interpreta como un atributo).
 *    El WHERE debe empezar siempre por una condición real.
 *
 * 3. `cf_3451` (Sede) NO EXISTE en todos los módulos:
 *    En `SalesOrder` / `Invoice` da "Permission to access cf_3451 attribute denied".
 *    El aislamiento de esos módulos se hereda del contacto (`contact_id`), que sí
 *    fue seleccionado bajo Sede-Lock. Ver `TENANT_ISOLATION_STRATEGY`.
 *
 * 4. Campos con permiso denegado para el rol de API:
 *    `cf_noticias` -> "Permission to access '.cf_noticias.' attribute denied".
 *    No incluirlo en ningún SELECT.
 *
 * 5. `contactid` NO es el nombre del vínculo: el correcto es `contact_id`.
 *
 * MORALEJA: un `catch` que devuelve `[]` convierte cualquier error de la API en
 * "no hay datos" y el motor deja de aprender/comercializar EN SILENCIO. Por eso
 * `query()` audita todo fallo en el log estructurado antes de propagarlo.
 */
/**
 * Módulos nativos de vTiger que el motor consulta o escribe.
 * NUNCA inventar nombres: la API REST responde "module does not exist" y el dato
 * se pierde silenciosamente.
 */
export const VTIGER_MODULES = {
  CONTACTS: 'Contacts',
  LEADS: 'Leads',
  POTENTIALS: 'Potentials',
  SALES_ORDER: 'SalesOrder',
  INVOICE: 'Invoice',
  ACCOUNTS: 'Accounts',
  USERS: 'Users'
};

/**
 * Campos nativos y personalizados (`cf_`) en uso. Fuente única de verdad para
 * evitar strings mágicos dispersos. `cf_` = custom field del diccionario vTiger.
 */
export const VTIGER_FIELDS = {
  // Nativos
  ID: 'id',
  FIRST_NAME: 'firstname',
  LAST_NAME: 'lastname',
  EMAIL: 'email',
  PHONE: 'phone',
  MOBILE: 'mobile',
  HOME_PHONE: 'homephone',
  OTHER_PHONE: 'otherphone',
  MAILING_CITY: 'mailingcity',
  CREATED_TIME: 'createdtime',
  MODIFIED_TIME: 'modifiedtime',
  CONTACT_ID: 'contact_id',
  // Personalizados operativos
  SEDE: 'cf_3451',              // Sede del contacto (eje del aislamiento multi-tenant)
  TRATAMIENTO: 'cf_2610',       // Padecimiento / producto
  CIUDAD: 'cf_1157',            // Ciudad operativa real de la empresa
  PROVEEDOR: 'cf_2572',         // Proveedor de pauta declarado
  CANAL: 'cf_3507',             // Canal de captación (FB-MSGR, FORM, ...)
  CAMPANA: 'cf_3472',           // Campaña / origen estructurado
  NUM_COMPRAS: 'spl_num_compras',
  // MONTO_INVERTIDO: VERIFICADO EN VIVO como GASTO TOTAL ACUMULADO, no la última
  // compra. La suma de todas las órdenes del contacto coincide exactamente
  // (MIGUEL REVILLA: órdenes [160,100] = 260 = cf_3392; OLGA CANAS: 5 órdenes
  // [190,110,100,20,170] = 590 = cf_3392). Se publica como gasto histórico.
  MONTO_INVERTIDO: 'cf_3392',
  ESTADO_VENTA: 'cf_994',
  AD_ID_REAL: 'cf_2850'
  // NOTA: `cf_noticias` (historial clínico) fue ELIMINADO de este diccionario.
  //   1. Su uso previsto era ESCRIBIR la nota de mudanza en vTiger: PROHIBIDO.
  //      LOA Engine es un sensor de SOLO LECTURA y no altera el CRM.
  //   2. Además está denegado para el rol de API ("Permission to access
  //      '.cf_noticias.' attribute denied"), por lo que ni siquiera es legible.
  //   3. El caso de negocio está cubierto por el custom field **de GHL**
  //      `contact.vtiger_historial_completo` (ver routing_tables.js), que es el
  //      lugar correcto porque GHL es la trinchera de atención.
};

/** Sedes válidas para el aislamiento multi-tenant (allow-list dura). */
export const VTIGER_SEDES_VALIDAS = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];

/** Campos que se solicitan siempre en una lectura de contacto. */
export const VTIGER_CONTACT_SELECT = [
  VTIGER_FIELDS.ID,
  VTIGER_FIELDS.FIRST_NAME,
  VTIGER_FIELDS.LAST_NAME,
  VTIGER_FIELDS.EMAIL,
  VTIGER_FIELDS.PHONE,
  VTIGER_FIELDS.MOBILE,
  VTIGER_FIELDS.HOME_PHONE,
  VTIGER_FIELDS.OTHER_PHONE,
  VTIGER_FIELDS.SEDE,
  VTIGER_FIELDS.TRATAMIENTO,
  VTIGER_FIELDS.PROVEEDOR
].join(', ');

/** Módulos sobre los que el motor tiene PROHIBIDO escribir (solo lectura estricta). */
export const VTIGER_READ_ONLY_MODULES = [
  VTIGER_MODULES.CONTACTS,
  VTIGER_MODULES.LEADS,
  VTIGER_MODULES.POTENTIALS,
  VTIGER_MODULES.SALES_ORDER,
  VTIGER_MODULES.INVOICE,
  VTIGER_MODULES.ACCOUNTS
];

/**
 * Módulos con datos de cliente sujetos al Sede-Lock, con su ESTRATEGIA de
 * aislamiento REAL (verificada contra la API de vTiger):
 *
 *  - `direct`      : el módulo tiene el campo `cf_3451`. La consulta DEBE filtrarlo.
 *  - `contactLink` : el módulo NO tiene sede propia (verificado: `SalesOrder` no
 *                    posee `cf_3451`). Su aislamiento se hereda del contacto, que
 *                    ya fue seleccionado bajo Sede-Lock. La consulta DEBE estar
 *                    acotada por el vínculo `contact_id`, y debe declararse
 *                    explícitamente con `inheritedSede` al invocar `query()`.
 *
 * Inventar un filtro inexistente rompía la consulta con "Permission to access
 * cf_3451 attribute denied": el aislamiento correcto en estos módulos es el
 * vínculo al contacto, no un campo que el módulo no tiene.
 */
export const TENANT_ISOLATION_STRATEGY = {
  [VTIGER_MODULES.CONTACTS]: { mode: 'direct', field: VTIGER_FIELDS.SEDE },
  [VTIGER_MODULES.LEADS]: { mode: 'direct', field: VTIGER_FIELDS.SEDE },
  [VTIGER_MODULES.POTENTIALS]: { mode: 'direct', field: VTIGER_FIELDS.SEDE },
  [VTIGER_MODULES.SALES_ORDER]: { mode: 'contactLink', linkField: 'contact_id' },
  [VTIGER_MODULES.INVOICE]: { mode: 'contactLink', linkField: 'contact_id' }
};

/** Módulos que requieren aislamiento (derivados de la estrategia). */
export const TENANT_SCOPED_MODULES = Object.keys(TENANT_ISOLATION_STRATEGY);

// ------------------------------------------------------------------------------
// 2. GATE DE AISLAMIENTO (SEDE-LOCK) A NIVEL DE API — INVARIANTE DE SISTEMA
// ------------------------------------------------------------------------------
/**
 * Verifica que una consulta saliente respete el Sede-Lock.
 *
 * REGLA: si la consulta toca un módulo con datos de cliente, DEBE contener el
 * filtro `cf_3451 = '<SEDE>'`. De lo contrario leería las 2 sedes mezcladas.
 *
 * Esta guarda existe porque el bug de fuga se repitió 3 veces por el mismo
 * patrón: construir la consulta a mano en `vtiger_api_service.js` y olvidar la
 * cláusula. Centralizarla en el borde de la API cierra la CLASE de bug, no el caso.
 *
 * @returns {{ safe: boolean, module: string|null, reason: string|null }}
 */
export function assertTenantIsolation(sql = '', { inheritedSede = null } = {}) {
  const statement = String(sql);
  const match = /FROM\s+([A-Za-z_]+)/i.exec(statement);
  const module = match ? match[1] : null;

  if (!module || !TENANT_SCOPED_MODULES.includes(module)) {
    return { safe: true, module, reason: null }; // módulos globales (ej. Users): sin sede
  }

  const strategy = TENANT_ISOLATION_STRATEGY[module];

  // --- Estrategia 1: el módulo tiene el campo de sede ---
  if (strategy.mode === 'direct') {
    const hasSedeFilter = new RegExp(`${strategy.field}\\s*=`, 'i').test(statement);
    if (!hasSedeFilter) {
      return {
        safe: false,
        module,
        reason: `Consulta a ${module} sin cláusula de aislamiento ${strategy.field}: se leerían datos de todas las sedes (violación del Sede-Lock).`
      };
    }
    return { safe: true, module, reason: null };
  }

  // --- Estrategia 2: módulo sin campo de sede; aislamiento por vínculo al contacto ---
  // Se exige (a) que la consulta esté acotada por el vínculo y (b) que la sede se
  // herede EXPLÍCITAMENTE del contacto seleccionado bajo Sede-Lock.
  // El vínculo se acepta con '=', 'IN' u operadores de comparación: el gate debe
  // reconocer las formas válidas de acotar, no sólo la igualdad.
  const linkPattern = new RegExp(`${strategy.linkField}\\s*(=|IN\\s*\\(|LIKE|!=|<>|>=|<=|>|<)`, 'i');
  if (!linkPattern.test(statement)) {
    return {
      safe: false,
      module,
      reason: `Consulta a ${module} sin acotar por ${strategy.linkField}: no hay forma de garantizar el aislamiento de sede (${module} no posee ${VTIGER_FIELDS.SEDE}).`
    };
  }
  if (!inheritedSede) {
    return {
      safe: false,
      module,
      reason: `Consulta a ${module} acotada por ${strategy.linkField} pero sin sede heredada declarada: el aislamiento no puede verificarse (pase inheritedSede).`
    };
  }
  if (!VTIGER_SEDES_VALIDAS.includes(String(inheritedSede).toUpperCase())) {
    return {
      safe: false,
      module,
      reason: `Sede heredada inválida ("${String(inheritedSede).slice(0, 24)}") para ${module}: no pertenece a la allow-list.`
    };
  }

  return { safe: true, module, reason: null, inheritedFrom: inheritedSede };
}

/** Excepción específica del Sede-Lock (permite manejarla de forma diferenciada). */
export class SedeLockViolation extends Error {
  constructor(message, { module = null, sql = '' } = {}) {
    super(message);
    this.name = 'SedeLockViolation';
    this.code = 'SEDE_LOCK_VIOLATION';
    this.module = module;
    this.query = redactQuery(sql);
  }
}

function redactQuery(q) {
  return String(q).replace(/'[^']*'/g, "'***'").slice(0, 200);
}

// ------------------------------------------------------------------------------
// 3. VALIDACIÓN DE ENTORNO (SANITY CHECK SIN MATAR EL PROCESO)
// ------------------------------------------------------------------------------
/**
 * Estado de configuración de vTiger. Se evalúa en el arranque y se expone en
 * `/api/health`. NUNCA lanza: el motor debe seguir vivo aunque vTiger falte.
 */
export function getVtigerConfigStatus() {
  const url = readSecret('VTIGER_URL');
  const username = readSecret('VTIGER_USERNAME');
  const accessKey = readSecret('VTIGER_ACCESS_KEY');

  const missing = [];
  if (!url) missing.push('VTIGER_URL');
  if (!username) missing.push('VTIGER_USERNAME');
  if (!accessKey) missing.push('VTIGER_ACCESS_KEY');

  return {
    configured: missing.length === 0,
    missing,
    mode: 'GLOBAL_ADMIN',
    urlHost: url ? safeHost(url) : null,
    usernameHint: username ? `${username.slice(0, 2)}****` : null,
    accessKey: accessKey ? `****(${accessKey.length})` : '(vacío)'
  };
}

function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '(URL inválida)';
  }
}

/** Lanza un error explícito sólo cuando se INTENTA usar vTiger sin configurar. */
function assertConfigured() {
  const status = getVtigerConfigStatus();
  if (!status.configured) {
    throw new Error(`vTiger no configurado. Faltan variables de entorno: ${status.missing.join(', ')}`);
  }
  return status;
}

/**
 * Credenciales listas para usar (url/username/accessKey).
 * ERROR HISTÓRICO: `query()` desestructuraba `url` de `assertConfigured()`, que
 * devuelve el ESTADO (no las credenciales). Eso dejaba `url === undefined` y hacía
 * fallar TODAS las consultas a vTiger con un TypeError que quedaba enmascarado
 * por el `catch` del llamante (parecía "no hay datos"). Se separa explícitamente
 * el chequeo de configuración del acceso a las credenciales.
 */
function assertCredentials() {
  assertConfigured();
  return {
    url: readSecret('VTIGER_URL'),
    username: readSecret('VTIGER_USERNAME'),
    accessKey: readSecret('VTIGER_ACCESS_KEY')
  };
}

// ------------------------------------------------------------------------------
// 4. REINTENTOS CON BACKOFF EXPONENCIAL
// ------------------------------------------------------------------------------
const MAX_ATTEMPTS = envInt('VTIGER_MAX_ATTEMPTS', 3);
const BASE_DELAY_MS = envInt('VTIGER_RETRY_BASE_MS', 500);
const MAX_DELAY_MS = envInt('VTIGER_RETRY_MAX_MS', 8000);
const REQUEST_TIMEOUT_MS = envInt('VTIGER_TIMEOUT_MS', 12000);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Backoff exponencial con JITTER completo.
 * El jitter evita que las 2 sedes reintenten sincronizadas y vuelvan a saturar
 * la misma instancia de vTiger (efecto "thundering herd").
 * El resultado SIEMPRE queda acotado por `max`.
 */
export function computeBackoffDelay(attempt, base = BASE_DELAY_MS, max = MAX_DELAY_MS) {
  const exponential = Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), max);
  const jitter = Math.random() * exponential * 0.3; // hasta +30%
  return Math.min(Math.round(exponential + jitter), max);
}

/** ¿El error merece reintento? Un dato inválido NO se reintenta (falla rápido). */
export function isRetryableError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  // 4xx de negocio: el payload o el dato está mal, reintentar no ayuda.
  if (/invalid|does not exist|permission|denied|no access|not found|mandatory|missing/i.test(msg)) return false;
  if (/\b401\b|\b403\b|\b404\b|\b422\b/.test(msg)) return false;
  // Red, timeout, 429 y 5xx: reintentables.
  return true;
}

// ------------------------------------------------------------------------------
// 5. SESIÓN GLOBAL ÚNICA (ADMIN API KEY)
// ------------------------------------------------------------------------------
let globalSession = null;
let sessionIssuedAt = 0;

/**
 * Inicia sesión con la cuenta de Administrador global.
 * `operation=getchallenge` + MD5(token + accessKey) es el flujo nativo de vTiger.
 */
export async function login() {
  const { url, username, accessKey } = assertCredentials();
  const endpoint = `${url.replace(/\/$/, '')}/webservice.php`;

  const challengeRes = await vtigerFetch(
    `${endpoint}?operation=getchallenge&username=${encodeURIComponent(username)}`,
    { method: 'GET' },
    { operation: 'getchallenge' }
  );
  const challengeData = await challengeRes.json();
  if (!challengeData.success) {
    throw new Error(`getchallenge falló: ${challengeData.error?.message || 'respuesta inválida'}`);
  }

  const generatedKey = crypto
    .createHash('md5')
    .update(challengeData.result.token + accessKey)
    .digest('hex');

  const loginRes = await vtigerFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ operation: 'login', username, accessKey: generatedKey })
  }, { isLogin: true, operation: 'login' });

  const loginData = await loginRes.json();
  if (!loginData.success) {
    throw new Error(`login falló: ${loginData.error?.message || 'respuesta inválida'}`);
  }

  globalSession = loginData.result.sessionName;
  sessionIssuedAt = Date.now();
  // Se registra SÓLO el prefijo de sesión, nunca la credencial.
  console.log(`[vTiger] [AUTH] Sesión global de Administrador iniciada. session=${globalSession.substring(0, 6)}...`);
  return globalSession;
}

/** Indica si hay sesión vigente (se renueva cada 12 h por precaución). */
export function hasSession() {
  return Boolean(globalSession) && (Date.now() - sessionIssuedAt) < 12 * 60 * 60 * 1000;
}

export function clearSession() {
  globalSession = null;
  sessionIssuedAt = 0;
}

async function ensureSession(force = false) {
  if (force || !hasSession()) await login();
  return globalSession;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------------------
// 6. CONSULTA CON REINTENTOS (NUNCA PIERDE EL DATO EN TRÁNSITO)
// ------------------------------------------------------------------------------
/**
 * Ejecuta `operation=query` contra vTiger con reintentos seguros.
 *
 * @param {string} queryStr Consulta SELECT. Los valores interpolados DEBEN venir
 *                          de `sanitizeForVtigerQuery()` o `digitsOnly()`.
 * @param {object} [options]
 * @param {string} [options.context] etiqueta para el log de auditoría
 * @param {number} [options.maxAttempts]
 * @returns {Promise<Array>} filas devueltas por vTiger
 */
export async function query(queryStr, { context = 'query', maxAttempts = MAX_ATTEMPTS, allowAggregate = false, inheritedSede = null } = {}) {
  const { url } = assertCredentials();
  const endpoint = `${url.replace(/\/$/, '')}/webservice.php`;
  let cleanQuery = String(queryStr || '').trim();
  if (!cleanQuery) throw new Error('Consulta vTiger vacía');
  if (!cleanQuery.endsWith(';')) cleanQuery += ';';

  // ==========================================================================
  // [SOLO LECTURA] CAPA 3: la sentencia debe ser un SELECT.
  // ==========================================================================
  // Bloquea UPDATE / DELETE / INSERT / DROP / ALTER / TRUNCATE / SELECT ... INTO
  // ANTES de cualquier intento de red. LOA Engine NO escribe en el CRM.
  assertReadOnlyStatement(cleanQuery);

  // ==========================================================================
  // [SEDE-LOCK] GATE OBLIGATORIO: ninguna consulta sale sin aislamiento de sede.
  // ==========================================================================
  // `allowAggregate` sólo se usa para aprendizaje agregado (patrones de
  // tratamiento/campaña), siempre etiquetando el origen por sede y NUNCA para
  // datos que se propaguen a un GHL.
  if (!allowAggregate) {
    const isolation = assertTenantIsolation(cleanQuery, { inheritedSede });
    if (!isolation.safe) {
      recordAuditEvent({
        type: 'SEDE_LOCK_VIOLATION',
        severity: 'critical',
        context,
        module: isolation.module,
        reason: isolation.reason,
        query: redactQuery(cleanQuery)
      });
      throw new SedeLockViolation(isolation.reason, { module: isolation.module, sql: cleanQuery });
    }
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const session = await ensureSession(attempt > 1 && !hasSession());
      const res = await vtigerFetch(
        `${endpoint}?operation=query&sessionName=${encodeURIComponent(session)}&query=${encodeURIComponent(cleanQuery)}`,
        { method: 'GET' },
        { operation: 'query' }
      );
      const data = await res.json();

      if (data.success) {
        if (attempt > 1) {
          console.log(`[vTiger] [RETRY-OK] '${context}' recuperado en el intento ${attempt}/${maxAttempts}.`);
        }
        return data.result || [];
      }

      const errMsg = data.error?.message || 'error desconocido de vTiger';

      // Sesión expirada: se renueva y se reintenta de inmediato.
      if (/session|auth/i.test(errMsg) && attempt < maxAttempts) {
        console.warn(`[vTiger] [REAUTH] Sesión rechazada en '${context}'. Renovando...`);
        clearSession();
        continue;
      }

      const error = new Error(errMsg);
      if (!isRetryableError(error) || attempt === maxAttempts) {
        recordAuditEvent({
          type: 'VTIGER_QUERY_FAILED',
          severity: 'error',
          context,
          attempt,
          maxAttempts,
          message: errMsg,
          query: redactQuery(cleanQuery)
        });
        throw error;
      }
      lastError = error;
    } catch (err) {
      lastError = err;
      const retryable = isRetryableError(err);
      if (!retryable || attempt === maxAttempts) {
        recordAuditEvent({
          type: 'VTIGER_QUERY_FAILED',
          severity: retryable ? 'critical' : 'error',
          context,
          attempt,
          maxAttempts,
          message: err.message,
          query: redactQuery(cleanQuery)
        });
        throw err;
      }
    }

    const delay = computeBackoffDelay(attempt);
    console.warn(`[vTiger] [RETRY ${attempt}/${maxAttempts}] '${context}' falló (${lastError?.message}). Reintento en ${delay}ms.`);
    recordAuditEvent({
      type: 'VTIGER_QUERY_RETRY',
      severity: 'warn',
      context,
      attempt,
      maxAttempts,
      delayMs: delay,
      message: lastError?.message
    });
    await sleep(delay);
  }

  throw lastError || new Error(`Consulta vTiger '${context}' agotó los reintentos.`);
}

// ------------------------------------------------------------------------------
// 7. HELPERS NATIVOS DE CONSTRUCCIÓN DE CONSULTAS
// ------------------------------------------------------------------------------
/**
 * Construye un SELECT seguro sobre un módulo nativo.
 * Escapa el módulo con allow-list para impedir que un nombre arbitrario se cuele
 * en la sentencia (aunque los módulos se declaren en código, no en runtime).
 */
export function buildSelect({ module, fields = '*', where = '', limit = null }) {
  const safeModule = Object.values(VTIGER_MODULES).includes(module) ? module : null;
  if (!safeModule) throw new Error(`Módulo vTiger no reconocido: ${module}`);

  const safeFields = fields === '*'
    ? '*'
    : String(fields).split(',').map(f => f.trim()).filter(f => /^[A-Za-z0-9_]+$/.test(f)).join(', ');

  let sql = `SELECT ${safeFields || '*'} FROM ${safeModule}`;
  if (where) sql += ` WHERE ${where}`;
  if (limit) sql += ` LIMIT ${parseInt(limit, 10) || 1}`;
  return sql;
}

/**
 * Cláusula de aislamiento multi-tenant por el campo nativo de sede.
 * Con UNA cuenta global, ESTE es el único mecanismo que impide el cruce de datos.
 *
 * SEGURIDAD: la sede se valida contra una ALLOW-LIST de sedes reales, no sólo se
 * "limpia". Un valor manipulado que conserve letras (ej. `PALACIOS' OR '1'='1`)
 * produciría `PALACIOSOR` tras el saneado: un nombre plausible pero inválido que
 * consultaría una sede inexistente. La allow-list corta el problema de raíz.
 *
 * @param {string} sede 'PALACIOS' | 'BENAVIDES' | ...
 */
export function sedeClause(sede) {
  const clean = sanitizeForVtigerQuery(sede).toUpperCase().replace(/[^A-Z]/g, '');

  if (!clean || !VTIGER_SEDES_VALIDAS.includes(clean)) {
    console.error(`[vTiger] [TENANT-ISOLATION] Sede inválida o ausente ("${String(sede).slice(0, 24)}"). Consulta bloqueada para evitar fuga entre sedes.`);
    recordAuditEvent({
      type: 'VTIGER_SEDE_INVALID',
      severity: 'warn',
      received: String(sede || '').slice(0, 40),
      normalizado: clean || '(vacío)'
    });
    // Sin sede válida NO se devuelve cláusula vacía: eso consultaría toda la base
    // y filtraría datos entre sedes. Se fuerza un filtro imposible.
    return ` AND ${VTIGER_FIELDS.SEDE} = '__SIN_SEDE__'`;
  }

  return ` AND ${VTIGER_FIELDS.SEDE} = '${clean}'`;
}

/** Cláusula por teléfono normalizado a dígitos (NANP 10 dígitos). */
export function phoneClause(rawPhone) {
  const digits = digitsOnly(rawPhone, 15);
  if (digits.length < 7) return '';
  const last10 = digits.slice(-10);
  return ` AND (${VTIGER_FIELDS.HOME_PHONE} = '${last10}'`
    + ` OR ${VTIGER_FIELDS.MOBILE} = '${last10}'`
    + ` OR ${VTIGER_FIELDS.PHONE} = '${last10}')`;
}

export { sanitizeForVtigerQuery, digitsOnly };
