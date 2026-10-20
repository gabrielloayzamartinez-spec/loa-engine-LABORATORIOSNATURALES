/**
 * ==============================================================================
 * MATRIZ DE PÁGINAS — FUENTE ÚNICA DE VERDAD DE FACEBOOK PAGE IDS
 * ==============================================================================
 * PROBLEMA QUE RESUELVE (auditoría 16/10):
 * Los 10 page IDs estaban hardcodeados en 5 archivos (config/index.js,
 * config/sedes_gateway.js, chat_router_agent.js, nlp_symptom_engine.js y
 * owner_guardian.js). Un cambio en un archivo no se propagaba y la asignación
 * de dueño/proveedor/sede se desincronizaba en silencio.
 *
 * REGLA: todo módulo que necesite resolver pageId -> { sede, proveedor, dueño }
 * debe leer de AQUÍ y de ningún otro sitio.
 * ==============================================================================
 */

/**
 * @typedef {Object} PageEntry
 * @property {string} sede      PALACIOS | BENAVIDES | ROOSEVELT | PIURA
 * @property {string} proveedor ERNESTO | CLICK2RING | IN_HOUSE | REDES 2 BENAVIDES
 * @property {string} ownerKey  clave del usuario en SEDES_GATEWAY[sede].users
 * @property {string} pageName  nombre de la fanpage
 * @property {string} [canal]   canal si NO es FB-MSGR (ej. 'WSP')
 */

/** @type {Record<string, PageEntry>} */
export const PAGE_MATRIX = {
  // ── PALACIOS ──────────────────────────────────────────────
  '566501466542620': { sede: 'PALACIOS', proveedor: 'ERNESTO', ownerKey: 'ernesto', pageName: 'Naturales BioNatural' },
  // 19/10: SOLO acciones IN-HOUSE. Esta página gestiona WSP ADS (WhatsApp, sin dueño)
  // y FORMS ADS (formularios, sin dueño). El número se sincroniza con vTiger pero
  // NUNCA se asigna dueño de REDES (trabajo ordenado, sin mezclarse con ERNESTO).
  '718150351371765': { sede: 'PALACIOS', proveedor: 'IN_HOUSE', ownerKey: null, sinDueno: true, pageName: 'Laboratorios Naturales BIO' },
  '111906554968800': { sede: 'PALACIOS', proveedor: 'CLICK2RING', ownerKey: 'ultra', pageName: 'BioNatural - Ultra' },
  // ── BENAVIDES ─────────────────────────────────────────────
  '510617778807469': { sede: 'BENAVIDES', proveedor: 'ERNESTO', ownerKey: 'redes1', pageName: 'Naturales Bio Corp' },
  '126154270581792': { sede: 'BENAVIDES', proveedor: 'CLICK2RING', ownerKey: 'redes2', pageName: 'Bio Natural' },
  '1147742788423762': { sede: 'BENAVIDES', proveedor: 'REDES 2 BENAVIDES', ownerKey: 'redes2', pageName: 'BioNatural Fuerza' },
  // ── ROOSEVELT ─────────────────────────────────────────────
  '568453466348355': { sede: 'ROOSEVELT', proveedor: 'IN_HOUSE', ownerKey: 'redes', pageName: 'Bio Naturales' },
  '1075001465705985': { sede: 'ROOSEVELT', proveedor: 'IN_HOUSE', ownerKey: 'redes', pageName: 'BioNatural Plus' },
  // ── PIURA ─────────────────────────────────────────────────
  '1147257965133802': { sede: 'PIURA', proveedor: 'IN_HOUSE', ownerKey: 'redes', pageName: 'Natural Bio' },
  '1057863707412893': { sede: 'PIURA', proveedor: 'IN_HOUSE', ownerKey: 'redes', pageName: 'BioNatural' }
};

/** Entrada completa de la matriz para un page id. */
export function getPageMatrixEntry(pageId) {
  return PAGE_MATRIX[String(pageId || '').trim()] || null;
}

/** Sede oficial de un page id (null si no está mapeado). */
export function getSedeByPageId(pageId) {
  return getPageMatrixEntry(pageId)?.sede || null;
}

/** Proveedor publicitario de un page id (null si no está mapeado). */
export function getProveedorByPageId(pageId) {
  return getPageMatrixEntry(pageId)?.proveedor || null;
}

/** ownerKey (clave en SEDES_GATEWAY.users) de un page id. */
export function getOwnerKeyByPageId(pageId) {
  return getPageMatrixEntry(pageId)?.ownerKey || null;
}

/** Lista plana de todos los page ids registrados. */
export function getAllPageIds() {
  return Object.keys(PAGE_MATRIX);
}

/**
 * Determina la etiqueta de cola (Smart View) correspondiente a una fanpage:
 * - 'cola-redes-1': Asignada a Ernesto o Redes 1
 * - 'cola-redes-2': Asignada a Click2Ring / Ultra o Redes 2
 * - 'cola-forms': Formularios Lead Ads (Laboratorios Naturales BIO 718150351371765)
 * - 'cola-inhouse': Operación In-House
 */
export function getQueueTagByPageId(pageId) {
  const entry = getPageMatrixEntry(pageId);
  if (!entry) return 'cola-general';

  if (entry.sinDueno || String(pageId).trim() === '718150351371765') {
    return 'cola-forms';
  }

  const prov = String(entry.proveedor || '').toUpperCase();
  const owner = String(entry.ownerKey || '').toLowerCase();

  if (prov === 'ERNESTO' || owner === 'ernesto' || owner === 'redes1') {
    return 'cola-redes-1';
  }
  if (prov === 'CLICK2RING' || prov === 'REDES 2 BENAVIDES' || owner === 'ultra' || owner === 'redes2' || owner === 'click2ring') {
    return 'cola-redes-2';
  }
  if (prov === 'IN_HOUSE') {
    return 'cola-inhouse';
  }
  return 'cola-redes-1';
}

/**
 * Obtiene el conjunto de etiquetas estratégicas para Vistas Inteligentes
 * por página (Sede + Cola + Proveedor).
 */
export function getSmartViewTagsByPageId(pageId) {
  const entry = getPageMatrixEntry(pageId);
  if (!entry) return [];

  const tags = [];
  // Etiqueta de Sede
  const sedeSlug = `sede-${String(entry.sede).toLowerCase()}`;
  tags.push(sedeSlug);

  // Etiqueta de Cola Operativa (Smart View)
  const colaTag = getQueueTagByPageId(pageId);
  tags.push(colaTag);

  return tags;
}
