/**
 * ==============================================================================
 * CONTRATO ÚNICO DE ETIQUETAS DE GHL — FUENTE DE VERDAD PARA N1 Y N2
 * ==============================================================================
 * [DECISIÓN DEL NEGOCIO — 27/11/2026]
 * El equipo de redes trabaja con DOS dimensiones y nada más:
 *
 *     prov-<proveedor>     ·     pagina-<nombre-de-pagina>
 *
 * Todo lo demás que el sistema venía escribiendo es RUIDO y se elimina:
 *   cola-* · canal-* · sede-* · producto-* · revisar-ruteo · vtiger* ·
 *   facebook-messenger · meta-ads · sin-telefono · no-compro · lead-caliente …
 *
 * MOTIVO: las etiquetas se construían en CINCO lugares con vocabularios distintos.
 * Medido en producción: 8 contactos con `canal-forms` + `canal-form` a la vez, 11 con
 * `canal-messenger` + `canal-fb-msgr`, 294 con `vtiger` + `vtiger-sincronizado`, y
 * vistas de chat que parpadeaban porque cada proceso escribía su propia variante.
 *
 * REGLA: solo `prov-*` y `pagina-*` (una de cada una). El resto se retira.
 * ==============================================================================
 */

import { toProductTag, isProductTag } from './clinical_vocabulary.js';

/**
 * Etiquetas de estado comercial. [DEPURACIÓN 27/11] YA NO SE ESCRIBEN NI SE
 * CONSERVAN: el estado vive en el custom field "Estado de Compra". Se mantiene el
 * catálogo solo para que los módulos antiguos que las referencian no rompan
 * (antes, al quitarlas, quedaban en `undefined` y escribían la etiqueta "undefined").
 */
export const TAGS_ESTADO = {
  CLIENTE: 'cliente-vtiger',
  PROSPECTO: 'prospecto-vtiger',
  COMPRO: 'compro',
  NO_COMPRO: 'no-compro',
  CONVERTIDO: 'convertido',
  CON_TELEFONO: 'con-telefono',
  SIN_TELEFONO: 'sin-telefono',
  CLIENTE_COMPRADOR: 'cliente-comprador',
  VENTA_CERRADA: 'venta-cerrada'
};

/** Etiquetas de estado que el CONTRATO ya NO conserva (se depuran). */
export const ESTADO_DEPURADO = new Set(Object.values(TAGS_ESTADO));

/**
 * [ETIQUETAS PROTEGIDAS — 27/11] NO son del contrato de vistas, pero el CÓDIGO las
 * escribe y las lee: si se borran, se rompen flujos reales.
 *   · alerta-duplicado-clic / alerta-duplicado-crm → los pone el router al detectar
 *     doble clic de pauta; master_processor los consulta.
 *   · doble-ingreso-publicitario / alerta-reingreso-pauta → ad_attribution_engine,
 *     master_processor e historial_healer los usan para decidir reingresos.
 *   · ia-jimena-atendiendo / workflow1-rescate-redes → los usa el workflow de GHL.
 * Se pueden ampliar por entorno con GHL_TAGS_PROTEGIDAS=a,b,c
 */
const PROTEGIDAS_POR_DEFECTO = [
  'alerta-duplicado-clic',
  'alerta-duplicado-crm',
  'doble-ingreso-publicitario',
  'alerta-reingreso-pauta',
  'ia-jimena-atendiendo',
  'workflow1-rescate-redes'
];

export const TAGS_PROTEGIDAS = new Set([
  ...PROTEGIDAS_POR_DEFECTO,
  ...String(process.env.GHL_TAGS_PROTEGIDAS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
]);

/**
 * ¿Esta etiqueta pertenece al contrato (se conserva) o es basura (se retira)?
 * @param {string} tag
 * @returns {boolean}
 */
export function esEtiquetaDelContrato(tag) {
  const t = String(tag || '').trim().toLowerCase();
  if (!t) return false;
  if (/^prov-[a-z0-9-]+$/.test(t)) return true;
  if (/^pagina-[a-z0-9-]+$/.test(t)) return true;
  // Marcadores operativos que usa el propio motor.
  if (TAGS_PROTEGIDAS.has(t)) return true;
  return false;
}

/** Compatibilidad: todo lo que NO es del contrato es ruido. */
export function esEtiquetaRuido(tag) {
  const t = String(tag || '').trim().toLowerCase();
  if (!t) return false;
  return !esEtiquetaDelContrato(t);
}

/** Etiqueta de página: `pagina-<slug>`. */
export function etiquetaPagina(nombrePagina) {
  const slug = String(nombrePagina || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `pagina-${slug}` : null;
}

/**
 * Canales válidos. Es la lista cerrada que usan las Smart Views de chat.
 * Cualquier valor fuera de esta lista es LEGADO y debe normalizarse o retirarse.
 */
export const CANALES_VALIDOS = [
  'canal-messenger',
  'canal-forms',
  'canal-whatsapp',
  'canal-sms',
  'canal-tiktok',
  'canal-instagram'
];

/** Vocabulario CRUDO de vTiger (cf_3507) y de Meta -> etiqueta canónica. */
const CANAL_POR_VTIGER = {
  'FB-MSGR': 'canal-messenger',
  'FB-MESSENGER': 'canal-messenger',
  'MESSENGER': 'canal-messenger',
  'MSGR': 'canal-messenger',
  'FORM': 'canal-forms',
  'FORMS': 'canal-forms',
  'FORMULARIO': 'canal-forms',
  'WHATSAPP': 'canal-whatsapp',
  'WSP': 'canal-whatsapp',
  'WHATS': 'canal-whatsapp',
  'SMS': 'canal-sms',
  'TIKTOK': 'canal-tiktok',
  'INSTAGRAM': 'canal-instagram',
  'IG': 'canal-instagram'
};

/** Transporte del mensaje de GHL/Meta -> etiqueta canónica. */
const CANAL_POR_TRANSPORTE = {
  'messenger': 'canal-messenger',
  'facebook': 'canal-messenger',
  'facebook-messenger': 'canal-messenger',
  'instagram': 'canal-instagram',
  'ig': 'canal-instagram',
  'whatsapp': 'canal-whatsapp',
  'wsp': 'canal-whatsapp',
  'sms': 'canal-sms',
  'tiktok': 'canal-tiktok',
  'form': 'canal-forms',
  'forms': 'canal-forms'
};

/** Etiquetas canónicas de proveedor (page_matrix.proveedor -> tag). */
const PROVEEDOR_TAG = {
  'ERNESTO': 'prov-ernesto',
  'CLICK2RING': 'prov-click2ring',
  'IN_HOUSE': 'prov-in-house',
  'INHOUSE': 'prov-in-house',
  'REDES 2 BENAVIDES': 'prov-redes-2-benavides',
  'REDES2': 'prov-redes-2-benavides',
  'EN CASA G': 'prov-en-casa-g',
  'ENZO': 'prov-enzo',
  'UP_IDEAS': 'prov-up-ideas',
  'UP IDEAS': 'prov-up-ideas'
};

/** Sedes válidas (el slug de la etiqueta es `sede-<minusculas>`). */
export const SEDES_VALIDAS = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];

/**
 * Etiquetas de RUIDO: TODO lo que no es del contrato se retira.
 * La definición vive arriba (`esEtiquetaRuido`); esta nota queda como referencia
 * de lo que históricamente se generó y hoy se purga:
 *   cola-* · canal-* · sede-* · producto-* · revisar-ruteo · vtiger* ·
 *   facebook-messenger · meta-ads · sin-telefono · no-compro · lead-caliente …
 */

/**
 * Normaliza un canal CRUDO (cf_3507 de vTiger o transporte de Meta) a la etiqueta
 * canónica. Devuelve `null` si el valor no pertenece a ningún canal conocido:
 * preferimos NO etiquetar antes que inventar `canal-<basura>`.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function etiquetaCanal(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (CANALES_VALIDOS.includes(v.toLowerCase())) return v.toLowerCase();
  const up = v.toUpperCase().replace(/\s+/g, ' ').trim();
  if (CANAL_POR_VTIGER[up]) return CANAL_POR_VTIGER[up];
  const low = v.toLowerCase().replace(/^canal[-_]/, '').replace(/_/g, '-').trim();
  if (CANAL_POR_TRANSPORTE[low]) return CANAL_POR_TRANSPORTE[low];
  const norm = low.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (CANAL_POR_TRANSPORTE[norm]) return CANAL_POR_TRANSPORTE[norm];
  return null;
}

/**
 * Normaliza un proveedor CRUDO a `prov-<slug>` canónico.
 * @param {string} raw
 * @returns {string|null}
 */
export function etiquetaProveedor(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  const up = v.toUpperCase().replace(/\s+/g, ' ').trim();
  if (PROVEEDOR_TAG[up]) return PROVEEDOR_TAG[up];
  const slug = v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^prov[-_]/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `prov-${slug}` : null;
}

/**
 * Etiqueta de sede. Devuelve `null` para una sede desconocida (nunca inventa).
 * @param {string} sede
 * @returns {string|null}
 */
export function etiquetaSede(sede) {
  const s = String(sede || '').toUpperCase().trim();
  return SEDES_VALIDAS.includes(s) ? `sede-${s.toLowerCase()}` : null;
}

/**
 * Etiqueta de producto. Delega en el vocabulario clínico canónico (incluye la
 * etiqueta de triage `producto-desconocido` para tratamientos no clasificados).
 * @param {string} tratamiento
 * @returns {string|null}
 */
export function etiquetaProducto(tratamiento) {
  if (!tratamiento) return null;
  return toProductTag(tratamiento) || null;
}

/** Etiqueta canónica -> vocabulario CRUDO que usa vTiger en `cf_3507`. */
const VTIGER_POR_CANAL = {
  'canal-messenger': 'FB-MSGR',
  'canal-forms': 'FORM',
  'canal-whatsapp': 'WHATSAPP',
  'canal-sms': 'SMS',
  'canal-tiktok': 'TIKTOK',
  'canal-instagram': 'INSTAGRAM'
};

/**
 * Inverso de `etiquetaCanal`: de la etiqueta canónica al valor CRUDO de vTiger.
 *
 * POR QUÉ: el Nivel 1 conocía el canal (por el transporte del mensaje) pero NO
 * escribía el custom field "Canal Captación" (sólo `Origen Lead` compuesto). Así
 * los leads de Meta quedaban sin el CF que el Nivel 2 sí llena desde `cf_3507`, y
 * la auditoría de contrato medía 0% de cobertura en esa dimensión.
 *
 * @param {string} tagOrigen etiqueta canónica o valor crudo
 * @returns {string|null} 'FB-MSGR' | 'FORM' | 'WHATSAPP' | 'SMS' | 'TIKTOK' | 'INSTAGRAM'
 */
export function canalVtigerDesdeTag(tagOrigen) {
  const canon = etiquetaCanal(tagOrigen);
  return canon ? (VTIGER_POR_CANAL[canon] || null) : null;
}

/**
 * Aplica el contrato a un conjunto de etiquetas: retira ruido y variantes
 * legadas, y garantiza que solo exista UNA etiqueta por familia (canal,
 * proveedor, sede, producto) cuando el llamador declara la ganadora.
 *
 * No borra etiquetas que no gestiona (por ejemplo `lead-caliente`,
 * `revisar-ruteo`, `form-id-*` o las de facturación).
 *
 * @param {object} params
 * @param {string[]} params.actuales etiquetas que ya tiene el contacto
 * @param {string|null} [params.canal] etiqueta canónica ganadora
 * @param {string|null} [params.proveedor] etiqueta canónica ganadora
 * @param {string|null} [params.sede] etiqueta canónica ganadora
 * @param {string|null} [params.producto] etiqueta canónica ganadora
 * @param {string[]} [params.agregar] etiquetas extra a añadir
 * @returns {{tags: string[], removidas: string[]}}
 */
export function aplicarContratoEtiquetas({ actuales = [], proveedor = null, pagina = null, agregar = [] } = {}) {
  const removidas = [];
  const set = new Set();

  // 1. Solo sobrevive lo que pertenece al contrato: prov-* y pagina-* (y el estado
  //    comercial que administra el Nivel 2). Todo lo demás se retira y se audita.
  for (const raw of [...(actuales || []), ...(agregar || [])]) {
    const t = String(raw || '').trim();
    if (!t) continue;
    const low = t.toLowerCase();

    if (low.startsWith('prov-')) {
      if (proveedor && low !== String(proveedor).toLowerCase()) { removidas.push(t); continue; }
      set.add(low);
      continue;
    }
    if (low.startsWith('pagina-')) {
      if (pagina && low !== String(pagina).toLowerCase()) { removidas.push(t); continue; }
      set.add(low);
      continue;
    }
    if (TAGS_PROTEGIDAS.has(low)) { set.add(low); continue; }

    // Cualquier otra etiqueta (cola-*, canal-*, sede-*, producto-*, vtiger*,
    // revisar-ruteo, facebook-messenger, meta-ads, sin-telefono…) es basura.
    removidas.push(t);
  }

  if (proveedor) set.add(String(proveedor).toLowerCase());
  if (pagina) set.add(String(pagina).toLowerCase());

  // [DEPURACIÓN 27/11] Las etiquetas de estado ya no se conservan: el bloque de
  // coherencia compro/prospecto dejó de tener sentido. El estado vive en el CF.

  return { tags: [...set], removidas: [...new Set(removidas)] };
}
