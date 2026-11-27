/**
 * Nivel 2 — Re-etiquetado de canal (ONE-SHOT).
 * Unifica `canal-fb-msgr` -> `canal-messenger`, `canal-form` -> `canal-forms`
 * y elimina `cola-*`. Corre UNA SOLA VIDA: llega a su meta (todas las sedes)
 * y muere (termina). Guarda cursor por sede para retomar sin repetir.
 */
import { getActiveSedes, getGhlHeaders } from '../config/index.js';
import { ghlFetch } from '../utils/ghl_http_client.js';
import { loadCursor, saveCursor } from './nivel2_cursor.js';
import { esEtiquetaRuido } from '../domain/ghl_tags.js';

/**
 * [AUDITORÍA 27/11 — CONTRATO ÚNICO] Mapa de variantes LEGADAS -> canónica.
 * Se amplió con `canal-fb-msgr` y `canal-wsp`: las generaba el reverse sync a partir
 * del valor crudo de vTiger (`cf_3507='FB-MSGR'`) y quedaban DUPLICADAS junto a la
 * canónica que escribe el Nivel 1 (medido: 11 contactos en Roosevelt, 8 en Palacios).
 */
const REEMPLAZOS = {
  'canal-fb-msgr': 'canal-messenger',
  'canal-form': 'canal-forms',
  'canal-wsp': 'canal-whatsapp',
  'canal-fb': 'canal-messenger'
};
const COLA_TAGS = new Set(['cola-redes-1', 'cola-redes-2', 'cola-forms', 'cola-inhouse', 'cola-wsp', 'cola-general']);
const GHL_BASE = 'https://services.leadconnectorhq.com';

// Cursor por sede (en memoria + estado persistente opcional vía stateStore).
let cursorPorSede = loadCursor('retag');
let terminado = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processPage(locId, headers, url, counters) {
  const res = await ghlFetch(url, { headers: { ...headers, Version: '2021-07-28' } }, 1, 'Nivel2-Retag');
  if (res.status !== 200) return { next: null, error: `HTTP ${res.status}` };
  const data = await res.json();
  const contacts = data.contacts || [];
  for (const c of contacts) {
    counters.total++;
    const tags = (c.tags || []).filter(t => typeof t === 'string');
    const nuevos = new Set();
    const quitar = new Set();
    for (const t of tags) {
      const low = String(t).trim().toLowerCase();
      if (!low) continue;
      if (REEMPLAZOS[low]) { nuevos.add(REEMPLAZOS[low]); quitar.add(t); continue; }
      if (COLA_TAGS.has(low)) { quitar.add(t); continue; }
      // [AUDITORÍA 27/11] Ruido declarado por el contrato (vtiger,
      // vtiger-sincronizado, vtiger-status-*): se retira de una vez. Era el
      // residuo más visible: 92.9% de los compradores de Roosevelt y 33% de Piura.
      if (esEtiquetaRuido(low)) { quitar.add(t); continue; }
    }
    if (!nuevos.size && !quitar.size) { counters.skip++; continue; }

    const gh = { ...headers, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };
    // [AHORRO DE CUOTA] Antes se hacía UN POST por etiqueta nueva y UN DELETE por
    // etiqueta vieja (hasta 4 llamadas por contacto). Los endpoints de tags aceptan
    // listas: 1 POST + 1 DELETE por contacto.
    if (nuevos.size) {
      await sleep(120);
      const r = await ghlFetch(`${GHL_BASE}/contacts/${c.id}/tags`, { method: 'POST', headers: gh, body: JSON.stringify({ tags: [...nuevos] }) }, 1, 'Nivel2-Retag');
      if (r.status === 200 || r.status === 201) counters.ok++; else counters.fail++;
    }
    if (quitar.size) {
      await sleep(120);
      const r = await ghlFetch(`${GHL_BASE}/contacts/${c.id}/tags`, { method: 'DELETE', headers: gh, body: JSON.stringify({ tags: [...quitar] }) }, 1, 'Nivel2-Retag');
      if (r.status === 200 || r.status === 204) counters.ok++; else counters.fail++;
    }
  }
  return { next: data?.meta?.nextPageUrl || null, error: null };
}

/**
 * Ejecuta UNA pasada del re-etiquetado. Devuelve progreso y si ya terminó.
 */
export async function runRetagOneShot({ maxPaginasPorSede = 300 } = {}) {
  const sedes = getActiveSedes().filter(s => !s.isPaused && s.ghl?.locationId);
  const counters = { total: 0, ok: 0, skip: 0, fail: 0 };
  let progreso = [];

  await Promise.all(sedes.map(async (sede) => {
    const locId = sede.ghl.locationId;
    const headers = getGhlHeaders({ locationId: locId });
    let url = cursorPorSede.get(locId) || `${GHL_BASE}/contacts/?locationId=${locId}&limit=100`;
    let paginas = 0;
    let procesadosSede = 0;

    while (url && paginas < maxPaginasPorSede) {
      paginas++;
      const { next, error } = await processPage(locId, headers, url, counters);
      if (error) { progreso.push({ sede: sede.name, locId, error, paginas, procesadosSede }); break; }
      procesadosSede += 100;
      url = next || null;
    }

    if (url) {
      // [AUDITORÍA 27/11 — ORDEN DE PERSISTENCIA] Antes se guardaba ANTES de
      // actualizar el Map: el archivo quedaba con el valor viejo y un reinicio del
      // servidor obligaba a empezar de nuevo. Se muta primero y se persiste después.
      cursorPorSede.set(locId, url);
      saveCursor('retag', cursorPorSede); // quedan páginas: guarda cursor para la próxima pasada
      progreso.push({ sede: sede.name, locId, pendiente: true, paginas, procesadosSede });
    } else {
      cursorPorSede.delete(locId);
      saveCursor('retag', cursorPorSede); // sede terminada
      progreso.push({ sede: sede.name, locId, terminada: true, paginas, procesadosSede });
    }
  }));


  terminado = sedes.length > 0 && sedes.every(s => !cursorPorSede.has(s.ghl.locationId));
  // [AUDITORÍA 27/11 — BUG DE CURSOR] Sin llaves, el `clear()` se ejecutaba SIEMPRE:
  // una pasada parcial borraba el cursor y la siguiente volvía a empezar en la
  // página 1. Con bases de más de 30.000 contactos (Palacios 49.656) el barrido
  // nunca pasaba de las primeras páginas y las etiquetas legadas del resto de la
  // cartera sobrevivían para siempre.
  if (terminado) {
    saveCursor('retag', cursorPorSede);
    cursorPorSede.clear();
  }

  return {
    oneShot: true,
    terminado,
    counters,
    sedes: progreso,
    mensaje: terminado ? 'META ALCANZADA: re-etiquetado completo. El proceso murió.' : 'Pasada parcial: queda pendiente, relanza para continuar.'
  };
}

export function getRetagState() {
  return { terminado, cursorPorSede: Object.fromEntries(cursorPorSede) };
}
