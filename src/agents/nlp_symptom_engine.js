import { learningBrain } from '../services/learning_brain.js';

/**
 * NLP Symptom Engine & Entity Extractor (Laboratorios Naturales)
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
    'testosterona', 'tetosterona', 'energia masculina', 'deseo sexual', 'fuerza intima', 'poder interior',
    'texto men', 'textomen', 'pajarito', 'duro el pajarito', 'se ponga duro', 'ponga duro',
    'se me para', 'no se me para', 'se pare', 'disfuncion', 'disfuncion erectil', 'problemas en la cama'
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
  ],
  'Hongos': [
    'hongo', 'hongos', 'pie de atleta', 'onicomicosis', 'unas amarillas', 'comezon pies'
  ],
  'Gummies': [
    'gummies', 'gomitas', 'gummy', 'gomita', 'gomas', 'colageno en gomitas', 'vitaminas gomitas', 'suplemento gomitas'
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
    { regex: /muestra gratis potencia|muestra gratis tetosterona|muestra gratis testosterona/i, treatment: 'Potencia' },
    { regex: /muestra gratis artritis/i, treatment: 'Artritis' },
    { regex: /muestra gratis diabetes/i, treatment: 'Diabetes' },
    { regex: /muestra gratis prostata/i, treatment: 'Prostata' },
    { regex: /muestra gratis colageno/i, treatment: 'Colageno' },
    { regex: /muestra gratis vision/i, treatment: 'Vision' },
    { regex: /muestra gratis gastro/i, treatment: 'Gastro' },
    { regex: /muestra gratis hongos/i, treatment: 'Hongos' },
    { regex: /muestra gratis gummies|muestra gratis gomitas/i, treatment: 'Gummies' },
    { regex: /poder interior|pajarito|ponga duro|se me pare|no se me para/i, treatment: 'Potencia' }
  ];

  const scores = {};
  for (const treatment of Object.keys(SYMPTOM_DICTIONARY)) {
    // Reducimos el peso del cerebro estadístico para que solo actúe como desempate (x0.1)
    scores[treatment] = (brainResult.scores && brainResult.scores[treatment]) ? (brainResult.scores[treatment] * 0.1) : 0;
  }

  // Puntuación por título directo publicitario (Prioridad Máxima = 1000 puntos)
  for (const dam of directAdMatches) {
    if (dam.regex.test(norm)) {
      scores[dam.treatment] += 1000;
    }
  }

  // Puntuación por síntomas clásicos en el texto (Prioridad Alta = 500 puntos)
  for (const [treatment, keywords] of Object.entries(SYMPTOM_DICTIONARY)) {
    for (const kw of keywords) {
      if (norm.includes(kw)) {
        scores[treatment] += 500;
      }
    }
  }

  // Filtrar tratamientos con puntuación > 0 y ordenar de mayor a menor
  const sortedTreatments = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([treatment]) => treatment);

  // Solo consideramos un diagnóstico válido si superó el umbral de ruido conversacional (> 100 puntos)
  const topScore = sortedTreatments.length > 0 ? scores[sortedTreatments[0]] : 0;
  const primaryTreatment = topScore >= 100 ? sortedTreatments[0] : null;
  const productTags = sortedTreatments
    .filter(t => scores[t] >= 300 && (scores[t] >= topScore * 0.5 || t === primaryTreatment))
    .map(t => `producto-${t.toLowerCase()}`);

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
  if (/gumm(?:y|ies)|gomita|gomitas/i.test(norm)) return 'Gummies';
  if (/colageno|colagen|collagen|piel|arrugas/i.test(norm)) return 'Colageno';
  if (/potencia|sexual|vigor|ereccion|masculin|fuerza intima|poder interior|testosterona|tetosterona|texto men|textomen|testo\b|pajarito|ponga duro/i.test(norm)) return 'Potencia';
  if (/diabetes|glucosa|azucar|nopal/i.test(norm)) return 'Diabetes';
  if (/prostata|prostatico/i.test(norm)) return 'Prostata';
  if (/vision|vista|catarata|ojos/i.test(norm)) return 'Vision';
  if (/gastro|gastritis|colon|acidez|reflujo/i.test(norm)) return 'Gastro';
  if (/artritis|articulacion|rodilla|cartilago|hueso|artrosis/i.test(norm)) return 'Artritis';
  if (/hongos?|onicomicosis|pie de atleta/i.test(norm)) return 'Hongos';
  return null;
}

/**
 * Determina si una cadena de texto califica como nombre de conjunto de anuncios (AdSet)
 * y no como un medio/parámetro genérico (cpc, paid social, messenger, etc.).
 * Debe contener palabras clave de Dolencia, Proveedor, o tener estructura de pauta ("DOLENCIA - PROVEEDOR - ...").
 */
export function isAdsetCandidate(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  if (s.length < 3) return false;

  // Descartar palabras genéricas o vacías
  if (/^(cpc|cpm|paid|paid\s*social|social|messenger|facebook|fb|organic|organico|referral|direct|none|\(not set\)|n\/a|--)$/i.test(s)) {
    return false;
  }

  // 1. Si contiene una dolencia/tratamiento identificable
  if (inferTreatmentFromCampaignOrUtm(s)) {
    return true;
  }

  // 2. Si contiene un proveedor publicitario identificable
  if (/ERNESTO|CLIC?K?2RING|IN[\s_-]*HOUSE|UP[\s_-]*IDEAS|ENZO|DIURNAY|C[EÉ]SAR/i.test(s)) {
    return true;
  }

  // 3. Estructura con guiones o separadores de pauta (longitud representativa >= 8)
  if (/[-_]/.test(s) && s.length >= 8) {
    return true;
  }

  return false;
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
 * 3. Determina el Proveedor Publicitario Oficial conforme a la matriz de sedes y pauta.
/**
 * Resuelve la Sede Oficial según Nombre de Campaña (Prioridad 1) y Fanpage (Prioridad 2)
 */
export function resolveLeadSede({ pageId = '', pageName = '', campaignName = '' } = {}) {
  const cUpper = (campaignName || '').toUpperCase();
  const pUpper = (pageName || '').toUpperCase();
  const pId = String(pageId || '').trim();

  // 1. Prioridad Máxima: Detección a nivel Nombre de Campaña
  if (/\bPIURA\b/i.test(cUpper) || cUpper.includes('CÉSAR - PIURA') || cUpper.includes('CESAR - PIURA') || cUpper.includes('CSAR - PIURA')) {
    return 'PIURA';
  }
  if (/\bBENAVIDES\b/i.test(cUpper)) {
    return 'BENAVIDES';
  }
  if (/\bROOSEVELT\b|\bROOSVELT\b/i.test(cUpper)) {
    return 'ROOSEVELT';
  }
  if (/\bPALACIOS\b|\bULTRA\b/i.test(cUpper)) {
    return 'PALACIOS';
  }

  // 2. Mapeo Oficial por Page ID de Fanpage
  // BENAVIDES (Matriz Confirmada):
  // - "Bio Natural" (126154270581792)
  // - "Naturales Bio Corp" (510617778807469)
  // - "BioNatural Fuerza" (1147742788423762)
  if (pId === '126154270581792' || pId === '510617778807469' || pId === '1147742788423762') {
    return 'BENAVIDES';
  }

  // PALACIOS:
  // - "BioNatural - Ultra" (111906554968800)
  // - "Naturales BioNatural" (566501466542620)
  // - "Laboratorios Naturales BIO" (718150351371765)
  if (pId === '111906554968800' || pId === '566501466542620' || pId === '718150351371765') {
    return 'PALACIOS';
  }

  // ROOSEVELT:
  // - "Bio Naturales" (568453466348355)
  // - "BioNatural Plus" (1075001465705985)
  if (pId === '568453466348355' || pId === '1075001465705985') {
    return 'ROOSEVELT';
  }

  // PIURA:
  // - "Natural Bio" (1147257965133802)
  // - "BioNatural" (1057863707412893)
  if (pId === '1147257965133802' || pId === '1057863707412893') {
    return 'PIURA';
  }

  // 3. Fallback por Nombre de Fanpage
  if (pUpper.includes('BENAVIDES 2') || pUpper.includes('BENAVIDES_2')) {
    return 'BENAVIDES_2';
  }
  if (pUpper.includes('BENAVIDES') || pUpper.includes('CORP') || pUpper.includes('FUERZA')) {
    return 'BENAVIDES';
  }
  if (pUpper.includes('ROOSEVELT') || pUpper.includes('ROOSVELT') || pUpper.includes('PLUS')) {
    return 'ROOSEVELT';
  }
  if (pUpper.includes('PIURA')) {
    return 'PIURA';
  }
  if (pUpper.includes('ULTRA') || pUpper.includes('PALACIOS') || pUpper.includes('NATURALES BIONATURAL') || pUpper.includes('LABORATORIOS NATURALES BIO')) {
    return 'PALACIOS';
  }
  if (pUpper.includes('NATURAL BIO BENAVIDES') || pUpper === 'BIO NATURAL' || pUpper.includes('BIO NATURAL')) {
    return 'BENAVIDES';
  }

  return 'PALACIOS';
}

/**
 * Resuelve el Canal de Captación: FB-MSGR (Messenger), FORM (Formulario de Clientes Potenciales) o WHATSAPP
 */
export function resolveLeadChannel({ campaignName = '', formId = null, isForm = false } = {}) {
  const cUpper = (campaignName || '').toUpperCase();
  if (isForm || formId || /FORMULARIO|\bFORM\b/i.test(cUpper)) {
    return 'FORM';
  }
  if (/WHATSAPP|\bWSP\b/i.test(cUpper)) {
    return 'WHATSAPP';
  }
  return 'FB-MSGR';
}

/**
 * 3. Determina el Proveedor Publicitario Oficial conforme a Campaña y Matriz de Fanpages
 */
export function resolveLeadProvider({
  pageId = '',
  pageName = '',
  campaignName = '',
  adsetName = '',
  adName = '',
  isPaidAd = true,
  existingSource = ''
} = {}) {
  const combinedMetaText = `${campaignName} ${adsetName} ${adName} ${existingSource}`.toUpperCase();
  const cleanPageName = (pageName || '').toUpperCase();
  const cleanPageId = String(pageId || '').trim();

  // 1. Detección explícita a nivel NOMBRE DE CAMPAÑA / CONJUNTO / ANUNCIO
  if (/IN[\s_-]*HOUSE|IN[\s_-]*HO\b/i.test(combinedMetaText)) {
    return 'IN_HOUSE';
  }
  if (/ERNESTO/i.test(combinedMetaText)) {
    return 'ERNESTO';
  }
  if (/CLIC?K?2RING|C[EÉ]SAR|PIKALEX|PIKALES/i.test(combinedMetaText)) {
    return 'CLICK2RING';
  }
  if (/UP[\s_-]*IDEAS/i.test(combinedMetaText)) {
    return 'UP_IDEAS';
  }
  if (/ENZO/i.test(combinedMetaText)) {
    return 'ENZO';
  }
  if (/DIURNAY/i.test(combinedMetaText)) {
    return 'DIURNAY';
  }

  // 2. Mapeo Oficial por FANPAGE (Inmutable por Propiedad de Página)
  // PALACIOS:
  // - "BioNatural - Ultra" (111906554968800): ¡TODO lo de Ultra es CLICK2RING!
  if (cleanPageId === '111906554968800' || cleanPageName.includes('ULTRA')) {
    return 'CLICK2RING';
  }
  // - "Naturales BioNatural" (566501466542620): ERNESTO
  if (cleanPageId === '566501466542620' || cleanPageName.includes('NATURALES BIONATURAL')) {
    return 'ERNESTO';
  }
  // - "Laboratorios Naturales BIO" (718150351371765): IN_HOUSE
  if (cleanPageId === '718150351371765' || cleanPageName.includes('LABORATORIOS NATURALES BIO')) {
    return 'IN_HOUSE';
  }

  // BENAVIDES:
  // - "Bio Natural" (126154270581792): CLICK2RING
  if (cleanPageId === '126154270581792' || cleanPageName === 'BIO NATURAL' || cleanPageName.includes('NATURAL BIO BENAVIDES') || cleanPageName.includes('BIO NATURAL BENAVIDES')) {
    return 'CLICK2RING';
  }
  // - "Naturales Bio Corp" (510617778807469): ERNESTO
  if (cleanPageId === '510617778807469' || cleanPageName.includes('BIO CORP')) {
    return 'ERNESTO';
  }
  // - "BioNatural Fuerza" (1147742788423762): IN_HOUSE
  if (cleanPageId === '1147742788423762' || cleanPageName.includes('FUERZA')) {
    return 'IN_HOUSE';
  }

  // 3. Fallback solo para tráfico no clasificado sin fanpage mapeada
  return isPaidAd ? 'CLICK2RING' : 'IN_HOUSE';
}

/**
 * 4. Genera la Fuente Estructurada Estilo vTiger: [SEDE]-[PROVEEDOR]-[CANAL]-[TRATAMIENTO]
 */
export function buildVtigerSource({
  sedeName = '',
  campaignName = '',
  pageId = '',
  provider = 'CLICK2RING',
  channel = 'FB-MSGR',
  treatment = 'General'
}) {
  let cleanSede = resolveLeadSede({ pageId, pageName: sedeName, campaignName });

  let cleanProvider = provider;
  if (/pikalex|pikales/i.test(cleanProvider)) {
    cleanProvider = 'CLICK2RING';
  }

  let cleanTreatment = treatment || 'General';
  // Si por error viene un código de 2 letras o menor a 3 caracteres, fallback a 'General'
  if (cleanTreatment.length <= 2) {
    cleanTreatment = 'General';
  } else {
    cleanTreatment = cleanTreatment.charAt(0).toUpperCase() + cleanTreatment.slice(1).toLowerCase();
  }

  return `${cleanSede}-${cleanProvider}-${channel}-${cleanTreatment}`;
}

/**
 * Valida si un valor corresponde a un identificador numérico de anuncio de Meta Ads.
 * Meta Ad IDs son secuencias numéricas de 8 a 25 dígitos (ej: 120226588408570607).
 * Rechaza cadenas de origen o texto como "PALACIOS-ERNESTO-FB-MSGR-Artritis", "N/A", etc.
 * @param {any} val
 * @returns {boolean}
 */
export function isValidMetaAdId(val) {
  if (!val) return false;
  const str = String(val).trim();
  return /^\d{8,25}$/.test(str);
}
