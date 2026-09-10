import { learningBrain } from '../services/learning_brain.js';

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
    'dolor de rodilla', 'dolor en las rodillas', 'dolor de hombro', 'dolor en las manos', 'artrosis'
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
    'testosterona', 'energia masculina', 'deseo sexual', 'fuerza intima', 'poder interior'
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
 * 1. Infiere la condición/tratamiento y todas las etiquetas médicas detectadas.
 * Utiliza el Cerebro de Autoaprendizaje Estadístico (LearningBrain) con respaldo algorítmico.
 */
export function analyzeSymptoms(text, campaignName = '', utmMedium = '') {
  const norm = normalizeText(text);
  if (!norm && !campaignName && !utmMedium) {
    return { primaryTreatment: null, matchedTreatments: [], tags: [], productTags: [], confidence: 0 };
  }

  // 1. Inferencia del Cerebro de Autoaprendizaje (Statistical Learning Brain)
  const brainResult = learningBrain.predictTreatment(text, campaignName, utmMedium);

  // 2. Detección directa de títulos publicitarios ("MUESTRA GRATIS [PRODUCTO]")
  const directAdMatches = [
    { regex: /muestra gratis potencia/i, treatment: 'Potencia' },
    { regex: /muestra gratis artritis/i, treatment: 'Artritis' },
    { regex: /muestra gratis diabetes/i, treatment: 'Diabetes' },
    { regex: /muestra gratis prostata/i, treatment: 'Prostata' },
    { regex: /muestra gratis colageno/i, treatment: 'Colageno' },
    { regex: /muestra gratis vision/i, treatment: 'Vision' },
    { regex: /muestra gratis gastro/i, treatment: 'Gastro' },
    { regex: /poder interior/i, treatment: 'Potencia' }
  ];

  const scores = {};
  for (const treatment of Object.keys(SYMPTOM_DICTIONARY)) {
    scores[treatment] = (brainResult.scores && brainResult.scores[treatment]) ? brainResult.scores[treatment] : 0;
  }

  // Puntuación por título directo publicitario (Prioridad Máxima = 10 puntos)
  for (const dam of directAdMatches) {
    if (dam.regex.test(norm)) {
      scores[dam.treatment] += 15;
    }
  }

  // Puntuación por síntomas clásicos en el texto
  for (const [treatment, keywords] of Object.entries(SYMPTOM_DICTIONARY)) {
    for (const kw of keywords) {
      if (norm.includes(kw)) {
        scores[treatment] += 2;
      }
    }
  }

  // Filtrar tratamientos con puntuación > 0 y ordenar de mayor a menor
  const sortedTreatments = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([treatment]) => treatment);

  const primaryTreatment = sortedTreatments.length > 0 ? sortedTreatments[0] : null;
  const productTags = sortedTreatments.map(t => `producto-${t.toLowerCase()}`);

  return {
    primaryTreatment,
    matchedTreatments: sortedTreatments,
    productTags,
    confidence: brainResult.confidence || (primaryTreatment ? 80 : 0)
  };
}

/**
 * Infiere la condición/tratamiento a partir de textos de UTM (utmCampaign, utmMedium, utmContent, nombre de campaña).
 * Crucial para leads que solo escriben "MUESTRA GRATIS" sin expresar síntomas explícitos en el chat.
 */
export function inferTreatmentFromCampaignOrUtm(text) {
  if (!text) return null;
  const norm = normalizeText(text);
  if (/colageno|colagen|collagen|piel|arrugas/i.test(norm)) return 'Colageno';
  if (/potencia|sexual|vigor|ereccion|masculin|fuerza intima|poder interior/i.test(norm)) return 'Potencia';
  if (/diabetes|glucosa|azucar|nopal/i.test(norm)) return 'Diabetes';
  if (/prostata|prostatico/i.test(norm)) return 'Prostata';
  if (/vision|vista|catarata|ojos/i.test(norm)) return 'Vision';
  if (/gastro|gastritis|colon|acidez|reflujo/i.test(norm)) return 'Gastro';
  if (/artritis|articulacion|rodilla|cartilago|hueso|artrosis/i.test(norm)) return 'Artritis';
  return null;
}

import { getGeoFromPhone, parseFullUsAddress } from '../utils/us_geo_data.js';

/**
 * 2. Extrae teléfono y dirección de envío desde el texto de la conversación
 * Desglosa la información para la sección "General Info" de GHL:
 * { phone, address1, city, state, postalCode, country: "United States", timezone }
 */
export function extractShippingData(text, existingPhone = null) {
  if (!text && !existingPhone) {
    return {
      hasPhone: false,
      phone: null,
      hasAddress: false,
      address: null,
      address1: null,
      city: null,
      state: null,
      postalCode: null,
      country: 'United States',
      timezone: null,
      isHotLead: false
    };
  }

  // Detección de Teléfono (ESTRICTAMENTE ESTADOS UNIDOS: 10 dígitos con código de área válido)
  let phone = existingPhone || null;
  if (!phone && text) {
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
  }

  // Detección de Dirección FÍSICA USA (Street, Ave, Blvd, Dr, Rd, Ct, Apt, Suite, Unit, ZIP Code 5 dígitos, Estados US)
  let rawAddress = null;

  if (text) {
    // 1. Detección por frase introductoria
    const introMatch = text.match(/(?:vivo en|mi direcci[oó]n(?: es)?|my address is|address:?)\s+([^,.\n]+(?:,\s*[^,.\n]+)*(?:\s+\d{5}(?:-\d{4})?)?)/i);
    if (introMatch && introMatch[1]) {
      rawAddress = introMatch[1]
        .replace(/(?:\s+(?:y|mi)\s+(?:cel|celular|tel|telefono|teléfono|numero|número).*|\s+[2-9]\d{9}.*)$/i, '')
        .trim();
    }

    // 2. Detección directa de formato de calle estadounidense si no hubo match por frase
    if (!rawAddress) {
      const usDirectPattern = /\b\d{1,5}\s+[A-Za-z0-9#\s.-]+?\s+(?:street|st|avenue|ave|blvd|boulevard|drive|dr|road|rd|lane|ln|way|court|ct|circle|cir|terrace|ter|place|pl|trail|trl|parkway|pkwy|highway|hwy|suite|ste|apt|unit)\b(?:[A-Za-z0-9#\s,.-]+?\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|Florida|California|Texas|New York|New Jersey|Illinois)\b)?(?:\s+\d{5}(?:-\d{4})?)?/i;
      const directMatch = text.match(usDirectPattern);
      if (directMatch && directMatch[0] && directMatch[0].trim().length >= 8) {
        rawAddress = directMatch[0].trim();
      }
    }

    // 3. Fallback a líneas con código postal US (5 dígitos)
    if (!rawAddress) {
      const usZipRegex = /\b\d{5}(?:-\d{4})?\b/;
      const usAddressKeywords = /\b(address|direccion|dirección|street|st|avenue|ave|blvd|boulevard|drive|dr|road|rd|lane|ln|way|court|ct|suite|ste|apt|apartment|unit|zip|zipcode|código postal|codigo postal|po box|p\.o\.\s*box)\b/i;
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if ((usAddressKeywords.test(line) && usZipRegex.test(line)) || (usZipRegex.test(line) && /\d+\s+[A-Za-z]/.test(line))) {
          rawAddress = line.trim().replace(/^(mi direccion es|mi dirección es|my address is|address:|direccion:|dirección:)\s*/i, '');
          break;
        }
      }
    }

    // 4. Filtro de exclusión: Si menciona un país o ciudad fuera de Estados Unidos, se descarta
    if (rawAddress) {
      const nonUsPattern = /\b(peru|perú|lima|callao|arequipa|trujillo|mexico|méxico|colombia|bogota|bogotá|medellin|medellín|argentina|buenos aires|chile|santiago|venezuela|caracas|ecuador|quito|guayaquil|bolivia|la paz|guatemala|honduras|el salvador|españa|spain)\b/i;
      if (nonUsPattern.test(rawAddress)) {
        rawAddress = null;
      }
    }
  }

  // 5. Desglose detallado de la dirección
  const parsedAddress = rawAddress ? parseFullUsAddress(rawAddress) : null;

  // 6. Inferencia Geográfica a partir del Teléfono de USA
  const phoneGeo = phone ? getGeoFromPhone(phone) : null;

  const finalState = parsedAddress?.state || phoneGeo?.state || null;
  const finalTimezone = parsedAddress?.timezone || phoneGeo?.timezone || null;

  const isHotLead = Boolean(phone || rawAddress);

  return {
    hasPhone: Boolean(phone),
    phone,
    hasAddress: Boolean(parsedAddress?.address1 || rawAddress),
    address: rawAddress,
    address1: parsedAddress?.address1 || rawAddress || null,
    city: parsedAddress?.city || null,
    state: finalState,
    postalCode: parsedAddress?.postalCode || null,
    country: 'United States',
    timezone: finalTimezone,
    isHotLead
  };
}

/**
 * 3. Genera la Fuente Estructurada Estilo vTiger: [SEDE]-[PROVEEDOR]-[CANAL]-[TRATAMIENTO]
 */
export function buildVtigerSource({ sedeName, provider = 'CLICK2RING', channel = 'FB-MSGR', treatment = 'General' }) {
  let cleanSede = 'PALACIOS';
  const sUpper = (sedeName || '').toUpperCase();

  // Mapeo exacto por nombres de Fanpage para evitar caídas al valor por defecto
  if (sUpper.includes('NATURAL BIO') || sUpper === 'BIONATURAL' || sUpper.includes('PIURA')) {
    cleanSede = 'PIURA';
  } else if (sUpper.includes('BENAVIDES 2') || sUpper.includes('FUERZA')) {
    cleanSede = 'BENAVIDES_2';
  } else if (sUpper.includes('BENAVIDES') || sUpper.includes('CORP') || sUpper === 'BIO NATURAL') {
    cleanSede = 'BENAVIDES';
  } else if (sUpper.includes('ROOSEVELT') || sUpper.includes('ROOSVELT') || sUpper.includes('BIO NATURALES') || sUpper.includes('BIONATURAL PLUS')) {
    cleanSede = 'ROOSEVELT';
  } else if (sUpper.includes('ULTRA')) {
    cleanSede = 'PALACIOS_ULTRA';
  } else if (sUpper.includes('PALACIOS') || sUpper.includes('NATURALES BIONATURAL') || sUpper.includes('LABORATORIOS NATURALES BIO')) {
    cleanSede = 'PALACIOS';
  }

  let cleanTreatment = treatment || 'General';
  // Si por error viene un código de 2 letras (como un estado 'AR', 'TX') o texto menor a 3 caracteres, fallback a 'General'
  if (cleanTreatment.length <= 2) {
    cleanTreatment = 'General';
  } else {
    cleanTreatment = cleanTreatment.charAt(0).toUpperCase() + cleanTreatment.slice(1).toLowerCase();
  }

  return `${cleanSede}-${provider}-${channel}-${cleanTreatment}`;
}
