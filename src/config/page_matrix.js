/**
 * ==============================================================================
 * MATRIZ DE PÁGINAS — FUENTE ÚNICA DE VERDAD DE FACEBOOK PAGE IDS
 * ==============================================================================
 * [SIMPLIFICACIÓN 27/11 — "UNA SOLA COLUMNA"]
 * El negocio trabaja con UNA dimensión: el PROVEEDOR. Antes la matriz tenía dos
 * columnas que se contradecían (`proveedor` y `ownerKey`/`sinDueno`), y eso producía
 * casos donde el proveedor era EN CASA G pero el dueño figuraba como REDES.
 *
 * REGLA NUEVA: se declara SOLO el proveedor; el DUEÑO se DERIVA de él.
 *   proveedor: 'ERNESTO'   → dueño: ERNESTO
 *   proveedor: 'IN_HOUSE'  → dueño: IN_HOUSE
 *   proveedor: 'CLICK2RING'→ dueño: CLICK2RING
 *   proveedor: 'EN CASA G' → dueño: EN CASA G
 * Ya no existe `sinDueno` ni `ownerKey` como dato independiente.
 * ==============================================================================
 */

/**
 * @typedef {Object} PageEntry
 * @property {string} sede      PALACIOS | BENAVIDES | ROOSEVELT | PIURA
 * @property {string} proveedor ERNESTO | CLICK2RING | IN_HOUSE | EN CASA G | ENZO | UP IDEAS | REDES 2 BENAVIDES
 * @property {string} pageName  nombre de la fanpage
 * @property {string} [canal]   canal si NO es FB-MSGR (ej. 'WSP')
 */

/** @type {Record<string, PageEntry>} */
export const PAGE_MATRIX = {
  // [INICIATIVAS — 27/11] Cada página corre UNA sola iniciativa. El `canal` se
  // declara aquí porque los leads de FORMULARIO no tienen conversación: sin este
  // dato, el router no puede saber de qué página vienen (ni marcar la iniciativa).
  // Medido en vivo sobre el CF "Canal Captación" de contactos reales:
  //   Palacios  · Naturales BioNatural      → FB-MSGR
  //   Palacios  · Laboratorios Naturales BIO→ FORM
  //   Palacios  · BioNatural Salud          → FORM
  //   Benavides · Naturales Bio Corp        → FB-MSGR
  //   Benavides · Bio Natural               → FB-MSGR
  //   Benavides · BioNatural Fuerza         → FORM
  // Las páginas sin medición quedan sin `canal` (se resuelve por el mensaje).
  // ── PALACIOS ──────────────────────────────────────────────
  '566501466542620': { sede: 'PALACIOS', proveedor: 'ERNESTO', canal: 'FB-MSGR', pageName: 'Naturales BioNatural' },
  '718150351371765': { sede: 'PALACIOS', proveedor: 'IN_HOUSE', canal: 'FORM', pageName: 'Laboratorios Naturales BIO' },
  '111906554968800': { sede: 'PALACIOS', proveedor: 'CLICK2RING', pageName: 'BioNatural - Ultra' },
  '1087387677802467': { sede: 'PALACIOS', proveedor: 'IN_HOUSE', canal: 'FORM', pageName: 'BIO Vida Natural' },
  '1422379957628845': { sede: 'PALACIOS', proveedor: 'EN CASA G', pageName: 'BioHealth Natural' },
  '1438600545996758': { sede: 'PALACIOS', proveedor: 'IN_HOUSE', canal: 'FORM', pageName: 'BioNatural Salud' },
  // ── BENAVIDES ─────────────────────────────────────────────
  '510617778807469': { sede: 'BENAVIDES', proveedor: 'ERNESTO', canal: 'FB-MSGR', pageName: 'Naturales Bio Corp' },
  '126154270581792': { sede: 'BENAVIDES', proveedor: 'CLICK2RING', canal: 'FB-MSGR', pageName: 'Bio Natural' },
  '1147742788423762': { sede: 'BENAVIDES', proveedor: 'IN_HOUSE', canal: 'FORM', pageName: 'BioNatural Fuerza' },
  '1397629783430897': { sede: 'BENAVIDES', proveedor: 'IN_HOUSE', pageName: 'BioNatural Testosterona' },
  '1223518870833689': { sede: 'BENAVIDES', proveedor: 'IN_HOUSE', pageName: 'BioNatural Diabetes' },
  // ── ROOSEVELT ─────────────────────────────────────────────
  '568453466348355': { sede: 'ROOSEVELT', proveedor: 'IN_HOUSE', canal: 'FB-MSGR', pageName: 'Bio Naturales' },
  '1075001465705985': { sede: 'ROOSEVELT', proveedor: 'IN_HOUSE', pageName: 'BioNatural Plus' },
  '180536758476362': { sede: 'ROOSEVELT', proveedor: 'IN_HOUSE', pageName: 'Bio Natural Salud' },
  // ── PIURA ─────────────────────────────────────────────────
  '1147257965133802': { sede: 'PIURA', proveedor: 'IN_HOUSE', pageName: 'Natural Bio' },
  '1057863707412893': { sede: 'PIURA', proveedor: 'IN_HOUSE', pageName: 'BioNatural' },
  '1366688306523831': { sede: 'PIURA', proveedor: 'IN_HOUSE', pageName: 'BioNatural Piura Inhouse' }
};

/** Convierte 'EN CASA G' → 'en-casa-g' (slug estable). */
export function slugificar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Entrada completa de la matriz para un page id (con dueño derivado). */
export function getPageMatrixEntry(pageId) {
  const e = PAGE_MATRIX[String(pageId || '').trim()];
  if (!e) return null;
  // El dueño ES el proveedor. Se expone como propiedad derivada para que los
  // módulos que ya leían `ownerKey`/`ownerName` sigan funcionando sin cambios.
  return { ...e, ownerKey: slugificar(e.proveedor), ownerName: e.proveedor };
}

/** Sede oficial de un page id (null si no está mapeado). */
export function getSedeByPageId(pageId) {
  return getPageMatrixEntry(pageId)?.sede || null;
}

/** Proveedor publicitario de un page id (null si no está mapeado). */
export function getProveedorByPageId(pageId) {
  return getPageMatrixEntry(pageId)?.proveedor || null;
}

/**
 * Etiqueta de PROVEEDOR (factor de Smart View) para una fanpage.
 * Formato `prov-<slug>`: 'prov-ernesto', 'prov-in-house', 'prov-click2ring', etc.
 * Necesaria para separar vistas por proveedor cuando varias iniciativas comparten
 * canal (p. ej. formularios de ERNESTO vs formularios IN_HOUSE, ambos 'cola-forms').
 */
export function getProveedorTagByPageId(pageId) {
  const prov = getProveedorByPageId(pageId);
  if (!prov) return null;
  const slug = String(prov)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quita tildes
    .replace(/[^a-z0-9]+/g, '-')       // separadores -> guiones
    .replace(/^-+|-+$/g, '');          // recorta guiones en bordes
  return slug ? `prov-${slug}` : null;
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
 * - 'cola-forms': Formularios Lead Ads (los formularios van a Cola Forms por ser AutoForm)
 * - 'cola-inhouse': Operación In-House
 */
export function getQueueTagByPageId(pageId) {
  const entry = getPageMatrixEntry(pageId);
  if (!entry) return 'cola-general';

  // [SIMPLIFICACIÓN 27/11] La cola se decide SOLO por proveedor: el dueño es el
  // proveedor. Se eliminó el caso especial por ID y el campo `sinDueno`.
  const prov = String(entry.proveedor || '').toUpperCase();

  if (prov === 'ERNESTO') return 'cola-redes-1';
  if (prov === 'CLICK2RING' || prov === 'REDES 2 BENAVIDES') return 'cola-redes-2';
  if (prov === 'IN_HOUSE' || prov === 'EN CASA G' || prov === 'ENZO' || prov === 'UP IDEAS') return 'cola-inhouse';
  return 'cola-general';
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

  // Etiqueta de PROVEEDOR (separada del canal: dimensión limpia e independiente).
  const provTag = getProveedorTagByPageId(pageId);
  if (provTag) tags.push(provTag);

  return tags;
}
