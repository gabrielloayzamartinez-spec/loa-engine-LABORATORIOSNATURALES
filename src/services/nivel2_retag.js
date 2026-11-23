/**
 * Nivel 2 — Re-etiquetado de canal (ONE-SHOT).
 * Unifica `canal-fb-msgr` -> `canal-messenger`, `canal-form` -> `canal-forms`
 * y elimina `cola-*`. Corre UNA SOLA VIDA: llega a su meta (todas las sedes)
 * y muere (termina). Guarda cursor por sede para retomar sin repetir.
 */
import { getActiveSedes, getGhlHeaders } from '../config/index.js';
import { ghlFetch } from '../utils/ghl_http_client.js';

const REEMPLAZOS = { 'canal-fb-msgr': 'canal-messenger', 'canal-form': 'canal-forms' };
const COLA_TAGS = new Set(['cola-redes-1', 'cola-redes-2', 'cola-forms', 'cola-inhouse', 'cola-wsp', 'cola-general']);
const GHL_BASE = 'https://services.leadconnectorhq.com';

// Cursor por sede (en memoria + estado persistente opcional vía stateStore).
let cursorPorSede = new Map();
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
      if (REEMPLAZOS[t]) { nuevos.add(REEMPLAZOS[t]); quitar.add(t); }
      else if (COLA_TAGS.has(t)) quitar.add(t);
    }
    if (!nuevos.size && !quitar.size) { counters.skip++; continue; }
    const gh = { ...headers, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };
    for (const nt of nuevos) {
      await sleep(120);
      const r = await ghlFetch(`${GHL_BASE}/contacts/${c.id}/tags`, { method: 'POST', headers: gh, body: JSON.stringify({ tags: [nt] }) }, 1, 'Nivel2-Retag');
      if (r.status === 200 || r.status === 201) counters.ok++; else counters.fail++;
    }
    for (const qt of quitar) {
      await sleep(120);
      const r = await ghlFetch(`${GHL_BASE}/contacts/${c.id}/tags`, { method: 'DELETE', headers: gh, body: JSON.stringify({ tags: [qt] }) }, 1, 'Nivel2-Retag');
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
      cursorPorSede.set(locId, url); // quedan páginas: guarda cursor para la próxima pasada
      progreso.push({ sede: sede.name, locId, pendiente: true, paginas, procesadosSede });
    } else {
      cursorPorSede.delete(locId); // sede terminada
      progreso.push({ sede: sede.name, locId, terminada: true, paginas, procesadosSede });
    }
  }));


  terminado = sedes.length > 0 && sedes.every(s => !cursorPorSede.has(s.ghl.locationId));
  if (terminado) cursorPorSede.clear();

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
