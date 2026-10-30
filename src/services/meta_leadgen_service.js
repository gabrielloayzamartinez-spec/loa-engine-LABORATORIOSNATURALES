/**
 * ==============================================================================
 * CAPTURA Y VINCULACIÓN DE form_id DE META LEAD ADS → GHL
 * ==============================================================================
 * GHL no extrae el form_id de los leads de Lead Ads; ese dato queda en Meta. Este
 * servicio intercepta el evento `leadgen`, consulta el detalle en la Graph API de la
 * App Maestra, extrae el TELÉFONO (llave única) y vincula el form_id + atribución de
 * Meta al contacto correspondiente en GHL (Sede + Central), sin bloquear el Nivel 1.
 *
 * REGLAS (gobernanza):
 *   - Llave única = teléfono normalizado (E.164).
 *   - Inyección NO destructiva (solo añade tag/form_id, no pisa datos existentes).
 *   - El Nivel 2 (vTiger) se despacha en background: un Lead Ad YA trae número desde
 *     el segundo 0, así que se valida la sede en paralelo sin retrasar la entrega.
 * ==============================================================================
 */

import { META_CONFIG, SEDES_GATEWAY, getMetaConfigBySede } from '../config/index.js';
import { getMetaCandidateTokens } from '../services/meta_api_service.js';
import { getSedeByPageId } from '../config/page_matrix.js';
import { resolveFormIdFieldId, NOMBRE_FIELD_FORM_ID } from '../config/meta_forms.js';
import { normalizeToE164 } from '../utils/geo_phone_sanitizer.js';
import { ghlFetch } from '../utils/ghl_http_client.js';
import { recordAuditEvent } from './audit_logger.js';
import { findContactByPhone, isCentralConfigured } from './dual_sync_service.js';

// ──────────────────────────────────────────────────────────────────────────────
// 1. LECTURA DEL DETALLE DEL LEAD EN GRAPH API (App Maestra)
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Consulta el detalle de un leadgen en Meta. Devuelve null si falla (defensivo:
 * la API de Meta puede caer sin tumbar el motor).
 */
export async function consultarLeadgenDetalle(leadgenId, pageId) {
  try {
    const apiVersion = META_CONFIG.graphApiVersion || 'v20.0';
    const sedeMeta = getMetaConfigBySede({ pageId });
    const systemToken = sedeMeta?.accessToken || getMetaCandidateTokens({ pageId })[0] || SEDES_GATEWAY.PALACIOS?.meta?.accessToken || '';
    if (!systemToken) {
      console.warn(`[Leadgen] Sin token de sistema para page ${pageId}`);
      return null;
    }

    // Token de la página (necesario para leer el lead de esa página).
    const tokenUrl = `https://graph.facebook.com/${apiVersion}/${pageId}?fields=access_token&access_token=${systemToken}`;
    const tokenRes = await fetchConTimeout(tokenUrl);
    if (!tokenRes.ok) {
      console.warn(`[Leadgen] No se pudo obtener page token para ${pageId}: HTTP ${tokenRes.status}`);
      return null;
    }
    const tokenData = await tokenRes.json();
    const pageToken = tokenData.access_token;
    if (!pageToken) return null;

    const url = `https://graph.facebook.com/${apiVersion}/${leadgenId}?fields=id,created_time,field_data,form_id,ad_id,adset_id&access_token=${pageToken}`;
    const res = await fetchConTimeout(url);
    if (!res.ok) {
      console.warn(`[Leadgen] Detalle de lead ${leadgenId}: HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[Leadgen] Error consultando detalle ${leadgenId}: ${err.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. EXTRACCIÓN DE DATOS DESDE field_data
// ──────────────────────────────────────────────────────────────────────────────
/** field_data viene como [{name, values:[...]}, ...]. Se busca el teléfono. */
export function extraerTelefono(fieldData = []) {
  const candidatos = [
    'phone_number', 'phone', 'tel', 'telefono', 'mobile', 'phone_number_2'
  ];
  for (const f of fieldData) {
    const name = String(f?.name || '').toLowerCase();
    if (candidatos.includes(name) || name.includes('phone') || name.includes('telefono')) {
      const raw = Array.isArray(f?.values) ? f.values[0] : f?.values;
      const phone = normalizeToE164(raw);
      if (phone) return phone;
    }
  }
  // Fallback: escanear cualquier campo que parezca teléfono (10+ dígitos).
  for (const f of fieldData) {
    const raw = Array.isArray(f?.values) ? f.values[0] : f?.values;
    const phone = normalizeToE164(raw);
    if (phone) return phone;
  }
  return '';
}

/** Extrae nombre completo y/o desglose desde field_data. */
export function extraerNombre(fieldData = []) {
  let fullName = '';
  let firstName = '';
  let lastName = '';
  for (const f of fieldData) {
    const name = String(f?.name || '').toLowerCase().trim();
    const raw = Array.isArray(f?.values) ? f.values[0] : (f?.values || '');
    const val = String(raw || '').trim();
    if (!val) continue;
    if (name === 'full_name' || name === 'nombre_completo' || name === 'nombre') {
      fullName = val;
    } else if (name === 'first_name' || name === 'primer_nombre') {
      firstName = val;
    } else if (name === 'last_name' || name === 'apellido' || name === 'apellidos') {
      lastName = val;
    }
  }
  if (!fullName && (firstName || lastName)) {
    fullName = `${firstName} ${lastName}`.trim();
  }
  return { fullName, firstName, lastName };
}

// [19/10] El email se ELIMINÓ del flujo: la operación no usa Gmail/email, y
// extraerlo causaba errores. El único dato de contacto es el TELÉFONO (llave única).


// ──────────────────────────────────────────────────────────────────────────────
// 3. VINCULACIÓN DEL form_id AL CONTACTO EN GHL (no destructiva)
// ──────────────────────────────────────────────────────────────────────────────
const FIELD_META_AD_ID = process.env.GHL_META_AD_ID_FIELD || ''; // opcional

// El nombre del custom field "id_form_clipo" y el mapa determinista de IDs por
// sede viven en la FUENTE ÚNICA: src/config/meta_forms.js. Aquí solo se consulta
// a través de resolveFormIdFieldId() / NOMBRE_FIELD_FORM_ID.

// Cache del id del campo resuelto por nombre (locationId -> id), con TTL de 30 min.
const campoIdCache = new Map();

/**
 * Resuelve el ID del custom field por su NOMBRE (ej. "id_form_clipo") consultando
 * la lista de custom fields de la subcuenta en GHL v2.
 */
async function resolverCampoPorNombre(locationId, headers, nombre) {
  const clave = `${locationId}:${nombre}`;
  const cached = campoIdCache.get(clave);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.id;

  try {
    const res = await ghlFetch(
      `https://services.leadconnectorhq.com/locations/${locationId}/customFields`,
      { headers }, 1, 'Leadgen'
    );
    if (res.status !== 200) return '';
    const data = await res.json();
    const campos = data.customFields || [];
    const target = String(nombre).toLowerCase().replace(/\s+/g, '_');
    const campo = campos.find(c => {
      const nom = String(c?.name || '').toLowerCase().replace(/\s+/g, '_');
      return nom === target || nom.includes('id_form_clipo') || nom.includes('form_id') || nom.includes('id_form');
    });
    const id = campo?.id || '';
    if (id) campoIdCache.set(clave, { id, ts: Date.now() });
    return id;
  } catch (err) {
    console.warn(`[Leadgen] No se pudo resolver el campo "${nombre}": ${err.message}`);
    return '';
  }
}

/**
 * Resuelve el Custom Field ID del formulario para una sede dada, con prioridad:
 * 1. Variable de entorno explícita GHL_FORM_ID_FIELD (override del operador)
 * 2. Mapa determinista por sede/locationId (cero latencia)  [meta_forms.js]
 * 3. Descubrimiento dinámico por nombre vía API de GHL
 */
async function resolverCampoFormId(locationId, headers, sedeName) {
  // 1. Fuente única: env explícito o mapa determinista por sede/locationId (0 latencia).
  const conocido = resolveFormIdFieldId({ sede: sedeName, locationId });
  if (conocido) return conocido;
  // 2. Descubrimiento dinámico por nombre vía API de GHL (sedes sin ID registrado).
  return await resolverCampoPorNombre(locationId, headers, NOMBRE_FIELD_FORM_ID);
}

async function vincularEnSede(locationId, headers, phone, datos, sedeName) {
  let existente = await findContactByPhone(locationId, phone, headers);

  // Si no se encuentra de inmediato, dar una pequeña ventana de gracia (1.5s) por si GHL
  // nativo está creando el contacto concurrentemente.
  if (!existente?.id) {
    await new Promise(r => setTimeout(r, 1500));
    existente = await findContactByPhone(locationId, phone, headers);
  }

  const customFields = [];
  const tagsNuevas = ['meta-ads', 'lead-ad', 'form'];

  // form_id: se inyecta en el custom field oficial "id form clipo" y en etiqueta
  if (datos.formId) {
    tagsNuevas.push(`form-id-${datos.formId}`);
    const idCampo = await resolverCampoFormId(locationId, headers, sedeName);
    if (idCampo) customFields.push({ id: idCampo, field_value: datos.formId });
  }

  // Atribución de anuncio (Ad ID y Adset ID)
  const sedeCf = SEDES_GATEWAY[sedeName]?.customFields;
  if (datos.adId) {
    if (sedeCf?.idAnuncio) customFields.push({ id: sedeCf.idAnuncio, field_value: datos.adId });
    if (sedeCf?.adIdAlt) customFields.push({ id: sedeCf.adIdAlt, field_value: datos.adId });
    if (FIELD_META_AD_ID && FIELD_META_AD_ID !== sedeCf?.idAnuncio && FIELD_META_AD_ID !== sedeCf?.adIdAlt) {
      customFields.push({ id: FIELD_META_AD_ID, field_value: datos.adId });
    }
  }
  if (datos.adgroupId && sedeCf?.adsetId) {
    customFields.push({ id: sedeCf.adsetId, field_value: datos.adgroupId });
  }

  // Si el contacto ya existe en GHL, actualizamos con merge no destructivo
  if (existente?.id) {
    const body = {};
    if (customFields.length) body.customFields = customFields;

    // [NO DESTRUCTIVO] Solo se añaden tags nuevos (merge), nunca se pisan los existentes.
    const tagsActuales = new Set((existente.tags || []).map(t => String(t).trim()));
    for (const t of tagsNuevas) tagsActuales.add(t);
    body.tags = [...tagsActuales];

    if (!Object.keys(body).length) return existente.id;

    try {
      await ghlFetch(`https://services.leadconnectorhq.com/contacts/${existente.id}`, {
        method: 'PUT', headers, body: JSON.stringify(body)
      }, 1, 'Leadgen');
      return existente.id;
    } catch (err) {
      console.warn(`[Leadgen] No se pudo inyectar form_id en ${sedeName}: ${err.message}`);
      return null;
    }
  }

  // Si el contacto NO existe aún en GHL, lo creamos directamente con los datos de Meta
  const createPayload = {
    locationId,
    phone,
    tags: tagsNuevas,
    customFields
  };
  if (datos.fullName) createPayload.name = datos.fullName;
  if (datos.firstName) createPayload.firstName = datos.firstName;
  if (datos.lastName) createPayload.lastName = datos.lastName;

  try {
    const resCreate = await ghlFetch('https://services.leadconnectorhq.com/contacts/', {
      method: 'POST', headers, body: JSON.stringify(createPayload)
    }, 1, 'LeadgenCreate');

    if (resCreate.ok) {
      const dataCreate = await resCreate.json();
      return dataCreate?.contact?.id || null;
    } else {
      const errText = await resCreate.text().catch(() => '');
      console.warn(`[Leadgen] Contacto no creado en ${sedeName} (HTTP ${resCreate.status}): ${errText}`);
      return null;
    }
  } catch (err) {
    console.warn(`[Leadgen] Error creando contacto nuevo en ${sedeName}: ${err.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 4. ORQUESTADOR (lo llama el webhook)
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Procesa un evento `leadgen` completo:
 *   - extrae page_id + leadgen_id
 *   - consulta el detalle en Meta
 *   - extrae el teléfono (llave única), nombre y correo
 *   - vincula form_id + atribución en GHL (Sede + Central)
 *   - despacha la validación de sede (Nivel 2) en background
 */
export async function procesarLeadgen(payload) {
  try {
    const entries = payload?.entry || [];
    for (const entry of entries) {
      const pageId = entry.id;
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== 'leadgen') continue;
        const leadgenId = change.value?.leadgen_id || change.value?.id;
        if (!leadgenId) continue;

        const detalle = await consultarLeadgenDetalle(leadgenId, pageId);
        if (!detalle) {
          recordAuditEvent({ type: 'LEADGEN_DETALLE_FALLIDO', severity: 'warn', leadgenId, pageId });
          continue;
        }
        await procesarLeadDetalle(detalle, pageId, leadgenId);
      }
    }
    return { ok: true };
  } catch (err) {
    console.error('[Leadgen] Error general:', err.message);
    recordAuditEvent({ type: 'LEADGEN_EXCEPTION', severity: 'error', message: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Procesa el DETALLE de un lead (venga del webhook o del backfill): extrae teléfono,
 * nombre y correo, vincula form_id + atribución en GHL (Sede + Central) y despacha
 * el Nivel 2 en background. Es la unidad compartida por ambas rutas.
 */
async function procesarLeadDetalle(detalle, pageId, leadgenId = '') {
  const phone = extraerTelefono(detalle.field_data);
  const { fullName, firstName, lastName } = extraerNombre(detalle.field_data);
  const formId = String(detalle.form_id || '').trim();
  const adId = String(detalle.ad_id || '').trim();
  const adgroupId = String(detalle.adset_id || detalle.adgroup_id || '').trim();

  if (!phone) {
    recordAuditEvent({ type: 'LEADGEN_SIN_TELEFONO', severity: 'warn', leadgenId, pageId, formId });
    return { ok: false, reason: 'sin telefono' };
  }

  const sedeName = getSedeByPageId(pageId) || 'PALACIOS';
  const sedeCfg = SEDES_GATEWAY[sedeName];
  if (!sedeCfg?.ghl?.locationId) {
    recordAuditEvent({ type: 'LEADGEN_SEDE_SIN_CREDENCIALES', severity: 'warn', leadgenId, pageId, sedeName });
    return { ok: false, reason: 'sede sin credenciales' };
  }

  const headers = {
    Authorization: `Bearer ${sedeCfg.ghl.apiKey}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  const datos = { formId, adId, adgroupId, pageId, fullName, firstName, lastName };

  // Sede operativa.
  const contactId = await vincularEnSede(sedeCfg.ghl.locationId, headers, phone, datos, sedeName);

  // Central (EMPRESA): solo si está configurada y activa (no pausada).
  const centralLoc = process.env.GHL_LOCATION_ID_CENTRAL;
  const centralKey = process.env.GHL_API_KEY_CENTRAL;
  if (centralLoc && centralKey && isCentralConfigured()) {
    const centralHeaders = {
      Authorization: `Bearer ${centralKey}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    await vincularEnSede(centralLoc, centralHeaders, phone, datos, 'Central');
  }

  recordAuditEvent({
    type: 'LEADGEN_VINCULADO',
    severity: 'info',
    leadgenId,
    pageId,
    formId,
    adId,
    adgroupId,
    sede: sedeName,
    phone,
    contactId
  });

  // [19/10 — FIX BUCLE] El enriquecimiento vTiger YA NO se dispara por cada lead:
  // el Reverse Sync (cada 3 min) y el Sales Bridge (cada 10 min) lo cubren de forma
  // periódica y controlada. Disparar runVtigerSalesBridge por lead saturaba la cola
  // y causaba un bucle que no continuaba.

  return { ok: true, contactId };
}

/**
 * BACKFILL de Lead Ads históricos: lee los leads pasados de un formulario
 * (GET /{form_id}/leads) y los procesa uno a uno, para sincronizar el pasado
 * operativo del canal, no solo los entrantes.
 */
export async function backfillLeadgen({ formId, pageId, limit = 100, cursor = null } = {}) {
  try {
    const apiVersion = META_CONFIG.graphApiVersion || 'v20.0';
    const sedeMeta = getMetaConfigBySede({ pageId });
    const systemToken = sedeMeta?.accessToken || getMetaCandidateTokens({ pageId })[0] || '';
    if (!systemToken || !formId || !pageId) {
      recordAuditEvent({ type: 'LEADGEN_BACKFILL_SKIP', severity: 'warn', formId, pageId, reason: 'falta token/form_id/page_id' });
      return { ok: false, reason: 'falta token/form_id/page_id' };
    }

    const tokenUrl = `https://graph.facebook.com/${apiVersion}/${pageId}?fields=access_token&access_token=${systemToken}`;
    const tokenRes = await fetchConTimeout(tokenUrl);
    const tokenData = tokenRes.ok ? await tokenRes.json() : {};
    const pageToken = tokenData.access_token;
    if (!pageToken) return { ok: false, reason: 'sin page token' };

    const url = `https://graph.facebook.com/${apiVersion}/${formId}/leads?fields=id,created_time,field_data,form_id,ad_id,adset_id&limit=${limit}${cursor ? `&after=${cursor}` : ''}&access_token=${pageToken}`;
    const res = await fetchConTimeout(url);
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      recordAuditEvent({ type: 'LEADGEN_BACKFILL_FAIL', severity: 'error', formId, pageId, message: err.slice(0, 200) });
      return { ok: false, reason: `HTTP ${res.status}` };
    }

    const data = await res.json();
    const leads = data.data || [];
    let procesados = 0;
    let sinTelefono = 0;
    for (const lead of leads) {
      const r = await procesarLeadDetalle(lead, pageId, lead.id);
      if (r.ok) procesados++;
      else if (r.reason === 'sin telefono') sinTelefono++;
    }

    recordAuditEvent({
      type: 'LEADGEN_BACKFILL_OK',
      severity: 'info',
      formId,
      pageId,
      total: leads.length,
      procesados,
      sinTelefono,
      next: data.paging?.cursors?.after || null
    });
    return { ok: true, total: leads.length, procesados, sinTelefono, next: data.paging?.cursors?.after || null };
  } catch (err) {
    console.error('[Leadgen Backfill] Error:', err.message);
    recordAuditEvent({ type: 'LEADGEN_BACKFILL_EXCEPTION', severity: 'error', message: err.message });
    return { ok: false, error: err.message };
  }
}
