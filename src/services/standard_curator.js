/**
 * ==============================================================================
 * CURADOR DE ESTÁNDAR — CONTROL + CURACIÓN DE RESULTADOS
 * ==============================================================================
 * MOTIVO (reportado por el coordinador): contactos compradores que quedaron con
 * ~5 campos en vez de los 14 del estándar, y "Precio venta" sin sincronizar.
 *
 * Este módulo es la CAPA DE CALIDAD:
 *   1. CONTROL: define el ESTÁNDAR (los 14 campos que TODO comprador debe tener en
 *      GHL) y mide, contacto por contacto, cuáles faltan.
 *   2. CURACIÓN: para los contactos incompletos, re-ejecuta el sincronizador dual
 *      (la MISMA vía que el backfill) para re-llenar lo que falta. El filtro
 *      `soloAvances` garantiza que nunca retrocede un dato que ya está bien.
 *
 * SEGURIDAD
 *   · SOLO LECTURA sobre vTiger.
 *   · La curación delega el respeto de cuota a `hayCuotaRealDeFondo`: nunca compite
 *     con la atención en vivo (si el fondo agotó su franja, se pausa solo).
 *   · DRY-RUN por defecto: sin `curar=true` NO escribe nada, solo diagnostica.
 * ==============================================================================
 */

import { ghlFetch, hayCuotaRealDeFondo } from '../utils/ghl_http_client.js';
import { SEDES_GATEWAY } from '../config/index.js';
import { query as vtigerQuery, VTIGER_CONTACT_SELECT, VTIGER_FIELDS, sedeClause } from './vtigerClient.js';
import { obtenerMapaCamposGhl, leerCampoPorNombre } from './ghl_fields_map.js';
import { syncVtigerContactDual } from './dual_sync_service.js';
import { recordAuditEvent } from './audit_logger.js';
import { getStateStore } from './state/state_store.js';

const store = getStateStore('standard_curator');
const SLEEP_MS = 120;

/**
 * EL ESTÁNDAR: los 14 campos que todo COMPRADOR debe tener en GHL.
 * Cada entrada mapea: el campo en vTiger (origen) y los nombres GHL donde se lee.
 * `precioVenta` NO tiene `vTiger` porque su fuente es la ÚLTIMA orden (hdnGrandTotal),
 * que publica el order history; aquí solo se VERIFICA que haya llegado a GHL.
 */
export const ESTANDAR_CAMPOS = [
  { logico: 'sede',               etiqueta: 'Sede Asignada',         vTiger: VTIGER_FIELDS.SEDE,                ghl: ['Sede Asignada', 'Oficina Origen'] },
  { logico: 'tratamiento',        etiqueta: 'Tratamiento comprado',  vTiger: VTIGER_FIELDS.TRATAMIENTO,         ghl: ['Tratamiento comprado'] },
  { logico: 'canal',              etiqueta: 'Canal Captación',       vTiger: VTIGER_FIELDS.CANAL,               ghl: ['Canal Captación', 'Origen Lead'] },
  { logico: 'campana',            etiqueta: 'Campaña Origen',        vTiger: VTIGER_FIELDS.CAMPANA,             ghl: ['Campaña Origen', 'Campaña Meta', 'UTM Campaign'] },
  { logico: 'proveedor',          etiqueta: 'Proveedor',             vTiger: VTIGER_FIELDS.PROVEEDOR,           ghl: ['Proveedor'] },
  { logico: 'sexo',               etiqueta: 'Sexo',                  vTiger: VTIGER_FIELDS.SEXO,                ghl: ['Sexo'] },
  { logico: 'etapaComercial',     etiqueta: 'Etapa Comercial',       vTiger: VTIGER_FIELDS.ESTADO_VENTA,        ghl: ['Etapa Comercial'] },
  { logico: 'estadoComercial',    etiqueta: 'Estado Comercial',      vTiger: VTIGER_FIELDS.ESTADO_CRM,          ghl: ['Estado Comercial'] },
  { logico: 'contactoNo',         etiqueta: 'Contact No',            vTiger: VTIGER_FIELDS.CONTACT_NO,          ghl: ['Contact No', 'Contacto No'] },
  { logico: 'totalCompras',       etiqueta: 'Total Compras',         vTiger: VTIGER_FIELDS.NUM_COMPRAS,         ghl: ['Total Compras', 'Numero de compras', 'vTiger Total Compras'] },
  { logico: 'fechaUltimaCompra',  etiqueta: 'Fecha Última Compra',   vTiger: VTIGER_FIELDS.FECHA_ULTIMA_COMPRA, ghl: ['Fecha Última Compra', 'vTiger Fecha Ultima Compra'] },
  { logico: 'fechaPrimeraCompra', etiqueta: 'Fecha Primera Compra',  vTiger: VTIGER_FIELDS.FECHA_PRIMERA_COMPRA, ghl: ['Fecha Primera Compra', 'vTiger Fecha Primera Compra'] },
  { logico: 'precioVenta',        etiqueta: 'Precio Venta',          vTiger: null,                             ghl: ['Precio venta', 'Monto Invertido'] },
  { logico: 'idClienteVt',        etiqueta: 'ID Cliente vTiger',     vTiger: VTIGER_FIELDS.ID,                  ghl: ['ID Cliente vTiger', 'vTiger ID'] }
];

/** ¿El valor está vacío o es un placeholder? */
function vacio(v) {
  if (v === undefined || v === null) return true;
  const s = String(v).trim();
  return s === '' || s === '--' || s === 'null' || s === 'undefined' || s === '0.00000';
}

/**
 * Evalúa la completitud de UN contacto GHL contra el estándar.
 * Pura y testeable: no toca la red.
 *
 * @param {object} contactoGhl contacto con `customFields` ({id, value})
 * @param {Map} mapaPorId       mapa de campo id -> nombre (de obtenerMapaCamposGhl)
 * @returns {{total:number, presentes:string[], faltantes:string[], completo:boolean}}
 */
export function evaluarCompletitud(contactoGhl = {}, mapaPorId = new Map()) {
  const presentes = [];
  const faltantes = [];
  for (const c of ESTANDAR_CAMPOS) {
    const valor = leerCampoPorNombre(contactoGhl, mapaPorId, c.ghl);
    if (vacio(valor)) faltantes.push(c.logico);
    else presentes.push(c.logico);
  }
  return { total: ESTANDAR_CAMPOS.length, presentes, faltantes, completo: faltantes.length === 0 };
}

async function leerEstado() {
  return await store.get('control_v1', null) || { ultimaEjecucion: null, totales: { evaluados: 0, completos: 0, curados: 0 } };
}

/** Estado del control (para /api/health y diagnóstico). */
export async function getControlEstandarStatus() {
  return await leerEstado();
}

/**
 * Ejecuta una tanda del CONTROL + CURACIÓN de estándar.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede='PALACIOS']
 * @param {number} [opts.muestra=40] compradores a evaluar (tope 100)
 * @param {boolean} [opts.curar=false] si true, re-sincroniza los incompletos
 */
export async function ejecutarCuracionEstandar({ sede = 'PALACIOS', muestra = 40, curar = false } = {}) {
  const sedeId = String(sede).toUpperCase();
  const cfg = SEDES_GATEWAY[sedeId];
  const locId = cfg?.ghl?.locationId;
  const apiKey = cfg?.ghl?.apiKey;
  if (!locId || !apiKey) return { ok: false, reason: `Sede ${sedeId} sin credenciales cargadas` };

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  const n = Math.min(Math.max(parseInt(muestra, 10) || 40, 5), 100);

  const mapaCampos = await obtenerMapaCamposGhl(locId, headers);

  // Muestra de compradores desde vTiger (los más recientes primero).
  const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.NUM_COMPRAS} > 0${sedeClause(sedeId)} ORDER BY id DESC LIMIT ${n};`;
  let compradores = [];
  try {
    compradores = await vtigerQuery(q, sedeId) || [];
  } catch (err) {
    return { ok: false, reason: `vTiger no respondio: ${err.message}` };
  }

  const porCampo = {};
  for (const c of ESTANDAR_CAMPOS) porCampo[c.logico] = { faltantes: 0, total: 0 };

  let evaluados = 0, completos = 0, curados = 0, ausentes = 0;
  const detalle = [];

  for (const v of compradores) {
    const phone = String(v.mobile || v.phone || v.homephone || v.otherphone || '').replace(/\D/g, '');
    if (phone.length < 10) continue;
    const last10 = phone.slice(-10);

    const rG = await ghlFetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&query=${last10}`,
      { headers }, 1, 'Curador-Estandar'
    );
    await new Promise(r => setTimeout(r, SLEEP_MS));
    if (rG.status !== 200) continue;

    const dG = await rG.json();
    const encontrado = (dG.contacts || []).find(c => String(c.phone || '').replace(/\D/g, '').endsWith(last10)) || (dG.contacts || [])[0];
    if (!encontrado) { ausentes++; continue; }

    // La búsqueda no devuelve customFields: pedir el contacto individual.
    let g = encontrado;
    try {
      const rDet = await ghlFetch(`https://services.leadconnectorhq.com/contacts/${encontrado.id}`, { headers }, 1, 'Curador-Estandar');
      if (rDet.status === 200) {
        const det = await rDet.json();
        if (det?.contact) g = det.contact;
      }
    } catch { /* continuar con lo que trajo la búsqueda */ }
    await new Promise(r => setTimeout(r, SLEEP_MS));

    const evalC = evaluarCompletitud(g, mapaCampos.porId);
    evaluados++;
    if (evalC.completo) completos++;
    for (const f of evalC.faltantes) porCampo[f].faltantes++;
    for (const c of ESTANDAR_CAMPOS) porCampo[c.logico].total++;

    if (!evalC.completo) {
      detalle.push({ nombre: `${v.firstname || ''} ${v.lastname || ''}`.trim(), vTigerId: v.id, ghlId: g.id, faltantes: evalC.faltantes });
      // CURACIÓN: re-sincronizar (respeta el fondo de cuota, así que nunca roba
      // peticiones a la atención en vivo).
      if (curar && hayCuotaRealDeFondo(sedeId)) {
        try {
          const r = await syncVtigerContactDual(v);
          if (r && (r.ok || r.skipped)) curados++;
        } catch { /* el ciclo siguiente lo reintenta */ }
        await new Promise(r => setTimeout(r, SLEEP_MS));
      }
    }
  }

  const estado = await leerEstado();
  estado.ultimaEjecucion = new Date().toISOString();
  estado.totales.evaluados += evaluados;
  estado.totales.completos += completos;
  estado.totales.curados += curados;
  await store.set('control_v1', estado);

  const pctCompleto = evaluados ? Math.round((completos / evaluados) * 1000) / 10 : 0;
  const resumenCampos = ESTANDAR_CAMPOS.map(c => ({
    campo: c.etiqueta,
    ausentePct: porCampo[c.logico].total ? Math.round((porCampo[c.logico].faltantes / porCampo[c.logico].total) * 1000) / 10 : 0
  })).filter(x => x.ausentePct > 0).sort((a, b) => b.ausentePct - a.ausentePct);

  const veredicto = pctCompleto >= 95 ? '🟢 ESTÁNDAR SALUDABLE'
    : pctCompleto >= 80 ? '🟡 ESTÁNDAR PARCIAL: hay campos que curar'
    : '🟠 ESTÁNDAR DEGRADADO: se recomienda curar con curar=true';

  recordAuditEvent({
    type: curar ? 'STANDARD_CURATOR_CYCLE' : 'STANDARD_CURATOR_DRY_RUN',
    severity: 'info',
    sede: sedeId,
    evaluados, completos, curados, ausentes,
    pctCompleto
  });

  return {
    ok: true,
    sede: sedeId,
    estandar: ESTANDAR_CAMPOS.length,
    evaluados,
    completos,
    pctCompleto,
    curados,
    ausentesEnGhl: ausentes,
    camposConHuecos: resumenCampos,
    veredicto,
    incompletos: detalle.slice(0, 20)
  };
}
