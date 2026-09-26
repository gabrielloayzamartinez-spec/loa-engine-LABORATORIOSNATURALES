/**
 * ==============================================================================
 * LOA ENGINE - CAPA DE SANITIZACIÓN ESTRICTA (ENTRADA Y SALIDA)
 * ==============================================================================
 * Superficie de ataque real del motor: los webhooks son endpoints PÚBLICOS que
 * reciben JSON de terceros (GHL, vTiger, Meta, Pipedream) y ese contenido acaba
 * escrito en la base de datos del CRM.
 *
 * DEFENSAS IMPLEMENTADAS:
 * 1. Anti prototype-pollution: se descartan `__proto__`, `constructor`, `prototype`.
 * 2. Allow-list de campos: lo que no está declarado NO llega al CRM.
 * 3. Saneado por tipo: cada campo tiene formato, longitud y alfabeto permitido.
 * 4. Salida: `escapeHtml()` para cualquier texto que se renderice en un note/UI
 *    (bloquea XSS almacenado).
 * 5. Consultas vTiger: `sanitizeForVtigerQuery()` neutraliza comillas, barras
 *    invertidas y controles (defensa en profundidad contra inyección).
 * ==============================================================================
 */

// Límites duros por tipo de campo (evita payloads de agotamiento de memoria)
export const LIMITS = {
  NAME: 80,
  EMAIL: 160,
  PHONE: 25,
  CITY: 80,
  STATE: 40,
  SOURCE: 120,
  TAG: 60,
  MAX_TAGS: 25,
  MAX_CUSTOM_FIELDS: 60,
  ID: 64,
  GENERIC: 300
};

/** Claves peligrosas que jamás deben atravesar el motor (prototype pollution). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Sanea un texto de una sola línea: sin controles, sin ángulos y con longitud máxima.
 * @param {*} value
 * @param {number} maxLength
 * @returns {string}
 */
export function sanitizeString(value, maxLength = LIMITS.GENERIC) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return '';

  return value
    .normalize('NFC')
    // Se eliminan TODOS los caracteres de control (incluye \n, \r, \t y \0):
    // evita inyección de cabeceras, saltos en notas y payloads multilínea.
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    // Los ángulos permiten XSS almacenado cuando GHL/UI renderiza el valor.
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Sanea un identificador (IDs de GHL, Ad IDs, locationId).
 * Allow-list estricta: sólo alfanuméricos, guion y guion bajo.
 */
export function sanitizeId(value, maxLength = LIMITS.ID) {
  const clean = sanitizeString(value, maxLength);
  return clean.replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * Sanea un teléfono conservando únicamente dígitos y un '+' inicial.
 * Formato de operación: NANP de 10 dígitos (Estados Unidos).
 */
export function sanitizePhone(value, maxLength = LIMITS.PHONE) {
  const clean = sanitizeString(value, maxLength);
  const plus = clean.startsWith('+') ? '+' : '';
  return plus + clean.replace(/\D/g, '').slice(0, 15);
}

/**
 * Valida y normaliza un email. Devuelve '' si no es válido.
 */
export function sanitizeEmail(value, maxLength = LIMITS.EMAIL) {
  const clean = sanitizeString(value, maxLength).toLowerCase().replace(/\s/g, '');
  // Allow-list conservadora: evita direcciones con caracteres que rompen queries o HTML.
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) return '';
  return clean;
}

/**
 * Sanea una URL: sólo http/https. Bloquea `javascript:`, `data:`, `file:`.
 */
export function sanitizeUrl(value, maxLength = 500) {
  const clean = sanitizeString(value, maxLength);
  if (!clean) return '';
  try {
    const url = new URL(clean);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Verifica que un valor pertenezca a una lista blanca (ej. sede).
 */
export function sanitizeEnum(value, allowed, fallback = '') {
  const clean = sanitizeString(value, LIMITS.GENERIC).toUpperCase();
  const match = allowed.map(a => String(a).toUpperCase()).find(a => a === clean);
  return match ? allowed.find(a => String(a).toUpperCase() === match) : fallback;
}

/**
 * Escape de HTML para cualquier texto que se renderice en UI o en notas del CRM.
 * Bloquea XSS almacenado: `<img onerror=...>` deja de ser ejecutable.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Saneado para consultas vTiger (Webservice `operation=query`).
 * Defensa en profundidad: comillas simples, barras invertidas y controles.
 * Se aplica SIEMPRE antes de interpolar un valor en un SELECT.
 */
export function sanitizeForVtigerQuery(value, maxLength = 100) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFC')
    // La barra invertida se DUPLICA: es el carácter de escape de MySQL. Sin esto,
    // un valor terminado en '\' podría anular el escape de la comilla siguiente.
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    // Se eliminan controles y el punto y coma (terminador de sentencia).
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/;/g, '')
    .trim()
    .slice(0, maxLength);
}

/** Sólo dígitos: para teléfonos y números de documento en consultas. */
export function digitsOnly(value, maxLength = 15) {
  return String(value ?? '').replace(/\D/g, '').slice(0, maxLength);
}

/**
 * Saneador recursivo de objetos con allow-list opcional.
 * - Elimina claves prohibidas (prototype pollution).
 * - Limita profundidad y número de claves (anti payload bomba).
 *
 * @param {object} input
 * @param {object} [options]
 * @param {string[]} [options.allowKeys] si se define, se descarta todo lo demás
 * @param {number} [options.maxDepth]
 * @param {number} [options.maxKeys]
 */
export function sanitizeObject(input, { allowKeys = null, maxDepth = 4, maxKeys = 100 } = {}) {
  const seen = new WeakSet();

  function walk(node, depth) {
    if (depth > maxDepth) return null;
    if (node === null || typeof node !== 'object') {
      return typeof node === 'string' ? sanitizeString(node, LIMITS.GENERIC) : node;
    }
    if (seen.has(node)) return null;
    seen.add(node);

    if (Array.isArray(node)) {
      return node.slice(0, maxKeys).map(item => walk(item, depth + 1));
    }

    const out = {};
    let count = 0;
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      if (allowKeys && !allowKeys.includes(key)) continue;
      if (count++ >= maxKeys) break;
      out[key] = walk(value, depth + 1);
    }
    return out;
  }

  return walk(input, 0);
}

/** Campos aceptados en el webhook de contacto (GHL / vTiger / Pipedream). */
export const CONTACT_PAYLOAD_FIELDS = [
  'id', 'contactId', 'contact_id', 'locationId', 'location_id', 'sede', 'targetSede',
  'firstName', 'first_name', 'lastName', 'last_name', 'name', 'email', 'phone',
  'city', 'state', 'timezone', 'source', 'tags', 'customFields', 'contact'
];

/**
 * Saneador del payload de contacto: allow-list + saneado por tipo.
 * Devuelve un objeto limpio, nunca el original.
 *
 * @param {object} raw `req.body` sin validar
 */
export function sanitizeContactPayload(raw = {}) {
  if (!raw || typeof raw !== 'object') return {};

  // 1. Primero se poda el árbol completo (anti prototype pollution + profundidad)
  const allowed = sanitizeObject(raw, { allowKeys: CONTACT_PAYLOAD_FIELDS });

  // 2. Saneado por campo con formato y límite propios
  const clean = {
    id: sanitizeId(allowed.id || allowed.contactId || allowed.contact_id),
    locationId: sanitizeId(allowed.locationId || allowed.location_id),
    sede: sanitizeString(allowed.sede || allowed.targetSede, 40),
    firstName: sanitizeString(allowed.firstName || allowed.first_name, LIMITS.NAME),
    lastName: sanitizeString(allowed.lastName || allowed.last_name, LIMITS.NAME),
    name: sanitizeString(allowed.name, LIMITS.NAME * 2),
    email: sanitizeEmail(allowed.email),
    phone: sanitizePhone(allowed.phone),
    city: sanitizeString(allowed.city, LIMITS.CITY),
    state: sanitizeString(allowed.state, LIMITS.STATE),
    timezone: sanitizeString(allowed.timezone, LIMITS.STATE),
    source: sanitizeString(allowed.source, LIMITS.SOURCE),
    tags: [],
    customFields: []
  };

  // 3. Etiquetas: allow-list de alfabeto (evita inyección en filtros de GHL)
  if (Array.isArray(allowed.tags)) {
    clean.tags = allowed.tags
      .slice(0, LIMITS.MAX_TAGS)
      .map(t => sanitizeString(typeof t === 'string' ? t : '', LIMITS.TAG))
      .filter(Boolean)
      .map(t => t.toLowerCase().replace(/[^a-z0-9áéíóúñ._-]/gi, '-'));
  }

  // 4. Custom fields: sólo pares {id, field_value} con id de formato GHL
  if (Array.isArray(allowed.customFields)) {
    clean.customFields = allowed.customFields
      .slice(0, LIMITS.MAX_CUSTOM_FIELDS)
      .map(cf => {
        if (!cf || typeof cf !== 'object') return null;
        const fieldId = sanitizeId(cf.id);
        if (!fieldId) return null;
        const value = cf.field_value ?? cf.value;
        return {
          id: fieldId,
          field_value: typeof value === 'number' || typeof value === 'boolean'
            ? value
            : sanitizeString(value, LIMITS.GENERIC)
        };
      })
      .filter(Boolean);
  }

  // 5. Contacto anidado (formato Pipedream/GHL): se sanea recursivamente
  if (allowed.contact && typeof allowed.contact === 'object') {
    clean.contact = sanitizeContactPayload(allowed.contact);
  }

  return clean;
}

/**
 * Verifica si un objeto contiene patrones sospechosos de inyección.
 * Se usa para auditar (no para bloquear silenciosamente) y alimentar el log forense.
 * @returns {{ suspicious: boolean, reasons: string[] }}
 */
export function detectInjectionPatterns(value, path = '$') {
  const reasons = [];
  const PATTERNS = [
    { rx: /(\bUNION\b[\s\S]{0,20}\bSELECT\b)/i, reason: 'SQL UNION SELECT' },
    { rx: /('\s*(OR|AND)\s*'?\d+'?\s*=\s*'?\d+)/i, reason: 'SQL tautología' },
    { rx: /(--|\/\*|\*\/)/, reason: 'comentario SQL' },
    { rx: /<script[\s>]/i, reason: 'XSS script tag' },
    { rx: /on(error|load|click)\s*=/i, reason: 'XSS event handler' },
    { rx: /javascript:/i, reason: 'esquema javascript:' },
    { rx: /\$\{[\s\S]{0,40}\}/, reason: 'interpolación de plantilla' }
  ];

  function walk(node, currentPath) {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      for (const { rx, reason } of PATTERNS) {
        if (rx.test(node)) reasons.push(`${currentPath}: ${reason}`);
      }
      return;
    }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(k)) {
        reasons.push(`${currentPath}.${k}: prototype pollution`);
        continue;
      }
      walk(v, `${currentPath}.${k}`);
    }
  }

  walk(value, path);
  return { suspicious: reasons.length > 0, reasons };
}
