/**
 * ==============================================================================
 * AUDITORÍA DE DATOS — SUBCUENTA EMPRESA (copia fiel de vTiger)
 * ==============================================================================
 * Detecta "datos basura" en la Cuenta Empresa:
 *   1. DUPLICADOS: el mismo teléfono en 2+ contactos (la basura más común tras
 *      mezclar una base histórica de ~400k con la sincronización del motor).
 *   2. SIN TELÉFONO: contactos que no se pueden vincular a vTiger.
 *
 * Solo LECTURA: no borra ni fusiona nada. Devuelve un reporte para que el
 * operador decida (la fusión automática por teléfono es peligrosa: dos personas
 * pueden compartir número; por eso aquí solo se DETECTA, no se altera).
 *
 * El escaneo es paginado y acotado (para no recorrer 400k de una sola vez):
 * cada llamada devuelve hasta `limitePaginas` páginas de 100 contactos.
 * ==============================================================================
 */

import { readSecret } from '../config/secrets.js';
import { ghlFetch } from '../utils/ghl_http_client.js';
import { recordAuditEvent } from './audit_logger.js';

/** Normaliza un teléfono a los últimos 10 dígitos (NANP), o null si no sirve. */
export function normalizarTelefonoAuditoria(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

/**
 * Escanea la Cuenta Empresa y detecta duplicados por teléfono.
 *
 * @param {object} [opts]
 * @param {number} [opts.paginas=5]  páginas de 100 contactos a revisar (máx 50)
 * @returns {Promise<object>} reporte { ok, escaneados, duplicados, pares }
 */
export async function auditarDuplicadosEmpresa({ paginas = 5 } = {}) {
  const locId = readSecret('GHL_LOCATION_ID_CENTRAL');
  const apiKey = readSecret('GHL_API_KEY_CENTRAL');
  if (!locId || !apiKey) {
    return { ok: false, reason: 'Cuenta Empresa no configurada (GHL_LOCATION_ID_CENTRAL / GHL_API_KEY_CENTRAL)' };
  }

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 5, 1), 50);

  const porTelefono = new Map(); // tel -> [ids]
  let escaneados = 0;
  let sinTelefono = 0;
  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100`;

  for (let p = 0; p < limitePaginas; p++) {
    const r = await ghlFetch(url, { headers }, 1, 'Audit-Dup');
    if (r.status !== 200) {
      return { ok: false, reason: `GHL devolvió HTTP ${r.status}`, escaneados };
    }
    const d = await r.json();
    const contactos = d?.contacts || [];
    if (contactos.length === 0) break;

    for (const c of contactos) {
      escaneados++;
      const tel = normalizarTelefonoAuditoria(c.phone);
      if (!tel) { sinTelefono++; continue; }
      if (!porTelefono.has(tel)) porTelefono.set(tel, []);
      porTelefono.get(tel).push(c.id);
    }

    // [PAGINACION CORRECTA] GHL pagina con `startAfter` (un cursor), NO con
    // `nextPageUrl`. Con el campo equivocado, el bucle se detenia tras la PRIMERA
    // pagina y el auditor/depurador solo veia 100 contactos: el reporte de
    // "0 sin telefono" era falso (la basura esta en las paginas profundas).
    // [PAGINACION REAL] GHL expone el cursor como `startAfterId` (el ID del ultimo
    // contacto). El campo `startAfter` es numerico y NO avanza las paginas: devolvia
    // el MISMO contacto repetido, lo que inflaba el reporte de duplicados/sin-telefono
    // (se contaba el mismo contacto N veces como si fueran N duplicados).
    url = siguienteUrlContactos(d, contactos, locId);
    if (!url) break;
  }

  const duplicados = [...porTelefono.entries()].filter(([, ids]) => ids.length > 1);
  const reporte = {
    ok: true,
    escaneados,
    paginasRevisadas: limitePaginas,
    sinTelefono,
    totalUnicos: porTelefono.size,
    duplicados: duplicados.length,
    pares: duplicados.slice(0, 25).map(([tel, ids]) => ({
      telefono: tel,
      repeticiones: ids.length,
      contactos: ids
    }))
  };

  recordAuditEvent({
    type: 'EMPRESA_AUDIT_DUPLICADOS',
    severity: duplicados.length > 0 ? 'warn' : 'info',
    ...reporte,
    pares: undefined // no volcar ids masivos al log
  });

  return reporte;
}

/**
 * DEPURACIÓN: fusiona los duplicados de la Cuenta Empresa (mismo teléfono).
 *
 * Regla: de cada grupo con el mismo teléfono se CONSERVA el contacto más reciente
 * (mayor dateUpdated, el más fresco) y se ELIMINA el resto. Antes de borrar no se
 * rescatan campos: al ser una copia fiel, los duplicados vienen del mismo registro
 * de vTiger y el sobreviviente ya tiene el dato vigente.
 *
 * SEGURIDAD: por defecto es MODO SECO (`ejecutar:false`) — solo reporta qué haría.
 * Para borrar de verdad hay que pasar `ejecutar:true` explícitamente. Nunca se
 * borra sin confirmación.
 *
 * @param {object} [opts]
 * @param {number} [opts.paginas=5]
 * @param {boolean} [opts.ejecutar=false] true para ELIMINAR los duplicados
 * @returns {Promise<object>}
 */

/**
 * Calcula la URL de la siguiente pagina de contactos GHL de forma robusta.
 * El endpoint GET /contacts/ esta deprecated y su cursor historico (`startAfter`
 * numerico) no avanza las paginas. Prioridad:
 *   1) `meta.nextPageUrl` (GHL provee la URL completa correcta)
 *   2) `meta.startAfterId` / `meta.startAfter`
 *   3) el id del ultimo contacto del lote
 */
function siguienteUrlContactos(d, contactos, locId) {
  const meta = d?.meta || {};
  if (meta.nextPageUrl) return meta.nextPageUrl;
  const cursor = meta.startAfterId ?? meta.startAfter ?? (contactos?.[contactos.length - 1]?.id);
  return cursor
    ? `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100&startAfterId=${cursor}`
    : null;
}

export async function depurarDuplicadosEmpresa({ paginas = 5, ejecutar = false } = {}) {
  const locId = readSecret('GHL_LOCATION_ID_CENTRAL');
  const apiKey = readSecret('GHL_API_KEY_CENTRAL');
  if (!locId || !apiKey) {
    return { ok: false, reason: 'Cuenta Empresa no configurada' };
  }

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 5, 1), 50);

  // tel -> [{ id, dateUpdated }]
  const porTelefono = new Map();
  const metaCapturada = [];
  let escaneados = 0;
  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100`;

  for (let p = 0; p < limitePaginas; p++) {
    const r = await ghlFetch(url, { headers }, 1, 'Depurar-Dup');
    if (r.status !== 200) return { ok: false, reason: `HTTP ${r.status}`, escaneados };
    const d = await r.json();
    const contactos = d?.contacts || [];
    if (contactos.length === 0) break;
    if (metaCapturada.length < 3) {
      metaCapturada.push({
        pagina: p + 1,
        nContactos: contactos.length,
        primerId: contactos[0]?.id,
        ultimoId: contactos[contactos.length - 1]?.id,
        meta: d?.meta ?? null
      });
    }
    for (const c of contactos) {
      escaneados++;
      const tel = normalizarTelefonoAuditoria(c.phone);
      if (!tel) continue;
      if (!porTelefono.has(tel)) porTelefono.set(tel, []);
      porTelefono.get(tel).push({ id: c.id, dateUpdated: c.dateUpdated || c.dateAdded || '' });
    }
    url = siguienteUrlContactos(d, contactos, locId);
    if (!url) break;
  }

  // Determinar sobreviviente y sobrantes por grupo duplicado.
  const aEliminar = [];
  for (const [tel, regs] of porTelefono.entries()) {
    if (regs.length < 2) continue;
    const ordenados = [...regs].sort((a, b) => String(b.dateUpdated).localeCompare(String(a.dateUpdated)));
    const [sobreviviente, ...sobrantes] = ordenados;
    for (const s of sobrantes) {
      aEliminar.push({ telefono: tel, id: s.id, sobrevivienteId: sobreviviente.id });
    }
  }

  let eliminados = 0;
  const fallos = [];
  if (ejecutar && aEliminar.length > 0) {
    for (const x of aEliminar) {
      try {
        const del = await ghlFetch(`https://services.leadconnectorhq.com/contacts/${x.id}`, {
          method: 'DELETE', headers
        }, 1, 'Depurar-Dup');
        if (del.status === 200 || del.status === 204) eliminados++;
        else fallos.push({ id: x.id, status: del.status });
      } catch (e) {
        fallos.push({ id: x.id, error: e.message });
      }
    }
  }

  const reporte = {
    ok: true,
    modo: ejecutar ? 'EJECUTADO (borrado real)' : 'MODO SECO (solo reporte)',
    escaneados,
    gruposDuplicados: [...porTelefono.values()].filter(r => r.length > 1).length,
    aEliminar: aEliminar.length,
    eliminados,
    fallos,
    metaCapturada,
    muestra: aEliminar.slice(0, 15).map(x => ({ telefono: x.telefono, eliminarId: x.id, conservarId: x.sobrevivienteId }))
  };

  recordAuditEvent({
    type: 'EMPRESA_DEPURACION_DUPLICADOS',
    severity: aEliminar.length > 0 ? 'warn' : 'info',
    modo: reporte.modo,
    escaneados,
    aEliminar: aEliminar.length,
    eliminados,
    fallos: fallos.length
  });

  return reporte;
}

/**
 * DEPURACIÓN DE CONTACTOS SIN TELÉFONO (basura de gestiones anteriores).
 *
 * Un contacto sin teléfono NO se puede vincular a vTiger (el teléfono es la única
 * llave), así que para la Empresa (copia fiel) es basura: no aporta a la medición.
 * En vez de borrarlo de golpe (irreversible), se lo ETIQUETA como
 * `basura-sin-telefono` para que quede identificado y excluible de las Smart Lists.
 * El borrado real es una decisión posterior del operador.
 *
 * @param {object} [opts]
 * @param {number} [opts.paginas=5]
 * @param {boolean} [opts.ejecutar=false] true para ETIQUETAR (reversible)
 * @param {boolean} [opts.borrar=false]    true para BORRAR de GHL (irreversible)
 * @returns {Promise<object>}
 */
export async function depurarSinTelefonoEmpresa({ paginas = 5, ejecutar = false, borrar = false } = {}) {
  const locId = readSecret('GHL_LOCATION_ID_CENTRAL');
  const apiKey = readSecret('GHL_API_KEY_CENTRAL');
  if (!locId || !apiKey) {
    return { ok: false, reason: 'Cuenta Empresa no configurada' };
  }

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };
  // [TOPE AMPLIO] El barrido completo de la Empresa (~408k) son ~4080 paginas. Se
  // permite hasta 6000 para cubrir toda la base de un tirón (corre en segundo plano).
  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 5, 1), 6000);

  const sinTelefono = [];
  let escaneados = 0;
  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100`;

  for (let p = 0; p < limitePaginas; p++) {
    const r = await ghlFetch(url, { headers }, 1, 'Depurar-SinTel');
    if (r.status !== 200) return { ok: false, reason: `HTTP ${r.status}`, escaneados };
    const d = await r.json();
    const contactos = d?.contacts || [];
    if (contactos.length === 0) break;
    for (const c of contactos) {
      escaneados++;
      if (!normalizarTelefonoAuditoria(c.phone)) sinTelefono.push(c.id);
    }
    // [PAGINACION CORRECTA] GHL pagina con `startAfter` (un cursor), NO con
    // `nextPageUrl`. Con el campo equivocado, el bucle se detenia tras la PRIMERA
    // pagina y el auditor/depurador solo veia 100 contactos: el reporte de
    // "0 sin telefono" era falso (la basura esta en las paginas profundas).
    // [PAGINACION REAL] GHL expone el cursor como `startAfterId` (el ID del ultimo
    // contacto). El campo `startAfter` es numerico y NO avanza las paginas: devolvia
    // el MISMO contacto repetido, lo que inflaba el reporte de duplicados/sin-telefono
    // (se contaba el mismo contacto N veces como si fueran N duplicados).
    url = siguienteUrlContactos(d, contactos, locId);
    if (!url) break;
  }

  let etiquetados = 0;
  let borrados = 0;
  const fallos = [];
  if ((ejecutar || borrar) && sinTelefono.length > 0) {
    for (const id of sinTelefono) {
      try {
        if (borrar) {
          // [BORRADO DEFINITIVO] GHL DELETE /contacts/{id}. Irreversible: solo para
          // la basura sin telefono de la Empresa, que no aporta nada.
          const r = await ghlFetch(
            `https://services.leadconnectorhq.com/contacts/${id}`,
            { method: 'DELETE', headers },
            1, 'Depurar-SinTel-Borrar'
          );
          if (r.status === 200 || r.status === 204) borrados++;
          else fallos.push({ id, status: r.status });
        } else {
          const r = await ghlFetch(
            `https://services.leadconnectorhq.com/contacts/${id}/tags`,
            { method: 'POST', headers, body: JSON.stringify({ tags: ['basura-sin-telefono'] }) },
            1, 'Depurar-SinTel'
          );
          if (r.status === 200 || r.status === 201) etiquetados++;
          else fallos.push({ id, status: r.status });
        }
      } catch (e) {
        fallos.push({ id, error: String(e.message).slice(0, 80) });
      }
    }
  }

  const reporte = {
    ok: true,
    modo: borrar ? 'EJECUTADO (BORRADOS de GHL)' : (ejecutar ? 'EJECUTADO (etiquetados)' : 'MODO SECO (solo reporte)'),
    escaneados,
    sinTelefono: sinTelefono.length,
    etiquetados,
    borrados,
    fallos: fallos.length,
    etiqueta: 'basura-sin-telefono'
  };

  recordAuditEvent({
    type: 'EMPRESA_DEPURACION_SIN_TELEFONO',
    severity: sinTelefono.length > 0 ? 'warn' : 'info',
    modo: reporte.modo,
    escaneados,
    sinTelefono: sinTelefono.length,
    etiquetados,
    fallos: fallos.length
  });

  return reporte;
}


