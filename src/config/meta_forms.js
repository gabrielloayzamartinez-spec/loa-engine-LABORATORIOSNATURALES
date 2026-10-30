/**
 * ==============================================================================
 * REGISTRO ÚNICO DE IDs DE META (FORMULARIOS LEAD ADS) Y CAMPOS GHL ASOCIADOS
 * ==============================================================================
 * PROBLEMA QUE RESUELVE (auditoría 30/10):
 * El form_id '4385767568340402' (clientes potenciales InHouse Testosterona) y el
 * ID del custom field "id_form_clipo" ('ZGcmoMyhX0pHvat8ipHo') estaban hardcodeados
 * en 3 archivos (page_matrix.js, chat_router_agent.js, meta_leadgen_service.js).
 * Un cambio en un archivo no se propagaba y el form_id / campo se desincronizaba.
 *
 * REGLA: todo módulo que necesite resolver un form_id de Meta o el custom field
 * "id form clipo" debe leer de AQUÍ y de ningún otro sitio.
 * ==============================================================================
 */

/**
 * Nombre del custom field de GHL que guarda el form_id de Meta ("id form clipo").
 * El operador lo creó en GHL y aparece en la TARJETA DEL LEAD a la vista del
 * equipo de chat. Es un campo PERSONALIZADO que YA EXISTE: este módulo NO lo crea,
 * solo resuelve su ID para escribirle.
 */
export const NOMBRE_FIELD_FORM_ID = process.env.GHL_FORM_ID_FIELD_NAME || 'id_form_clipo';

/**
 * IDs del custom field "id form clipo" por SEDE / LOCATION ID.
 * Determinista y cero latencia (no consulta la API de GHL).
 * Para sedes aún sin ID registrado, el motor cae al descubrimiento dinámico
 * por nombre (ver meta_leadgen_service.js).
 */
export const GHL_FORM_ID_FIELD_IDS = {
  PALACIOS: 'ZGcmoMyhX0pHvat8ipHo',
  '5NqOaPYqWyIw2FPBfoRg': 'ZGcmoMyhX0pHvat8ipHo'
};

/**
 * Resuelve el ID del custom field "id form clipo" para una sede/locationId.
 * Prioridad:
 *   1. Variable de entorno explícita GHL_FORM_ID_FIELD (override del operador)
 *   2. Mapa determinista por locationId / sede (cero latencia)
 * Devuelve '' si no hay ID registrado (el llamante puede caer al descubrimiento
 * dinámico por nombre o simplemente omitir la inyección).
 *
 * @param {{ sede?: string, locationId?: string }} ctx
 * @returns {string}
 */
export function resolveFormIdFieldId({ sede = '', locationId = '' } = {}) {
  if (process.env.GHL_FORM_ID_FIELD) return process.env.GHL_FORM_ID_FIELD;
  if (locationId && GHL_FORM_ID_FIELD_IDS[locationId]) return GHL_FORM_ID_FIELD_IDS[locationId];
  if (sede && GHL_FORM_ID_FIELD_IDS[sede]) return GHL_FORM_ID_FIELD_IDS[sede];
  return '';
}

/**
 * Catálogo de formularios Meta Lead Ads conocidos. La clave es el form_id de Meta
 * (cadena numérica). `padecimiento` es el nombre CANÓNICO del catálogo clínico
 * (clinical_vocabulary.js), no el label de vTiger.
 */
export const META_FORMS = {
  '4385767568340402': {
    sede: 'PALACIOS',
    pageId: '718150351371765',
    pageName: 'Laboratorios Naturales BIO',
    proveedor: 'IN_HOUSE',
    padecimiento: 'Potencia'          // Testosterona -> Potencia (canónico)
  }
};

/**
 * form_id por defecto de cada página (respaldo cuando el evento de formulario
 * no trae form_id explícito en el mensaje/texto).
 */
export const PAGE_DEFAULT_FORM_ID = {
  '718150351371765': '4385767568340402'
};

/** Devuelve el form_id por defecto de una página, o null si no está mapeada. */
export function resolveDefaultFormIdByPageId(pageId) {
  return PAGE_DEFAULT_FORM_ID[String(pageId || '').trim()] || null;
}
