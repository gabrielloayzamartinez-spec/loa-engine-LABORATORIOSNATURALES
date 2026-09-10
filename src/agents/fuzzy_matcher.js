/**
 * 🔍 Fuzzy Matcher & Algoritmo de Deduplicación Contextual
 * 
 * Implementa:
 * 1. Distancia de Levenshtein normalizada (Similitud 0.0 a 1.0).
 * 2. Normalización fonética y de nombres compuestos (eliminación de títulos, tildes, signos).
 * 3. Validación contextual cruzada (Nombre >= 90% Y coincidencia de Ciudad/Estado o Condición Médica).
 */

import { normalizeText } from './nlp_symptom_engine.js';

/**
 * Calcula la distancia de Levenshtein entre dos cadenas
 */
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // sustitución
          matrix[i][j - 1] + 1,     // inserción
          matrix[i - 1][j] + 1      // eliminación
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calcula el índice de similitud (0.0 a 1.0)
 */
export function calculateSimilarity(str1, str2) {
  const s1 = normalizeText(str1);
  const s2 = normalizeText(str2);

  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  // Si uno de los nombres contiene al otro de forma completa
  if (s1.includes(s2) || s2.includes(s1)) {
    const minLen = Math.min(s1.length, s2.length);
    const maxLen = Math.max(s1.length, s2.length);
    if (minLen / maxLen >= 0.75) return 0.95;
  }

  const distance = levenshteinDistance(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);
  return 1 - (distance / maxLength);
}

/**
 * Evalúa si dos contactos representan la misma persona con validación contextual
 * 
 * @param {Object} contactA - Contacto base
 * @param {Object} contactB - Contacto a comparar
 * @param {number} threshold - Umbral de similitud (Default 0.90)
 */
export function isContextualDuplicate(contactA, contactB, threshold = 0.90) {
  // 1. Si ambos tienen teléfono, el teléfono US (10 dígitos) es la clave primaria inequívoca
  const phoneA = (contactA.phone || '').replace(/\D/g, '');
  const phoneB = (contactB.phone || '').replace(/\D/g, '');
  if (phoneA.length >= 10 && phoneB.length >= 10) {
    return phoneA.slice(-10) === phoneB.slice(-10);
  }

  // 2. Si no hay teléfono común, evaluar similitud de Nombre Completo
  const nameA = `${contactA.firstName || ''} ${contactA.lastName || ''}`.trim() || contactA.contactName || '';
  const nameB = `${contactB.firstName || ''} ${contactB.lastName || ''}`.trim() || contactB.contactName || '';

  const sim = calculateSimilarity(nameA, nameB);
  if (sim < threshold) return false;

  // 3. Validación Contextual Cruzada Estricta (Anti-Falsos Homónimos)
  // Sin teléfono común, NUNCA asumir duplicado solo por coincidencia de nombre
  const emailA = normalizeText(contactA.email || '');
  const emailB = normalizeText(contactB.email || '');
  if (emailA && emailB && emailA === emailB) return true;

  // Coincidencia estricta de Estado o Ciudad
  const stateA = normalizeText(contactA.state || '');
  const stateB = normalizeText(contactB.state || '');
  const cityA = normalizeText(contactA.city || '');
  const cityB = normalizeText(contactB.city || '');

  const hasLocationMatch = (stateA && stateB && stateA === stateB) || 
                           (cityA && cityB && cityA === cityB);

  // Coincidencia de Condición o Tratamiento en Tags
  const tagsA = (contactA.tags || []).map(t => normalizeText(t));
  const tagsB = (contactB.tags || []).map(t => normalizeText(t));
  const hasConditionMatch = tagsA.some(t => t.startsWith('producto-') && tagsB.includes(t));

  // Solo es duplicado si tiene similitud de nombre Y coincidencia geográfica o de condición específica
  return sim >= 0.90 && (hasLocationMatch || (hasConditionMatch && (stateA || cityA)));
}
