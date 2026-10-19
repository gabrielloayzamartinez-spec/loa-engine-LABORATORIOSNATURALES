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
import { normalizeToE164 } from '../utils/geo_phone_sanitizer.js';
import { ghlFetch } from '../utils/ghl_http_client.js';
import { fetchConTimeout } from '../utils/http_timeout.js';
import { recordAuditEvent } from './audit_logger.js';
import { findContactByPhone } from './dual_sync_service.js';

// ──────────────────────────────────────────────────────────────────────────────
// 1. LECTURA DEL DETALLE DEL LEAD EN GRAPH API (App Maestra)
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Consulta el detalle de un leadgen en Meta. Devuelve null si falla (defensivo:
 * la API de Meta puede caer sin tumbar el motor).
 */
export async function consultarLeadgenDetalle(leadgenId, pageId) {
  try {
    const sedeMeta = getMetaConfigBySede({ pageId });
    const systemToken = sedeMeta?.accessToken || getMetaCandidateTokens({ pageId })[0] || '';
    if (!systemToken) {
      console.warn(`[Leadgen] Sin token de sistema para page ${pageId}`);
      return null;
    }

    // Token de la página (necesario para leer el lead de esa página).
    const tokenUrl = `https://graph.facebook.com/${META_CONFIG.graphApiVersion}/${pageId}?fields=access_token&access_token=${systemToken}`;
    const tokenRes = await fetchConTimeout(tokenUrl);
    if (!tokenRes.ok) {
      console.warn(`[Leadgen] No se pudo obtener page token para ${pageId}: HTTP ${tokenRes.status}`);
      return null;
    }
    const tokenData = await tokenRes.json();
    const pageToken = tokenData.access_token;
    if (!pageToken) return null;

    const url = `https://graph.facebook.com/${META_CONFIG.graphApiVersion}/${leadgenId}?fields=field_data,form_id,ad_id,adgroup_id,page_id,created_time&access_token=${pageToken}`;
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
// 2. EXTRACCIÓN DEL TELÉFONO DESDE field_data
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

// ──────────────────────────────────────────────────────────────────────────────
// 3. VINCULACIÓN DEL form_id AL CONTACTO EN GHL (no destructiva)
// ──────────────────────────────────────────────────────────────────────────────
const FIELD_META_AD_ID = process.env.GHL_META_AD_ID_FIELD || ''; // opcional
const FIELD_FORM_ID = process.env.GHL_FORM_ID_FIELD || '';        // opcional (lo crea el operador)

// Nombre del custom field "id_form_clipo" creado por el operador en GHL (Palacios).
const NOMBRE_FIELD_FORM_ID = process.env.GHL_FORM_ID_FIELD_NAME || 'id_form_clipo';

// Cache del id del campo resuelto por nombre (locationId -> id), con TTL de 30 min.
const campoIdCache = new Map();

/**
 * Resuelve el ID del custom field por su NOMBRE (ej. "id_form_clipo") consultando
 * la lista de custom fields de la subcuenta. Se cachea para no repetir la llamada.
 */
async function resolverCampoPorNombre(locationId, headers, nombre) {
  const clave = `${locationId}:${nombre}`;
  const cached = campoIdCache.get(clave);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.id;

  try {
    const res = await ghlFetch(
      `https://services.leadconnectorhq.com/custom-fields/?locationId=${locationId}`,
      { headers }, 1, 'Leadgen'
    );
    if (res.status !== 200) return '';
    const data = await res.json();
    const campos = data.customFields || [];
    const campo = campos.find(c =>
      String(c?.name || '').toLowerCase().replace(/\s+/g, '_') === String(nombre).toLowerCase()
    );
    const id = campo?.id || '';
    campoIdCache.set(clave, { id, ts: Date.now() });
    return id;
  } catch (err) {
    console.warn(`[Leadgen] No se pudo resolver el campo "${nombre}": ${err.message}`);
    return '';
  }
}

async function vincularEnSede(locationId, headers, phone, datos, sedeName) {
  const existente = await findContactByPhone(locationId, phone, headers);
  if (!existente?.id) return null;

  const customFields = [];
  const tagsNuevas = [];

  // form_id: se guarda en tag (siempre) y en el custom field "id_form_clipo".
  if (datos.formId) {
    tagsNuevas.push(`form-id-${datos.formId}`);
    // Prioridad: el campo por NOMBRE (id_form_clipo), o el env si está configurado.
    const idCampo = (await resolverCampoPorNombre(locationId, headers, NOMBRE_FIELD_FORM_ID)) || FIELD_FORM_ID;
    if (idCampo) customFields.push({ id: idCampo, field_value: datos.formId });
  }
  if (FIELD_META_AD_ID && datos.adId) {
    customFields.push({ id: FIELD_META_AD_ID, field_value: datos.adId });
  }

  const body = {};
  if (customFields.length) body.customFields = customFields;

  // [NO DESTRUCTIVO] Solo se añaden tags nuevos (merge), nunca se pisan los existentes.
  if (tagsNuevas.length) {
    const tagsActuales = new Set((existente.tags || []).map(t => String(t).trim()));
    for (const t of tagsNuevas) tagsActuales.add(t);
    body.tags = [...tagsActuales];
  }

  if (!Object.keys(body).length) return existente.id; // nada que inyectar

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

// ──────────────────────────────────────────────────────────────────────────────
// 4. ORQUESTADOR (lo llama el webhook)
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Procesa un evento `leadgen` completo:
 *   - extrae page_id + leadgen_id
 *   - consulta el detalle en Meta
 *   - extrae el teléfono (llave única)
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

        const phone = extraerTelefono(detalle.field_data);
        const formId = String(detalle.form_id || '').trim();
        const adId = String(detalle.ad_id || '').trim();
        const adgroupId = String(detalle.adgroup_id || '').trim();

        if (!phone) {
          recordAuditEvent({ type: 'LEADGEN_SIN_TELEFONO', severity: 'warn', leadgenId, pageId, formId });
          continue;
        }

        const sedeName = getSedeByPageId(pageId) || 'PALACIOS';
        const sedeCfg = SEDES_GATEWAY[sedeName];
        if (!sedeCfg?.ghl?.locationId) {
          recordAuditEvent({ type: 'LEADGEN_SEDE_SIN_CREDENCIALES', severity: 'warn', leadgenId, pageId, sedeName });
          continue;
        }

        const headers = {
          Authorization: `Bearer ${sedeCfg.ghl.apiKey}`,
          Version: '2021-07-28',
          'Content-Type': 'application/json',
          Accept: 'application/json'
        };
        const datos = { formId, adId, adgroupId, pageId };

        // Sede operativa.
        const contactId = await vincularEnSede(sedeCfg.ghl.locationId, headers, phone, datos, sedeName);

        // Central (EMPRESA): solo si está configurada.
        const centralLoc = process.env.GHL_LOCATION_ID_CENTRAL;
        const centralKey = process.env.GHL_API_KEY_CENTRAL;
        if (centralLoc && centralKey) {
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

        // [NIVEL 2 EN BACKGROUND] Un Lead Ad ya trae número: se valida la sede con
        // vTiger en paralelo, sin bloquear la entrega del lead.
        setImmediate(async () => {
          try {
            const { runVtigerSalesBridge } = await import('./vtiger_sales_bridge.js');
            await runVtigerSalesBridge({ soloCompradores: true, limitePorSede: 1 });
          } catch (err) {
            console.warn(`[Leadgen] Nivel 2 background falló: ${err.message}`);
          }
        });
      }
    }
    return { ok: true };
  } catch (err) {
    console.error('[Leadgen] Error general:', err.message);
    recordAuditEvent({ type: 'LEADGEN_EXCEPTION', severity: 'error', message: err.message });
    return { ok: false, error: err.message };
  }
}
