/**
 * ==============================================================================
 * LOA ENGINE - FAIL-SAFE SECRET LOADER (ZERO HARDCODING)
 * ==============================================================================
 * Única puerta de entrada para credenciales y variables de entorno del motor.
 *
 * PRINCIPIOS:
 * 1. Cero hardcoding: ningún token, locationId ni clave tiene valor por defecto
 *    en el código fuente. Si falta, el valor es `''` (cadena vacía) y se reporta.
 * 2. Fail-Safe en arranque (protección del entorno Render):
 *    - Sede NO operativa + secreto faltante  => WARN (el proceso continúa).
 *    - Sanity Check esencial fallido         => FATAL (exit 1 controlado).
 * 3. Redacción: `redact()` enmascara cualquier secreto antes de escribir en logs,
 *    telemetría o respuestas HTTP. Nunca se imprime el valor completo.
 * ==============================================================================
 */

import dotenv from 'dotenv';
dotenv.config();

// ------------------------------------------------------------------------------
// 0. MODO ESTRICTO (solo para CI / desarrollo local)
// ------------------------------------------------------------------------------
// En Render (NODE_ENV=production) el arranque JAMÁS se detiene por un secreto
// opcional. En local/CI se puede exigir el 100% con STRICT_CONFIG=true.
const RAW_NODE_ENV = String(process.env.NODE_ENV || 'development').toLowerCase();
export const IS_PRODUCTION = RAW_NODE_ENV === 'production';
export const STRICT_CONFIG = String(process.env.STRICT_CONFIG || 'false').toLowerCase() === 'true';

// ------------------------------------------------------------------------------
// 1. UTILIDADES DE LECTURA SEGURA
// ------------------------------------------------------------------------------
const PLACEHOLDER_PATTERNS = [
  /^x+$/i,
  /^your[_-]/i,
  /^changeme/i,
  /^placeholder/i,
  /^tu[_-]/i,
  /^<.*>$/,
  /^pit-x+/i,
  /^EAAx+/i
];

function isPlaceholder(value) {
  if (typeof value !== 'string') return false;
  return PLACEHOLDER_PATTERNS.some(rx => rx.test(value.trim()));
}

/**
 * Redacta un secreto para logs seguros: muestra prefijo y longitud, jamás el valor.
 * @example redact('pit-00000000-1111-2222-3333-444444444444') => 'pit-0000****(36)'
 */
export function redact(value) {
  if (!value) return '(vacío)';
  const str = String(value);
  if (str.length <= 8) return `****(${str.length})`;
  return `${str.slice(0, 8)}****(${str.length})`;
}

/**
 * Sanea cualquier objeto antes de loguearlo, enmascarando llaves sensibles.
 */
export function sanitizeForLog(obj, depth = 0) {
  if (depth > 4 || obj === null || typeof obj !== 'object') return obj;
  const SENSITIVE = /(key|token|secret|password|passwd|authorization|pit|access_key)/i;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.test(k) && typeof v === 'string') {
      out[k] = redact(v);
    } else if (v && typeof v === 'object') {
      out[k] = sanitizeForLog(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------
// 2. REGISTRO DE SECRETOS (INVENTARIO DECLARATIVO)
// ------------------------------------------------------------------------------
/**
 * @typedef {Object} SecretSpec
 * @property {string}  key         Nombre exacto de la variable en process.env
 * @property {boolean} required    true = esencial para el sanity check
 * @property {string}  fallback    Valor NO secreto permitido (URLs, nombres). Nunca tokens.
 * @property {string}  description Documentación operativa
 */

/** @type {SecretSpec[]} */
export const SECRET_SPECS = [
  // --- Núcleo ---
  { key: 'PORT', required: false, fallback: '3000', description: 'Puerto HTTP (Render lo inyecta)' },
  { key: 'LOA_LICENSE_KEY', required: false, fallback: '', description: 'Licencia del motor' },
  { key: 'NODE_ENV', required: false, fallback: 'development', description: 'Entorno de ejecución' },

  // --- GHL Subcuenta Palacios (sede principal operativa) ---
  { key: 'GHL_API_KEY_PALACIOS', required: true, fallback: '', description: 'PIT de la subcuenta Palacios' },
  { key: 'GHL_LOCATION_ID_PALACIOS', required: true, fallback: '', description: 'Location ID de Palacios' },

  // --- GHL Subcuenta Benavides ---
  { key: 'GHL_API_KEY_BENAVIDES', required: false, fallback: '', description: 'PIT de la subcuenta Benavides' },
  { key: 'GHL_LOCATION_ID_BENAVIDES', required: false, fallback: '', description: 'Location ID de Benavides' },

  // --- GHL Sedes en standby (Roosevelt / Piura) ---
  { key: 'GHL_API_KEY_ROOSEVELT', required: false, fallback: '', description: 'PIT Roosevelt (standby)' },
  { key: 'GHL_LOCATION_ID_ROOSEVELT', required: false, fallback: '', description: 'Location ID Roosevelt (standby)' },
  { key: 'GHL_API_KEY_PIURA', required: false, fallback: '', description: 'PIT Piura (standby)' },
  { key: 'GHL_LOCATION_ID_PIURA', required: false, fallback: '', description: 'Location ID Piura (standby)' },

  // --- vTiger CRM (Ground Truth de ventas, solo lectura) ---
  { key: 'VTIGER_URL', required: false, fallback: '', description: 'Endpoint vTiger' },
  { key: 'VTIGER_USERNAME', required: false, fallback: '', description: 'Usuario vTiger' },
  { key: 'VTIGER_ACCESS_KEY', required: true, fallback: '', description: 'Access key vTiger' },

  // --- Meta Graph API (por sede) ---
  { key: 'META_API_VERSION', required: false, fallback: 'v20.0', description: 'Versión Graph API' },
  { key: 'META_WEBHOOK_VERIFY_TOKEN', required: false, fallback: '', description: 'Token de verificación del webhook' },
  { key: 'META_APP_ID_PALACIOS', required: false, fallback: '', description: 'Meta App ID Palacios' },
  { key: 'META_APP_SECRET_PALACIOS', required: false, fallback: '', description: 'Meta App Secret Palacios' },
  { key: 'META_ACCESS_TOKEN_PALACIOS', required: false, fallback: '', description: 'System User Token Palacios (Business Manager, caducidad NUNCA)' },
  { key: 'META_AD_ACCOUNT_IDS_PALACIOS', required: false, fallback: '', description: 'Ad Account IDs Palacios (CSV)' },
  { key: 'META_APP_ID_BENAVIDES', required: false, fallback: '', description: 'Meta App ID Benavides' },
  { key: 'META_APP_SECRET_BENAVIDES', required: false, fallback: '', description: 'Meta App Secret Benavides' },
  { key: 'META_ACCESS_TOKEN_BENAVIDES', required: false, fallback: '', description: 'System User Token Benavides (Business Manager, caducidad NUNCA)' },
  { key: 'META_AD_ACCOUNT_IDS_BENAVIDES', required: false, fallback: '', description: 'Ad Account IDs Benavides (CSV)' },
  { key: 'META_APP_ID_ROOSEVELT', required: false, fallback: '', description: 'Meta App ID Roosevelt' },
  { key: 'META_APP_SECRET_ROOSEVELT', required: false, fallback: '', description: 'Meta App Secret Roosevelt' },
  { key: 'META_ACCESS_TOKEN_ROOSEVELT', required: false, fallback: '', description: 'Token Roosevelt' },
  { key: 'META_AD_ACCOUNT_IDS_ROOSEVELT', required: false, fallback: '', description: 'Ad Account IDs Roosevelt (CSV)' },
  { key: 'META_APP_ID_PIURA', required: false, fallback: '', description: 'Meta App ID Piura' },
  { key: 'META_APP_SECRET_PIURA', required: false, fallback: '', description: 'Meta App Secret Piura' },
  { key: 'META_ACCESS_TOKEN_PIURA', required: false, fallback: '', description: 'Token Piura' },
  { key: 'META_AD_ACCOUNT_IDS_PIURA', required: false, fallback: '', description: 'Ad Account IDs Piura (CSV)' },
  { key: 'META_BACKUP_TOKENS', required: false, fallback: '', description: 'Pool de tokens de contingencia (CSV)' },

  // --- Infraestructura de colas durables (opcional, tras feature flag) ---
  { key: 'QUEUE_DRIVER', required: false, fallback: 'memory', description: 'memory | bullmq' },
  { key: 'REDIS_URL', required: false, fallback: '', description: 'URL de Redis (Upstash/Render KV)' },
  { key: 'DATABASE_URL', required: false, fallback: '', description: 'PostgreSQL persistente (estado/cursores)' },
  { key: 'PERSISTENCE_DRIVER', required: false, fallback: 'file', description: 'file | postgres' }
];

const SPEC_BY_KEY = new Map(SECRET_SPECS.map(s => [s.key, s]));

// ------------------------------------------------------------------------------
// 3. ALMACÉN DE ESTADO (TRAZABILIDAD SIN FILTRAR VALORES)
// ------------------------------------------------------------------------------
/** @type {Map<string, {key:string, present:boolean, placeholder:boolean, required:boolean}>} */
const secretState = new Map();

/**
 * Lee una variable de entorno de forma segura, registrando su estado.
 * Nunca lanza excepción: si falta, devuelve el fallback NO SECRETO o ''.
 */
export function readSecret(key, explicitFallback = undefined) {
  const spec = SPEC_BY_KEY.get(key);
  const fallback = explicitFallback !== undefined
    ? explicitFallback
    : (spec?.fallback ?? '');

  const raw = process.env[key];
  const present = typeof raw === 'string' && raw.trim().length > 0;
  const placeholder = present && isPlaceholder(raw);

  secretState.set(key, {
    key,
    present,
    placeholder,
    required: Boolean(spec?.required)
  });

  if (!present) return fallback;
  if (placeholder) {
    // Placeholder = tratado como ausente, pero se conserva el texto para diagnóstico
    return fallback;
  }
  return raw.trim();
}

/**
 * Indica si un secreto está realmente disponible (presente, no placeholder).
 */
export function hasSecret(key) {
  const raw = process.env[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) return false;
  return !isPlaceholder(raw);
}

// ------------------------------------------------------------------------------
// 4. TIPADO PERMISIVO (PARSEO SIN EXCEPCIONES)
// ------------------------------------------------------------------------------
export function envInt(key, fallback = 0) {
  const value = parseInt(readSecret(key, ''), 10);
  return Number.isFinite(value) ? value : fallback;
}

export function envBool(key, fallback = false) {
  const raw = String(readSecret(key, '')).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

export function envList(key, separator = ',') {
  return String(readSecret(key, ''))
    .split(separator)
    .map(s => s.trim())
    .filter(Boolean);
}

// ------------------------------------------------------------------------------
// 5. AUDITORÍA PRE-FLIGHT (SIN RED, SIN BLOQUEOS, < 50 ms)
// ------------------------------------------------------------------------------
/**
 * Ejecuta la auditoría de secretos y devuelve un reporte estructurado.
 * NO realiza llamadas de red: es seguro invocarlo en el arranque de Render.
 *
 * @param {Object} opts
 * @param {string[]} opts.operationalSedes Sedes encendidas cuyos secretos SON esenciales
 * @returns {{ healthy: boolean, fatal: string[], warnings: string[], summary: Object }}
 */
export function auditSecrets({ operationalSedes = ['PALACIOS', 'BENAVIDES'] } = {}) {
  const fatal = [];
  const warnings = [];
  const operational = new Set(operationalSedes.map(s => s.toUpperCase()));

  for (const spec of SECRET_SPECS) {
    const state = secretState.get(spec.key) || {
      key: spec.key,
      present: hasSecret(spec.key),
      placeholder: false,
      required: spec.required
    };
    const isOperationalSecret = operational.size > 0 && [...operational].some(sede =>
      spec.key.endsWith(`_${sede}`) || (sede === 'PALACIOS' && spec.key === 'GHL_API_KEY_PALACIOS')
    );

    if (!state.present || state.placeholder) {
      const label = state.placeholder ? 'PLACEHOLDER' : 'AUSENTE';
      const message = `[SECRETS] ${spec.key} ${label} — ${spec.description}`;

      if (spec.required || isOperationalSecret) {
        // Un secreto esencial faltante se reporta como WARN en producción para no
        // provocar crash-loop de Render; el sanity check decide si es FATAL.
        if (spec.required && !IS_PRODUCTION) {
          fatal.push(message);
        } else if (spec.required) {
          warnings.push(`${message} (sede operativa degradada: el motor arranca en modo seguro)`);
        } else {
          warnings.push(message);
        }
      } else {
        warnings.push(message);
      }
    }
  }

  // Un secreto REQUERIDO ausente en local/CI detiene el arranque (protección del dev).
  // En Render NUNCA detiene: se degrada la sede y se sigue operando el resto.
  const healthy = fatal.length === 0;
  return {
    healthy,
    fatal,
    warnings,
    summary: {
      total: SECRET_SPECS.length,
      loaded: [...secretState.values()].filter(s => s.present && !s.placeholder).length,
      missing: [...secretState.values()].filter(s => !s.present || s.placeholder).length,
      strict: STRICT_CONFIG,
      environment: RAW_NODE_ENV
    }
  };
}

/**
 * Imprime la auditoría en el arranque. Nunca lanza excepción.
 */
export function reportSecrets({ operationalSedes } = {}) {
  const report = auditSecrets({ operationalSedes });
  for (const w of report.warnings) console.warn(`[WARN] ${w}`);
  for (const f of report.fatal) console.error(`[FATAL-CONFIG] ${f}`);
  console.log(`[SECRETS] Cargados: ${report.summary.loaded}/${report.summary.total} | Ausentes: ${report.summary.missing} | Entorno: ${report.summary.environment}`);
  return report;
}
