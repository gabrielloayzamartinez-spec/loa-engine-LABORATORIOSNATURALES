/**
 * ==============================================================================
 * LOA ENGINE - VOCABULARIO CLÍNICO CANÓNICO (FUENTE ÚNICA DE VERDAD)
 * ==============================================================================
 * PROBLEMA QUE RESUELVE:
 * El mismo padecimiento circulaba con DOS nombres distintos según el módulo:
 *   - `nlp_symptom_engine.js` (texto del chat)   -> 'Potencia'
 *   - `vtiger_sync_agent.js` (cf_2610 de vTiger) -> 'Tetosterona'
 * Como `LearningBrain.learnFromVtigerSale()` sólo acepta nombres canónicos,
 * TODA venta de testosterona que entraba por el agente inverso se descartaba
 * en silencio (0 registros entrenados, sin log de error).
 *
 * REGLA: aquí se declara el nombre canónico y sus alias. Ningún módulo debe
 * volver a inventar comparaciones `includes('...')` para identificar dolencias.
 * ==============================================================================
 */

/**
 * @typedef {'Artritis'|'Diabetes'|'Prostata'|'Potencia'|'Colageno'|'Vision'|'Gastro'|'Hongos'|'Gummies'} CanonicalTreatment
 */

/**
 * Catálogo oficial. `canonical` es la clave interna (la que aprende el cerebro);
 * `vtigerLabel` es cómo lo nombra el negocio en vTiger (`cf_2610`).
 */
export const TREATMENT_CATALOG = [
  { canonical: 'Artritis', vtigerLabel: 'Artritis', tags: ['producto-artritis'] },
  { canonical: 'Diabetes', vtigerLabel: 'Diabetes', tags: ['producto-diabetes'] },
  { canonical: 'Prostata', vtigerLabel: 'Prostata', tags: ['producto-prostata'] },
  { canonical: 'Potencia', vtigerLabel: 'Tetosterona', tags: ['producto-potencia', 'producto-tetosterona'] },
  { canonical: 'Colageno', vtigerLabel: 'Colageno', tags: ['producto-colageno'] },
  { canonical: 'Vision', vtigerLabel: 'Vision', tags: ['producto-vision'] },
  { canonical: 'Gastro', vtigerLabel: 'Gastro', tags: ['producto-gastro'] },
  { canonical: 'Hongos', vtigerLabel: 'Hongos', tags: ['producto-hongos'] },
  { canonical: 'Gummies', vtigerLabel: 'Gummies', tags: ['producto-gummies'] }
];

/**
 * Nota de diseño: `Desconocido` NO está en el catálogo a propósito. Es el estado
 * de TRIAGE (ausencia declarada de clasificación), no un producto comercial, y
 * el Cerebro no debe aprenderlo. Se resuelve vía `TREATMENT_ALIASES`.
 */

/**
 * [TRIAGE] Estado explícito para un lead SIN identificación posible.
 *
 * REGLA DE NEGOCIO (ticket de ingeniería - falso positivo del radar de entrada):
 * si un lead entra SIN Ad ID y SIN palabras clave de dolencia identificables en
 * su primer mensaje, NO se le atribuye un producto. Antes existía un fallback
 * silencioso que lo marcaba con un producto y un proveedor que no correspondían,
 * ensuciando las métricas de pauta y el Audit Engine.
 *
 * `Desconocido` NO es una dolencia comercial: es la ausencia declarada de
 * clasificación. No participa del aprendizaje del Cerebro.
 */
export const UNKNOWN_TREATMENT = 'Desconocido';

/** Etiqueta de triage, separada de las etiquetas de producto real. */
export const TRIAGE_TAG = 'producto-desconocido';

/** ¿El valor corresponde a un producto comercial real (excluye triage)? */
export function isRealTreatment(value) {
  const canonical = normalizeTreatment(value);
  return Boolean(canonical) && canonical !== UNKNOWN_TREATMENT;
}

/**
 * Igual que `normalizeTreatment` pero con fallback explícito de triage.
 * Úsalo cuando el llamante necesite SIEMPRE un valor y no pueda recibir null.
 */
export function normalizeTreatmentOrUnknown(raw, fallback = UNKNOWN_TREATMENT) {
  return normalizeTreatment(raw) || fallback;
}

/** Tratamientos canónicos que el LearningBrain puede aprender. */
export const CANONICAL_TREATMENTS = TREATMENT_CATALOG.map(t => t.canonical);

/**
 * Alias aceptados -> nombre canónico. Incluye variantes de vTiger, del nombre
 * comercial y errores de tipeo frecuentes en campañas.
 * @type {Record<string, CanonicalTreatment>}
 */
export const TREATMENT_ALIASES = {
  // Artritis
  'artritis': 'Artritis', 'artrosis': 'Artritis', 'articulaciones': 'Artritis',
  'articulacion': 'Artritis', 'reuma': 'Artritis', 'reumatismo': 'Artritis',
  'rodilla': 'Artritis', 'rodillas': 'Artritis', 'cartilago': 'Artritis',
  // Diabetes
  'diabetes': 'Diabetes', 'diabet': 'Diabetes', 'glucosa': 'Diabetes', 'azucar': 'Diabetes',
  'nopal': 'Diabetes', 'nopal plus': 'Diabetes', 'insulina': 'Diabetes',
  // Prostata
  'prostata': 'Prostata', 'prostatico': 'Prostata',
  // Potencia (el caso crítico: vTiger la llama Tetosterona)
  'potencia': 'Potencia', 'tetosterona': 'Potencia', 'testosterona': 'Potencia',
  'vigor': 'Potencia', 'sexual': 'Potencia', 'libido': 'Potencia',
  'energia masculina': 'Potencia', 'poder interior': 'Potencia', 'texto men': 'Potencia',
  'ereccion': 'Potencia', 'disfuncion': 'Potencia',
  // Colageno
  'colageno': 'Colageno', 'colagen': 'Colageno', 'collagen': 'Colageno',
  'bio collagen': 'Colageno', 'piel': 'Colageno', 'arrugas': 'Colageno',
  // Vision
  'vision': 'Vision', 'vista': 'Vision', 'ojos': 'Vision', 'catarata': 'Vision',
  // Gastro
  'gastro': 'Gastro', 'gastritis': 'Gastro', 'colon': 'Gastro', 'estomago': 'Gastro',
  'reflujo': 'Gastro', 'acidez': 'Gastro', 'digestion': 'Gastro',
  // Hongos
  'hongos': 'Hongos', 'hongo': 'Hongos', 'onicomicosis': 'Hongos', 'pie de atleta': 'Hongos',
  // Gummies
  'gummies': 'Gummies', 'gummy': 'Gummies', 'gomitas': 'Gummies', 'gomita': 'Gummies',
  'gomas': 'Gummies', 'vitaminas': 'Gummies', 'suplemento': 'Gummies',
  // Triage (ausencia declarada de clasificación)
  'desconocido': 'Desconocido', 'desconocida': 'Desconocido', 'sin clasificar': 'Desconocido',
  'unclassified': 'Desconocido', 'general': 'Desconocido'
};

/**
 * Todas las etiquetas de producto válidas (incluye alias legados como
 * `producto-tetosterona`, que ya existen en contactos reales de GHL).
 */
export const PRODUCT_TAGS = TREATMENT_CATALOG.flatMap(t => t.tags);

/**
 * Normaliza CUALQUIER etiqueta de tratamiento a su nombre canónico.
 * Tolerante por diseño: recibe el valor crudo de vTiger (`cf_2610`), una etiqueta
 * de GHL (`producto-x`), o un nombre del NLP, y devuelve el canónico o `null`.
 *
 * @param {string} raw
 * @returns {CanonicalTreatment|null}
 */
export function normalizeTreatment(raw) {
  if (!raw || typeof raw !== 'string') return null;

  const clean = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes: 'Colágeno' -> 'colageno'
    .replace(/^producto[-_\s]*/, '') // quita el prefijo de etiqueta GHL
    .trim();

  if (!clean) return null;

  // 1. [PRECEDENCIA DE FORMATO] "Gummies/Gomitas" es una FORMA FARMACÉUTICA, no
  //    una dolencia. Un texto como "gomitas de colágeno y biotina" contiene el
  //    síntoma 'colageno', pero el producto real es Gummies: sin esta regla el
  //    motor clasificaba campañas de gomitas como Colágeno.
  if (/\b(gumm(?:y|ies)|gomit(?:a|as)|gomas)\b/.test(clean)) return 'Gummies';

  // 2. Coincidencia exacta con el catálogo canónico
  const directCanonical = CANONICAL_TREATMENTS.find(t => t.toLowerCase() === clean);
  if (directCanonical) return directCanonical;

  // 3. Coincidencia exacta con un alias
  if (TREATMENT_ALIASES[clean]) return TREATMENT_ALIASES[clean];

  // 4. Coincidencia por PALABRA COMPLETA (el texto libre de vTiger puede traer
  //    ruido: "TETOSTERONA - IN HOUSE", "ARTRITIS - ERNESTO - 2pm a 9pm").
  //
  //    IMPORTANTE: antes se usaba `clean.includes(alias)` (subcadena). Eso hacía
  //    que 'ProductoDesconocidoXYZ' coincidiera con el alias 'desconocido' y se
  //    clasificara como dolencia válida: el mismo patrón de falso positivo por
  //    subcadena que causó el incidente del OTP. El match ahora exige límites de
  //    palabra y un mínimo de longitud para no capturar ruido.
  for (const [alias, canonical] of Object.entries(TREATMENT_ALIASES)) {
    if (alias.length < 4) continue;
    const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Se admite el plural regular (-s / -es): "cataratas" debe resolver a Vision.
    const rx = new RegExp(`(^|[^a-z0-9])${esc}(s|es)?([^a-z0-9]|$)`);
    if (rx.test(clean)) return canonical;
  }

  return null;
}

/**
 * Etiqueta de producto canónica para un tratamiento (la que espera el pipeline).
 * @param {string} raw
 * @returns {string|null} ej. 'producto-potencia'
 */
export function toProductTag(raw) {
  const canonical = normalizeTreatment(raw);
  return canonical ? `producto-${canonical.toLowerCase()}` : null;
}

/**
 * ¿La etiqueta es una etiqueta de producto conocida (canónica o legada)?
 * Se usa para purgar en lugar de acumular productos contradictorios.
 */
export function isProductTag(tag) {
  return typeof tag === 'string' && PRODUCT_TAGS.includes(tag.toLowerCase());
}

/**
 * Filtra la lista de etiquetas dejando solo la del tratamiento ganador.
 * @param {string[]} tags etiquetas actuales del contacto
 * @param {string} rawTreatment tratamiento detectado (cualquier formato)
 * @returns {{ tags: string[], activeTag: string|null, removed: string[] }}
 */
export function reconcileProductTags(tags = [], rawTreatment = '') {
  const activeTag = toProductTag(rawTreatment);
  const removed = [];
  const result = [];

  for (const tag of tags) {
    const lower = String(tag).toLowerCase();
    if (isProductTag(lower)) {
      if (activeTag && lower === activeTag) {
        result.push(tag);
      } else {
        removed.push(tag);
      }
    } else {
      result.push(tag);
    }
  }

  if (activeTag && !result.includes(activeTag)) {
    result.push(activeTag);
  }

  return { tags: result, activeTag, removed };
}
