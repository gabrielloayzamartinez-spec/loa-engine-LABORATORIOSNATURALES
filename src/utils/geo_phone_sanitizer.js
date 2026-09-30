/**
 * ==============================================================================
 * LOA ENGINE - SANITIZACIÓN GEOGRÁFICA Y DE TELÉFONO (MIDDLEWARE DE INGESTA)
 * ==============================================================================
 * PROBLEMA REAL QUE RESUELVE:
 * Los registros llegaban a GHL con el **Estado inyectado en el campo Ciudad**
 * (ej. `city: "FL"`) y el estado vacío. Además había que descartar los registros
 * sin teléfono válido, porque el teléfono es el identificador único de fusión.
 *
 * ORDEN DE PRIORIDAD DE LAS FUENTES (aprendido del CRM real):
 *  1. `cf_1157`  -> ciudad operativa REAL de la empresa. Es el campo que el
 *                   negocio usa de verdad.
 *  2. `mailingcity` -> campo NATIVO de vTiger, pero está RESTRINGIDO por permisos
 *                   de rol: no es fiable. Se usa sólo como respaldo.
 * El código anterior leía únicamente `mailingcity`, por lo que la ciudad real
 * (cf_1157) nunca llegaba a GHL.
 * ==============================================================================
 */

/** Estados de EE.UU. con su nombre completo (el mercado es USA). */
export const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico'
};

const STATE_CODES = new Set(Object.keys(US_STATES));
const STATE_NAMES_UPPER = new Set(Object.values(US_STATES).map(n => n.toUpperCase()));

/** ¿El token es una abreviatura estatal válida? (FL, TX, ...) */
export function isUsStateCode(value) {
  return STATE_CODES.has(String(value || '').trim().toUpperCase());
}

/** ¿El texto es el NOMBRE COMPLETO de un estado? ("Florida") */
export function isUsStateName(value) {
  return STATE_NAMES_UPPER.has(String(value || '').trim().toUpperCase());
}

/** Normaliza un estado a su abreviatura de 2 letras (o '' si no es reconocible). */
export function normalizeUsState(value) {
  const raw = String(value || '').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!raw) return '';
  if (STATE_CODES.has(raw)) return raw;
  if (STATE_NAMES_UPPER.has(raw)) {
    return Object.keys(US_STATES).find(k => US_STATES[k].toUpperCase() === raw) || '';
  }
  // Extracción defensiva: "Miami, FL" / "FL 33125" -> FL
  const m = raw.match(/\b([A-Z]{2})\b(?:\s*\d{5})?$/);
  if (m && STATE_CODES.has(m[1])) return m[1];
  return '';
}

/**
 * Limpia una ciudad: quita el estado embebido, códigos postales y ruido.
 * @returns {{ city: string, state: string }} `state` sólo si se dedujo del texto.
 */
export function splitCityAndState(rawCity = '') {
  const raw = String(rawCity || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { city: '', state: '' };

  let city = raw;
  let state = '';
  let zip = '';

  // 0. El texto TERMINA con el NOMBRE COMPLETO de un estado ("Houston Texas").
  //    Se comprueba primero porque es más específico que el código de 2 letras.
  const matchNombre = city.match(/^(.*?)[,\s]+([A-Za-z\s]{4,})\.?$/);
  if (matchNombre && isUsStateName(matchNombre[2])) {
    city = matchNombre[1];
    state = normalizeUsState(matchNombre[2]);
  }

  // 1. "Miami, FL 33125" | "Miami FL" | "Miami, FL"
  const withSep = state ? null : city.match(/^(.*?)[,\s]+([A-Za-z]{2})\.?(?:\s*(\d{5}(?:-\d{4})?))?$/);
  if (withSep && STATE_CODES.has(withSep[2].toUpperCase())) {
    city = withSep[1];
    state = withSep[2].toUpperCase();
    zip = withSep[3] || '';
  } else if (!state) {
    // 2. La ciudad ES una abreviatura o el nombre de un estado
    const asState = normalizeUsState(city);
    if (asState) {
      state = asState;
      city = '';
    } else {
      const zipOnly = city.match(/^(.*?)\s+(\d{5}(?:-\d{4})?)$/);
      if (zipOnly) { city = zipOnly[1]; zip = zipOnly[2]; }
    }
  }

  city = city
    .replace(/[,\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, '')  // sin símbolos raros
    .trim();

  // Una "ciudad" de 1-2 letras sueltas no es una ciudad.
  if (city.length <= 2 && !state) {
    const maybe = normalizeUsState(city);
    if (maybe) return { city: '', state: maybe };
    city = '';
  }

  return { city, state, zip };
}

/**
 * Construye los campos geográficos a enviar a GHL, ya saneados.
 * Fuente de verdad: `cf_1157` (ciudad real de la empresa); `mailingcity` respaldo.
 *
 * @param {object} vContact registro de vTiger
 * @param {object} fieldIds IDs de custom fields de la sede (opcional)
 * @param {object} ghlContact contacto actual en GHL (para no borrar dato válido)
 * @returns {Array<{key:string, field_value:string}>} campos para el PUT de GHL
 */
export function buildSanitizedGeoFields(vContact = {}, fieldIds = {}, ghlContact = {}) {
  const ciudadCruda = vContact.cf_1157 || vContact.mailingcity || vContact.city || '';
  const estadoCrudo = vContact.mailingstate || vContact.state || '';
  const codigoPostal = vContact.mailingzip || vContact.zip || '';

  const separado = splitCityAndState(ciudadCruda);
  let city = separado.city;
  let state = normalizeUsState(estadoCrudo) || separado.state;

  // Nunca pisar un dato válido de GHL con vacío.
  const cityActual = String(ghlContact.city || '').trim();
  const stateActual = String(ghlContact.state || '').trim();
  if (!city && cityActual) city = cityActual;
  if (!state && stateActual) state = normalizeUsState(stateActual) || stateActual;

  const fields = [];
  if (city) fields.push({ key: 'city', field_value: city });
  if (state) fields.push({ key: 'state', field_value: state });
  const zip = String(codigoPostal || separado.zip || '').trim();
  if (/^\d{5}(-\d{4})?$/.test(zip)) fields.push({ key: 'postalCode', field_value: zip });

  return fields;
}

/**
 * Normaliza un teléfono a E.164 (formato de operación: +1 NANP de 10 dígitos).
 * Es el IDENTIFICADOR ÚNICO de fusión de contactos.
 *
 * @returns {string} '+13055551234' o '' si no es un teléfono válido.
 */
export function normalizeToE164(rawPhone = '', defaultCountryCode = '1') {
  const raw = String(rawPhone || '').trim();
  if (!raw) return '';

  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  // Descartar extensiones y números imposibles.
  if (digits.length < 10 || digits.length > 15) return '';

  // NANP: 10 dígitos -> +1XXXXXXXXXX ; 11 empezando por 1 -> +1XXXXXXXXXX
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith(defaultCountryCode)) return `+${digits}`;

  // Internacional: se respeta el prefijo tal cual.
  return `+${digits}`;
}

/** ¿Es un teléfono sincronizable? (regla de descarte) */
export function hasValidPhone(rawPhone = '') {
  return normalizeToE164(rawPhone).length >= 12;
}
