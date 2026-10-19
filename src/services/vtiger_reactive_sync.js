/**
 * ==============================================================================
 * SYNCHRONIZACIÓN REACTIVA vTiger → GHL (EVENT-DRIVEN, UNIDIRECCIONAL)
 * ==============================================================================
 * ARQUITECTURA:
 *   - vTiger CRM es la ÚNICA fuente de verdad operativa.
 *   - GHL es el consumidor REACTIVO: solo actúa cuando recibe un EVENTO de vTiger
 *     (no barre, no duplica). El trabajo de Nivel 2 se dispara EXCLUSIVAMENTE por
 *     estas señales, eliminando el doble ingreso y las notas redundantes.
 *
 * PROTOCOLO:
 *   - vTiger emite SOLO transiciones de estado CLAVE (allow-list), nunca cada
 *     guardado de registro.
 *   - `vtiger_record_id` (en un custom field de GHL) es la llave de reconciliación.
 *   - Idempotencia por `event_id` (un evento se procesa UNA sola vez).
 *   - Retry con backoff para fallos de recepción + log de transacciones fallidas.
 * ==============================================================================
 */

import { recordAuditEvent } from './audit_logger.js';
import { getStateStore } from './state/state_store.js';
import { ghlFetch } from '../utils/ghl_http_client.js';
import { SEDES_GATEWAY } from '../config/index.js';

// ──────────────────────────────────────────────────────────────────────────────
// CONSTANTES DEL PROTOCOLO
// ──────────────────────────────────────────────────────────────────────────────
export const VTIGER_SCHEMA_VERSION = '1.0';

/** Allow-list de eventos: SOLO transiciones de estado clave, no cada guardado. */
export const VTIGER_EVENT_TYPES = [
  'contact.created',       // nuevo contacto en vTiger
  'contact.qualified',     // nuevo lead CALIFICADO (teléfono válido y/o compras)
  'contact.stage_changed', // cambio de etapa de pipeline
  'contact.assigned',      // asignación de asesor / cita
  'sale.created'           // venta nueva (SalesOrder)
];

/** Custom field en GHL que guarda `vtiger_record_id` (lo crea el operador). */
const VTIGER_ID_FIELD = process.env.GHL_VTIGER_ID_FIELD || '';

// ──────────────────────────────────────────────────────────────────────────────
// IDEMPOTENCIA (event_id → ya procesado)
// ──────────────────────────────────────────────────────────────────────────────
const eventosStore = getStateStore('vtiger_eventos_reactivos');
const CLAVE_PROCESADOS = 'procesados_v1';
const TTL_EVENTO_MS = 48 * 60 * 60 * 1000; // 48 h de retención del dedup
const MAX_EVENTOS = 20000;

const procesados = new Map(); // event_id -> ts
let cargada = false;

async function cargarProcesados() {
  if (cargada) return;
  cargada = true;
  try {
    const guardado = await eventosStore.get(CLAVE_PROCESADOS, null);
    if (guardado && typeof guardado === 'object') {
      const corte = Date.now() - TTL_EVENTO_MS;
      for (const [id, ts] of Object.entries(guardado)) {
        if (Number(ts) >= corte) procesados.set(id, Number(ts));
      }
    }
  } catch (err) {
    console.warn(`[Reactive Sync] No se pudo cargar el dedup de eventos: ${err.message}`);
  }
}

async function persistirProcesados() {
  try {
    const corte = Date.now() - TTL_EVENTO_MS;
    const vigentes = [...procesados.entries()]
      .filter(([, ts]) => ts >= corte)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_EVENTOS);
    await eventosStore.set(CLAVE_PROCESADOS, Object.fromEntries(vigentes));
  } catch (err) {
    console.warn(`[Reactive Sync] No se pudo persistir el dedup: ${err.message}`);
  }
}

/** ¿Este evento ya fue procesado? (idempotencia estricta). */
export async function esEventoDuplicado(eventId) {
  if (!eventId) return true; // sin id → se rechaza (no se puede deduplicar)
  await cargarProcesados();
  return procesados.has(eventId);
}

async function marcarProcesado(eventId) {
  await cargarProcesados();
  procesados.set(eventId, Date.now());
  // Poda oportunista.
  if (procesados.size > MAX_EVENTOS * 1.5) {
    const corte = Date.now() - TTL_EVENTO_MS;
    for (const [id, ts] of procesados) if (ts < corte) procesados.delete(id);
  }
  await persistirProcesados();
}

/** ¿El event_type está permitido (allow-list)? */
export function esEventoPermitido(eventType) {
  return VTIGER_EVENT_TYPES.includes(String(eventType || '').trim());
}

// ──────────────────────────────────────────────────────────────────────────────
// NORMALIZACIÓN DEL PAYLOAD (desacoplado de notas innecesarias)
// ──────────────────────────────────────────────────────────────────────────────
function limpiarTexto(v, max = 120) {
  return String(v ?? '').trim().slice(0, max);
}

function limpiarTelefono(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d.length >= 7 ? `+${d}` : '';
}

/**
 * Normaliza el payload recibido de vTiger a una estructura interna estable.
 * Devuelve { ok, evento | error }.
 */
export function normalizarEventoVtiger(raw = {}) {
  const meta = raw?.meta || {};
  const c = raw?.contact || raw;

  const eventId = limpiarTexto(meta.event_id, 80);
  const eventType = limpiarTexto(meta.event_type, 40);
  const vtigerId = limpiarTexto(meta.vtiger_record_id || c.id || c.contactid || c.contact_id, 40);
  const phone = limpiarTelefono(c.phone || c.mobile || c.homephone || c.telefono);

  if (!eventId) return { ok: false, error: 'falta meta.event_id (obligatorio para idempotencia)' };
  if (!eventType) return { ok: false, error: 'falta meta.event_type' };
  if (!esEventoPermitido(eventType)) {
    return { ok: false, error: `event_type '${eventType}' no está en la allow-list`, ignorar: true };
  }
  if (!vtigerId) return { ok: false, error: 'falta meta.vtiger_record_id (llave de reconciliación)' };

  return {
    ok: true,
    evento: {
      eventId,
      eventType,
      vtigerId,
      timestamp: meta.timestamp ? new Date(meta.timestamp).toISOString() : new Date().toISOString(),
      firstname: limpiarTexto(c.firstname || c.first_name, 60),
      lastname: limpiarTexto(c.lastname || c.last_name, 60),
      phone,
      email: limpiarTexto(c.email, 120),
      sede: limpiarTexto(c.sede || c.cf_3451, 40).toUpperCase(),
      etapa: limpiarTexto(c.etapa || c.stage || c.pipeline_stage, 40),
      tratamiento: limpiarTexto(c.tratamiento || c.cf_2610 || c.treatment, 60),
      numCompras: parseInt(c.num_compras || c.spl_num_compras || '0', 10) || 0,
      fechaUltimaCompra: limpiarTexto(c.fecha_ultima_compra || c.spl_fecha_ultima_compra, 20),
      campaign: limpiarTexto(c.campaign || c.cf_3472, 120)
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// RECONCILIACIÓN por vtiger_record_id (Custom Field en GHL)
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Busca en GHL un contacto que ya tenga `vtiger_record_id` en su custom field.
 * Es la llave foránea para evitar duplicados por nombre o por teléfono.
 */
export async function findContactByVtigerId(vtigerId, locationId, headers) {
  if (!vtigerId || !VTIGER_ID_FIELD) return null;
  try {
    // GHL no permite filtrar por custom field en /contacts/search; se recorre una
    // página acotada y se compara el campo. (En la práctica el número es la 2ª llave.)
    const url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100`;
    const res = await ghlFetch(url, { headers }, 1, 'ReactiveSync');
    if (res.status !== 200) return null;
    const data = await res.json();
    const contactos = data.contacts || [];
    return contactos.find(c =>
      (c.customFields || []).some(f => f.id === VTIGER_ID_FIELD && String(f.value) === String(vtigerId))
    ) || null;
  } catch (err) {
    console.warn(`[Reactive Sync] Error reconciliando ${vtigerId}: ${err.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// PROCESAMIENTO PRINCIPAL (el endpoint lo llama)
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Procesa un evento reactivo de vTiger:
 *   1. normaliza + valida el event_type (allow-list)
 *   2. idempotencia por event_id
 *   3. reconcilia el contacto por vtiger_record_id
 *   4. aplica el upsert en GHL (solo si el número/estado es válido)
 *   5. audita éxito/fallo (el fallo queda para retry con backoff)
 *
 * @param {object} raw payload recibido
 * @param {object} [opts] { sede } para resolver la subcuenta
 * @returns {Promise<object>} { ok, eventId, action, contactId | reason }
 */
export async function procesarEventoReactivo(raw, opts = {}) {
  const norm = normalizarEventoVtiger(raw);
  if (!norm.ok) return norm;

  const e = norm.evento;

  // 1. Idempotencia estricta (un evento = una sola aplicación).
  if (await esEventoDuplicado(e.eventId)) {
    return { ok: true, duplicado: true, eventId: e.eventId, reason: 'evento ya procesado' };
  }

  // 2. Resolver subcuenta por sede (fail-safe: sin sede válida no se escribe).
  const sede = String(opts.sede || e.sede || 'PALACIOS').toUpperCase();
  const cfg = SEDES_GATEWAY[sede];
  const locId = cfg?.ghl?.locationId;
  const apiKey = cfg?.ghl?.apiKey;
  if (!locId || !apiKey) {
    recordAuditEvent({ type: 'VTIGER_REACTIVE_SKIP', severity: 'warn', eventId: e.eventId, vtigerId: e.vtigerId, reason: `sede ${sede} sin credenciales` });
    return { ok: false, reason: `sede ${sede} sin credenciales` };
  }
  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };

  // 3. Reconciliación por vtiger_record_id.
  const existente = await findContactByVtigerId(e.vtigerId, locId, headers);

  // 4. Construir payload mínimo (solo campos que vienen, sin notas redundantes).
  const upsert = {};
  if (e.firstname || e.lastname) {
    upsert.firstName = e.firstname;
    upsert.lastName = e.lastname;
  }
  if (e.phone) upsert.phone = e.phone;
  if (e.email) upsert.email = e.email;

  // Custom fields: la llave + los campos comerciales clave.
  const customFields = [];
  if (VTIGER_ID_FIELD) customFields.push({ id: VTIGER_ID_FIELD, field_value: e.vtigerId });
  if (e.tratamiento) customFields.push({ id: '5Sci2WhOpJq9kZWsLTrp', field_value: e.tratamiento }); // tratamientoComprado (Palacios)
  if (customFields.length) upsert.customFields = customFields;

  try {
    let contactId = existente?.id || null;
    if (contactId) {
      await ghlFetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
        method: 'PUT', headers, body: JSON.stringify(upsert)
      }, 1, 'ReactiveSync');
    } else if (e.phone) {
      const r = await ghlFetch('https://services.leadconnectorhq.com/contacts/', {
        method: 'POST', headers, body: JSON.stringify(upsert)
      }, 1, 'ReactiveSync');
      const d = r.ok ? await r.json() : null;
      contactId = d?.contact?.id || null;
    }

    await marcarProcesado(e.eventId);
    recordAuditEvent({
      type: 'VTIGER_REACTIVE_OK',
      severity: 'info',
      eventId: e.eventId,
      eventType: e.eventType,
      vtigerId: e.vtigerId,
      sede,
      action: contactId ? (existente ? 'updated' : 'created') : 'skipped',
      contactId: contactId || null
    });
    return { ok: true, eventId: e.eventId, action: contactId ? (existente ? 'updated' : 'created') : 'skipped', contactId };
  } catch (err) {
    // Fallo: NO se marca procesado → el evento queda para RETRY con backoff.
    recordAuditEvent({
      type: 'VTIGER_REACTIVE_FAIL',
      severity: 'error',
      eventId: e.eventId,
      eventType: e.eventType,
      vtigerId: e.vtigerId,
      sede,
      message: err.message
    });
    return { ok: false, eventId: e.eventId, reason: err.message, retryable: true };
  }
}
