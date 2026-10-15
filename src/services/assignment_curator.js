/**
 * ==============================================================================
 * CURADOR DE ASIGNACIONES — ANULA dueños asignados por ERROR a canales NO-Facebook
 * ==============================================================================
 * INCIDENTE (reportado por el coordinador): al ejecutar una campaña de SMS/WSP, el
 * motor asignó de forma errónea contactos de texto a los dueños de FACEBOOK
 * (ERNESTO / CLICK2RING / REDES 1-2). Esos dueños son EXCLUSIVOS de Facebook.
 *
 * QUÉ HACE
 *   Escanea los contactos de una sede y detecta los que:
 *     1. tienen un dueño de FACEBOOK (ERNESTO/CLICK2RING/REDES), y
 *     2. NO son de Facebook (no tienen la etiqueta `facebook-messenger` ni el slug
 *        de una fanpage conocida): son candidatos a SMS/WSP/Email/IG mal asignados.
 *   A esos se les ANULA la asignación (assignedTo = '').
 *
 * SEGURIDAD
 *   · DRY-RUN por defecto: sin `ejecutar=true` NO escribe nada, solo reporta.
 *   · Nunca toca un contacto que tenga la etiqueta de Facebook o fanpage conocida.
 *   · Solo anula dueños de REDES; jamás toca otro tipo de dueño.
 * ==============================================================================
 */

import { ghlFetch } from '../utils/ghl_http_client.js';
import { SEDES_GATEWAY, PALACIOS_USERS, MONITOR_SMS } from '../config/index.js';
import { recordAuditEvent } from './audit_logger.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slugificar = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** IDs de los dueños de FACEBOOK (ERNESTO / CLICK2RING / REDES 1-2 de cada sede). */
function idsDeRedes() {
  const ids = new Set();
  for (const u of Object.values(PALACIOS_USERS)) {
    if (u?.id) ids.add(String(u.id));
  }
  for (const sede of Object.values(SEDES_GATEWAY)) {
    for (const u of Object.values(sede?.users || {})) {
      if (u?.id) ids.add(String(u.id));
    }
  }
  return ids;
}

/** Slugs de fanpage conocidas (señal POSITIVA de Facebook). */
function slugsDeFanpage() {
  const slugs = new Set();
  for (const u of Object.values(PALACIOS_USERS)) {
    for (const p of (u?.pages || [])) slugs.add(slugificar(p));
  }
  for (const sede of Object.values(SEDES_GATEWAY)) {
    for (const u of Object.values(sede?.users || {})) {
      for (const p of (u?.pages || [])) slugs.add(slugificar(p));
    }
  }
  return slugs;
}

/**
 * Anula la asignación de contactos NO-Facebook que quedaron con dueño de REDES.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede='PALACIOS']
 * @param {number} [opts.paginas=20] páginas de 100 contactos (tope 200)
 * @param {boolean} [opts.ejecutar=false] false = DRY-RUN
 */
export async function anularAsignacionesErroneas({ sede = 'PALACIOS', paginas = 20, ejecutar = false } = {}) {
  const sedeId = String(sede).toUpperCase();
  const cfg = SEDES_GATEWAY[sedeId];
  const locId = cfg?.ghl?.locationId;
  const apiKey = cfg?.ghl?.apiKey;
  if (!locId || !apiKey) return { ok: false, reason: `Sede ${sedeId} sin credenciales cargadas` };

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };
  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 20, 1), 200);
  const idsRedes = idsDeRedes();
  const slugs = slugsDeFanpage();

  let escaneados = 0;
  let sospechosos = 0;
  let anulados = 0;
  let errores = 0;
  const detalle = [];

  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100`;
  for (let p = 0; p < limitePaginas && url; p++) {
    const r = await ghlFetch(url, { headers }, 1, 'Curador-Asignaciones');
    if (r.status !== 200) break;
    const d = await r.json();
    const contactos = d?.contacts || [];
    if (contactos.length === 0) break;

    for (const c of contactos) {
      escaneados++;
      const tags = (c.tags || []).map(t => String(t).toLowerCase().trim());

      // 1. Debe tener dueño de REDES (Facebook).
      if (!c.assignedTo || !idsRedes.has(String(c.assignedTo))) continue;

      // 2. Y NO debe ser Facebook: sin etiqueta facebook-messenger y sin slug de fanpage.
      const esFacebook = tags.includes('facebook-messenger')
        || tags.some(t => slugs.has(t));
      if (esFacebook) continue;

      // Sospechoso: dueño de Facebook en un contacto NO-Facebook.
      sospechosos++;
      const item = {
        id: c.id,
        nombre: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        telefono: c.phone || '',
        assignedTo: c.assignedTo,
        tags: tags.slice(0, 8)
      };

      if (!ejecutar) {
        item.resultado = 'DRY_RUN (no se anuló)';
        detalle.push(item);
        continue;
      }

      try {
        const put = await ghlFetch(
          `https://services.leadconnectorhq.com/contacts/${c.id}`,
          { method: 'PUT', headers, body: JSON.stringify({ assignedTo: '' }) },
          1,
          'Curador-Asignaciones'
        );
        if (put.ok) {
          anulados++;
          item.resultado = 'ASIGNACIÓN ANULADA';
        } else {
          errores++;
          item.resultado = `FALLO HTTP ${put.status}`;
        }
      } catch (err) {
        errores++;
        item.resultado = `ERROR ${err.message}`;
      }
      detalle.push(item);
      await sleep(150);
    }

    url = d?.meta?.nextPageUrl || null;
  }

  const reporte = {
    ok: true,
    sede: sedeId,
    modo: ejecutar ? 'EJECUTADO' : 'DRY-RUN',
    escaneados,
    sospechosos,
    anulados,
    errores,
    detalle: detalle.slice(0, 200)
  };

  recordAuditEvent({
    type: ejecutar ? 'ASIGNACION_ANULADA_MASIVA' : 'ASIGNACION_DRY_RUN',
    severity: 'info',
    sede: sedeId,
    escaneados, sospechosos, anulados, errores
  });

  return reporte;
}

/** Busca un usuario de la subcuenta por NOMBRE (p.ej. "MONITOR SMS"). */
async function buscarUsuarioPorNombre(locId, headers, nombre) {
  const candidatos = [
    `https://services.leadconnectorhq.com/users/?locationId=${locId}`,
    `https://services.leadconnectorhq.com/locations/${locId}/users/`
  ];
  const buscado = String(nombre).toLowerCase().trim();
  for (const url of candidatos) {
    try {
      const r = await ghlFetch(url, { headers }, 1, 'Curador-Asignaciones');
      if (r.status !== 200) continue;
      const d = await r.json();
      const usuarios = d?.users || d?.employees || [];
      const encontrado = usuarios.find(u => String(u.name || u.firstName || '').toLowerCase().includes(buscado));
      if (encontrado) return encontrado;
    } catch { /* probar el siguiente endpoint */ }
  }
  return null;
}

/**
 * ASIGNA a MONITOR SMS los contactos del lote de SMS (canal NO-Facebook).
 * Es una asignación "como manual": solo escribe `assignedTo`, sin tocar etiquetas.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede='PALACIOS']
 * @param {number} [opts.paginas=20]
 * @param {boolean} [opts.ejecutar=false] false = DRY-RUN
 * @param {string} [opts.monitorNombre='MONITOR SMS'] nombre del usuario dueño del canal SMS
 */
export async function asignarSmsAMonitor({ sede = 'PALACIOS', paginas = 20, ejecutar = false, monitorNombre = 'MONITOR SMS' } = {}) {
  const sedeId = String(sede).toUpperCase();
  const cfg = SEDES_GATEWAY[sedeId];
  const locId = cfg?.ghl?.locationId;
  const apiKey = cfg?.ghl?.apiKey;
  if (!locId || !apiKey) return { ok: false, reason: `Sede ${sedeId} sin credenciales cargadas` };

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };
  // [MONITOR SMS] Se usa el ID configurado (exclusivo para SMS). Si no está en config,
  // se busca por nombre en GHL como respaldo.
  let monitor = MONITOR_SMS?.id ? { id: MONITOR_SMS.id, name: MONITOR_SMS.name } : null;
  if (!monitor) monitor = await buscarUsuarioPorNombre(locId, headers, monitorNombre);
  if (!monitor?.id) {
    return { ok: false, reason: `No se encontró el usuario '${monitorNombre}' en la subcuenta ${sedeId}` };
  }

  const limitePaginas = Math.min(Math.max(parseInt(paginas, 10) || 20, 1), 200);
  const slugs = slugsDeFanpage();

  let escaneados = 0;
  let encontrados = 0;
  let asignados = 0;
  let errores = 0;
  const detalle = [];

  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100`;
  for (let p = 0; p < limitePaginas && url; p++) {
    const r = await ghlFetch(url, { headers }, 1, 'Curador-Asignaciones');
    if (r.status !== 200) break;
    const d = await r.json();
    const contactos = d?.contacts || [];
    if (contactos.length === 0) break;

    for (const c of contactos) {
      escaneados++;
      const tags = (c.tags || []).map(t => String(t).toLowerCase().trim());

      // Es del lote SMS: NO es Facebook (sin etiqueta facebook-messenger ni slug de fanpage).
      const esFacebook = tags.includes('facebook-messenger') || tags.some(t => slugs.has(t));
      if (esFacebook) continue;

      encontrados++;
      const item = {
        id: c.id,
        nombre: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        telefono: c.phone || '',
        dueñoActual: c.assignedTo || '(sin dueño)'
      };

      if (!ejecutar) {
        item.resultado = 'DRY_RUN (no se asignó)';
        detalle.push(item);
        continue;
      }

      try {
        const put = await ghlFetch(
          `https://services.leadconnectorhq.com/contacts/${c.id}`,
          { method: 'PUT', headers, body: JSON.stringify({ assignedTo: monitor.id }) },
          1,
          'Curador-Asignaciones'
        );
        if (put.ok) {
          asignados++;
          item.resultado = `ASIGNADO a ${monitor.name || monitorNombre}`;
        } else {
          errores++;
          item.resultado = `FALLO HTTP ${put.status}`;
        }
      } catch (err) {
        errores++;
        item.resultado = `ERROR ${err.message}`;
      }
      detalle.push(item);
      await sleep(150);
    }

    url = d?.meta?.nextPageUrl || null;
  }

  const reporte = {
    ok: true,
    sede: sedeId,
    modo: ejecutar ? 'EJECUTADO' : 'DRY-RUN',
    monitor: { id: monitor.id, name: monitor.name || monitorNombre },
    escaneados,
    encontrados,
    asignados,
    errores,
    detalle: detalle.slice(0, 200)
  };

  recordAuditEvent({
    type: ejecutar ? 'SMS_ASIGNADO_A_MONITOR' : 'SMS_MONITOR_DRY_RUN',
    severity: 'info',
    sede: sedeId,
    escaneados, encontrados, asignados, errores
  });

  return reporte;
}
