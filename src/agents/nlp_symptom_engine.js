/**
 * 🧠 NLP Symptom Engine & Entity Extractor (Laboratorios Naturales)
 * 
 * Extrae de forma semántica y algorítmica:
 * 1. Condición / Tratamiento médico según síntomas expresados en lenguaje cotidiano.
 * 2. Teléfonos y direcciones de envío en el texto del chat (Detección de Lead Caliente).
 * 3. Nomenclatura estructurada de origen estilo vTiger: [SEDE]-[PROVEEDOR]-[CANAL]-[TRATAMIENTO].
 */

// Diccionario de síntomas clínicos mapeados a tratamientos
const SYMPTOM_DICTIONARY = {
  'Artritis': [
    'artritis', 'articulacion', 'articulaciones', 'rodilla', 'rodillas', 'cartilago', 'cartilagos',
    'hueso', 'huesos', 'reuma', 'reumatismo', 'crujido', 'crujidos', 'crujen', 'inflamacion articulaciones',
    'dolor de rodilla', 'dolor en las rodillas', 'dolor de hombro', 'dolor en las manos', 'artrosis',
    'colageno', 'muestra gratis'
  ],
  'Diabetes': [
    'diabetes', 'azucar', 'azucar alta', 'glucosa', 'insulina', 'sed constante', 'mucha sed',
    'orinar mucho', 'orina frecuente', 'hormigueo en pies', 'hormigueo pies', 'pies hinchados',
    'nopal', 'nopal plus', 'diabetico', 'diabetica'
  ],
  'Prostata': [
    'prostata', 'chorro debil', 'dificultad para orinar', 'levantarse en la noche', 'levantarse a orinar',
    'inflamacion de prostata', 'ardor al orinar', 'prostatico', 'prostata inflamada'
  ],
  'Potencia': [
    'potencia', 'vigor', 'ereccion', 'sexual', 'libido', 'cansancio intimo', 'rendimiento',
    'testosterona', 'energia masculina', 'deseo sexual', 'fuerza intima'
  ],
  'Colageno': [
    'colageno', 'piel', 'arrugas', 'caida de cabello', 'unas', 'regenerador celular', 'elasticidad'
  ],
  'Vision': [
    'vision', 'vista', 'catarata', 'cataratas', 'ojos rojos', 'vista cansada', 'vision borrosa',
    'borroso', 'ardor en los ojos', 'degeneracion macular'
  ],
  'Gastro': [
    'gastritis', 'reflujo', 'acidez', 'colon', 'estomago', 'digestion', 'pesadez estomacal',
    'dolor de estomago', 'colitis', 'estreñimiento'
  ]
};

/**
 * Normaliza texto eliminando tildes y caracteres especiales
 */
export function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * 1. Infiere la condición/tratamiento y todas las etiquetas médicas detectadas
 */
export function analyzeSymptoms(text) {
  const norm = normalizeText(text);
  if (!norm) return { primaryTreatment: null, matchedTreatments: [], tags: [] };

  const matches = [];

  for (const [treatment, keywords] of Object.entries(SYMPTOM_DICTIONARY)) {
    for (const kw of keywords) {
      if (norm.includes(kw)) {
        if (!matches.includes(treatment)) {
          matches.push(treatment);
        }
        break;
      }
    }
  }

  const primaryTreatment = matches.length > 0 ? matches[0] : null;
  const productTags = matches.map(t => `producto-${t.toLowerCase()}`);

  return {
    primaryTreatment,
    matchedTreatments: matches,
    productTags
  };
}

/**
 * 2. Extrae teléfono y dirección de envío desde el texto de la conversación
 */
export function extractShippingData(text) {
  if (!text) return { hasPhone: false, phone: null, hasAddress: false, address: null, isHotLead: false };

  // Detección de Teléfono (ESTRICTAMENTE ESTADOS UNIDOS: 10 dígitos con código de área válido)
  let phone = null;
  const usPhonePatterns = [
    /(?:\+?1\s*(?:[.-]\s*)?)?(?:\(\s*([2-9]\d{2})\s*\)|([2-9]\d{2}))\s*(?:[.-]\s*)?([2-9]\d{2})\s*(?:[.-]\s*)?(\d{4})\b/,
    /\b(?:\+?1\s*)?([2-9]\d{9})\b/
  ];

  for (const pattern of usPhonePatterns) {
    const match = text.match(pattern);
    if (match) {
      const cleanNumber = match[0].replace(/\D/g, '');
      if (cleanNumber.length === 10 && cleanNumber[0] >= '2') {
        phone = `+1${cleanNumber}`;
        break;
      } else if (cleanNumber.length === 11 && cleanNumber.startsWith('1') && cleanNumber[1] >= '2') {
        phone = `+${cleanNumber}`;
        break;
      }
    }
  }

  // Detección de Dirección FÍSICA USA (Street, Ave, Blvd, Dr, Rd, Ct, Apt, Suite, Unit, ZIP Code 5 dígitos, Estados US)
  let address = null;

  // 1. Detección por frase introductoria (ej. "vivo en 742 Evergreen Terrace...", "mi direccion es 1024 Elm St...")
  const introMatch = text.match(/(?:vivo en|mi direcci[oó]n(?: es)?|my address is|address:?)\s+([^,.\n]+(?:,\s*[^,.\n]+)*(?:\s+\d{5}(?:-\d{4})?)?)/i);
  if (introMatch && introMatch[1]) {
    address = introMatch[1]
      .replace(/(?:\s+(?:y|mi)\s+(?:cel|celular|tel|telefono|teléfono|numero|número).*|\s+[2-9]\d{9}.*)$/i, '')
      .trim();
  }

  // 2. Detección directa de formato de calle estadounidense si no hubo match por frase
  if (!address) {
    const usDirectPattern = /\b\d{1,5}\s+[A-Za-z0-9#\s.-]+?\s+(?:street|st|avenue|ave|blvd|boulevard|drive|dr|road|rd|lane|ln|way|court|ct|circle|cir|terrace|ter|place|pl|trail|trl|parkway|pkwy|highway|hwy|suite|ste|apt|unit)\b(?:[A-Za-z0-9#\s,.-]+?\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|Florida|California|Texas|New York|New Jersey|Illinois)\b)?(?:\s+\d{5}(?:-\d{4})?)?/i;
    const directMatch = text.match(usDirectPattern);
    if (directMatch && directMatch[0] && directMatch[0].trim().length >= 8) {
      address = directMatch[0].trim();
    }
  }

  // 3. Fallback a líneas con código postal US (5 dígitos)
  if (!address) {
    const usZipRegex = /\b\d{5}(?:-\d{4})?\b/;
    const usAddressKeywords = /\b(address|direccion|dirección|street|st|avenue|ave|blvd|boulevard|drive|dr|road|rd|lane|ln|way|court|ct|suite|ste|apt|apartment|unit|zip|zipcode|código postal|codigo postal|po box|p\.o\.\s*box)\b/i;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if ((usAddressKeywords.test(line) && usZipRegex.test(line)) || (usZipRegex.test(line) && /\d+\s+[A-Za-z]/.test(line))) {
        address = line.trim().replace(/^(mi direccion es|mi dirección es|my address is|address:|direccion:|dirección:)\s*/i, '');
        break;
      }
    }
  }

  // 4. Filtro de exclusión: Si menciona un país o ciudad fuera de Estados Unidos, se descarta
  if (address) {
    const nonUsPattern = /\b(peru|perú|lima|callao|arequipa|trujillo|mexico|méxico|colombia|bogota|bogotá|medellin|medellín|argentina|buenos aires|chile|santiago|venezuela|caracas|ecuador|quito|guayaquil|bolivia|la paz|guatemala|honduras|el salvador|españa|spain)\b/i;
    if (nonUsPattern.test(address)) {
      address = null;
    }
  }

  const isHotLead = Boolean(phone || address);

  return {
    hasPhone: Boolean(phone),
    phone,
    hasAddress: Boolean(address),
    address,
    isHotLead
  };
}

/**
 * 3. Genera la Fuente Estructurada Estilo vTiger: [SEDE]-[PROVEEDOR]-[CANAL]-[TRATAMIENTO]
 */
export function buildVtigerSource({ sedeName, provider = 'CLICK2RING', channel = 'FB-MSGR', treatment = 'Artritis' }) {
  let cleanSede = 'PALACIOS';
  const sUpper = (sedeName || '').toUpperCase();

  if (sUpper.includes('BENAVIDES 2') || sUpper.includes('FUERZA')) cleanSede = 'BENAVIDES_2';
  else if (sUpper.includes('BENAVIDES') || sUpper.includes('CORP')) cleanSede = 'BENAVIDES';
  else if (sUpper.includes('ROOSEVELT') || sUpper.includes('ROOSVELT')) cleanSede = 'ROOSEVELT';
  else if (sUpper.includes('PIURA')) cleanSede = 'PIURA';
  else if (sUpper.includes('ULTRA')) cleanSede = 'PALACIOS_ULTRA';
  else if (sUpper.includes('PALACIOS')) cleanSede = 'PALACIOS';

  let cleanTreatment = treatment || 'General';
  // Capitalizar tratamiento
  cleanTreatment = cleanTreatment.charAt(0).toUpperCase() + cleanTreatment.slice(1).toLowerCase();

  return `${cleanSede}-${provider}-${channel}-${cleanTreatment}`;
}
