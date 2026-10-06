/**
 * ==============================================================================
 * PROCEDENCIA DE LEADS — agregador por anuncio / campaña (el "Meta Ads Manager")
 * ==============================================================================
 * Agrega los contactos de una subcuenta por su anuncio de origen (campo UTM
 * Content / ID de Anuncio) y cuenta cuantos leads trajo cada anuncio y cuantos
 * de ellos ya compraron (etiqueta "compro" / "cliente-vtiger").
 *
 * Es el nivel visual que GHL no ofrece nativo: en Meta Business Suite ves el
 * anuncio y cuantos leads genero; aqui se replica ese desglose leyendo los
 * campos que el propio motor ya escribe en cada contacto.
 *
 * SOLO LECTURA. No escribe ni borra nada.
 * ==============================================================================
 */

import { ghlFetch } from '../utils/ghl_http_client.js';
import { readSecret } from '../config/secrets.js';
import { SEDES_GATEWAY } from '../config/index.js';

/** Resuelve los ids de campo por nombre (directo contra la API, sin cache global). */
async function resolverCampos(locationId, apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  const r = await ghlFetch(`https://services.leadconnectorhq.com/locations/${locationId}/customFields`, { headers }, 1, 'Procedencia');
  if (r.status !== 200) return {};
  const d = await r.json();
  const campos = d.customFields || [];
  const buscar = (nombres) => {
    for (const n of nombres) {
      const f = campos.find(c => String(c.name || '').toLowerCase().trim() === n.toLowerCase().trim());
      if (f?.id) return f.id;
    }
    return null;
  };
  return {
    utmContent: buscar(['utm content', 'contenido utm', 'contenido del anuncio', 'nombre del anuncio']),
    utmCampaign: buscar(['utm campaign', 'campana origen', 'campaña origen']),
    idAnuncio: buscar(['id de anuncio', 'id anuncio', 'ad id']),
    sedeAsignada: buscar(['sede asignada', 'oficina origen'])
  };
}

function valorCampo(c, id) {
  if (!id) return null;
  const f = (c.customFields || []).find(f => f.id === id);
  const v = f?.value ?? f?.field_value;
  if (v === undefined || v === null || String(v).trim() === '') return null;
  return String(v).trim();
}

function esComprador(c) {
  const tags = (c.tags || []).map(t => String(t).toLowerCase());
  return tags.includes('compro') || tags.includes('cliente-vtiger') || tags.includes('convertido');
}

/**
 * Agrega los leads por anuncio / campaña.
 * @param {object} [opts]
 * @param {string} [opts.destino='EMPRESA'] EMPRESA o un id de sede (PALACIOS, ...)
 * @param {number} [opts.paginas=30] paginas de 100 contactos (tope 300 = 30k)
 */
export async function procedenciaLeads({ destino = 'EMPRESA', paginas = 30 } = {}) {
  const destinoUp = String(destino).toUpperCase();
  let locId, apiKey;
  if (destinoUp === 'EMPRESA' || destinoUp === 'CENTRAL') {
    locId = readSecret('GHL_LOCATION_ID_CENTRAL');
    apiKey = readSecret('GHL_API_KEY_CENTRAL');
  } else {
    const cfg = SEDES_GATEWAY[destinoUp];
    locId = cfg?.ghl?.locationId;
    apiKey = cfg?.ghl?.apiKey;
  }
  if (!locId || !apiKey) return { ok: false, reason: `Destino ${destinoUp} sin credenciales` };

  const campos = await resolverCampos(locId, apiKey);
  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 30, 1), 300);

  const agregado = new Map(); // clave -> { anuncio, campana, adId, leads, compradores, sedes:Set }
  let escaneados = 0;
  let conAnuncio = 0;
  let sinAnuncio = 0;

  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100`;
  for (let p = 0; p < limitePaginas; p++) {
    const r = await ghlFetch(url, { headers }, 1, 'Procedencia');
    if (r.status !== 200) break;
    const d = await r.json();
    const contactos = d?.contacts || [];
    if (contactos.length === 0) break;

    for (const c of contactos) {
      escaneados++;
      const adName = valorCampo(c, campos.utmContent) || valorCampo(c, campos.utmCampaign);
      const adId = valorCampo(c, campos.idAnuncio);
      const campana = valorCampo(c, campos.utmCampaign) || 'Sin campaña';
      const sede = valorCampo(c, campos.sedeAsignada) || 'Sede no asignada';

      if (!adName && !adId) { sinAnuncio++; continue; }
      conAnuncio++;

      const clave = adName || `ID ${adId}`;
      if (!agregado.has(clave)) {
        agregado.set(clave, { anuncio: clave, campana, adId: adId || null, leads: 0, compradores: 0, sedes: new Set() });
      }
      const reg = agregado.get(clave);
      reg.leads++;
      if (esComprador(c)) reg.compradores++;
      reg.sedes.add(sede);
    }

    const meta = d?.meta || {};
    url = meta.nextPageUrl || (() => {
      const cur = meta.startAfterId ?? meta.startAfter ?? (contactos[contactos.length - 1]?.id);
      return cur ? `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100&startAfterId=${cur}` : null;
    })();
    if (!url) break;
  }

  const filas = [...agregado.values()]
    .map(r => ({
      anuncio: r.anuncio,
      campana: r.campana,
      adId: r.adId,
      leads: r.leads,
      compradores: r.compradores,
      tasaConversion: r.leads ? Math.round((r.compradores / r.leads) * 1000) / 10 : 0,
      sedes: [...r.sedes]
    }))
    .sort((a, b) => b.leads - a.leads);

  return {
    ok: true,
    destino: destinoUp,
    escaneados,
    conAnuncio,
    sinAnuncio,
    totalAnuncios: filas.length,
    camposResueltos: Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, Boolean(v)])),
    filas
  };
}
