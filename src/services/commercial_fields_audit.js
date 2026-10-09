/**
 * ==============================================================================
 * AUDITORÍA DE CAMPOS COMERCIALES — vTiger ↔ GHL, ESQUINA A ESQUINA
 * ==============================================================================
 * PROBLEMA REPORTADO (captura del usuario en la subcuenta de Palacios)
 * Contactos COMPRADORES con campos clave VACÍOS o INCONSISTENTES:
 *   · DANIEL MONCADA  -> 4 compras, SIN "Fecha compra", SIN "Precio", Sexo "Mujer"
 *   · MARIA RAMIREZ   -> 1 compra,  SIN "Fecha compra", SIN "Precio"
 *
 * La pregunta correcta NO es "¿está vacío en GHL?" sino "¿está vacío TAMBIÉN en
 * vTiger?". Hay dos causas posibles y solo una es nuestra:
 *
 *   (A) vTiger NO tiene el dato  -> no es un fallo del motor; el dato no existe
 *       en el origen (típico en fichas antiguas o cargadas a medias). Se reporta
 *       para que el negocio lo sepa, pero NO se puede "corregir" sin inventarlo.
 *
 *   (B) vTiger SÍ tiene el dato y GHL NO  -> FALLO NUESTRO (el sincronizador no
 *       lo publicó). Es el hueco accionable: se puede corregir y sincronizar.
 *
 * CÓMO LO MIDE
 *   1. Toma una MUESTRA de compradores reales desde vTiger (keyset descendente).
 *   2. Cuenta, en vTiger, cuántos traen cada campo vacío.
 *   3. Busca esos mismos contactos en GHL por teléfono (la regla de gobernanza)
 *      y cuenta cuántos traen el campo vacío allá.
 *   4. Reporta la DIFERENCIA por campo: ese porcentaje es el hueco REAL del motor.
 *
 * Es SOLO LECTURA: no modifica nada.
 * ==============================================================================
 */

import { ghlFetch } from '../utils/ghl_http_client.js';
import { SEDES_GATEWAY } from '../config/index.js';
import { query as vtigerQuery, VTIGER_CONTACT_SELECT, VTIGER_FIELDS, sedeClause } from './vtigerClient.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Campos auditados: nombre legible + clave en vTiger + nombres en GHL. */
const CAMPOS = [
  { clave: 'fechaUltimaCompra', vTiger: VTIGER_FIELDS.FECHA_ULTIMA_COMPRA, ghl: ['Fecha Última Compra', 'vTiger Fecha Ultima Compra'], etiqueta: 'Fecha Última Compra' },
  { clave: 'monto', vTiger: VTIGER_FIELDS.MONTO_INVERTIDO, ghl: ['Total Histórico Gastado USD', 'Monto Invertido'], etiqueta: 'Monto / Total Histórico' },
  { clave: 'tratamiento', vTiger: VTIGER_FIELDS.TRATAMIENTO, ghl: ['Tratamiento comprado'], etiqueta: 'Tratamiento comprado' },
  { clave: 'sexo', vTiger: VTIGER_FIELDS.SEXO, ghl: ['Sexo'], etiqueta: 'Sexo' },
  { clave: 'canal', vTiger: VTIGER_FIELDS.CANAL, ghl: ['Canal Captación', 'Origen Lead'], etiqueta: 'Canal / Origen' },
  { clave: 'campana', vTiger: VTIGER_FIELDS.CAMPANA, ghl: ['Campaña Meta', 'UTM Campaign'], etiqueta: 'Campaña' }
];

/** ¿El valor está vacío o es un placeholder? */
function vacio(v) {
  if (v === undefined || v === null) return true;
  const s = String(v).trim();
  return s === '' || s === '--' || s === 'null' || s === 'undefined';
}

/** Lee un campo personalizado de GHL por nombre (tolerante a variantes). */
function campoGhl(c, nombres) {
  for (const n of nombres) {
    const f = (c.customFields || []).find(x => String(x.name || '').toLowerCase() === n.toLowerCase());
    if (f) {
      const v = f.value ?? f.field_value;
      if (Array.isArray(v)) return v.join(', ');
      if (v !== undefined && v !== null) return String(v).trim();
    }
  }
  return '';
}

/**
 * Ejecuta la auditoría comparativa.
 *
 * @param {object} [opts]
 * @param {string} [opts.sede='PALACIOS']
 * @param {number} [opts.muestra=40] compradores a comparar (tope 100)
 */
export async function auditarCamposComerciales({ sede = 'PALACIOS', muestra = 40 } = {}) {
  const sedeId = String(sede).toUpperCase();
  const cfg = SEDES_GATEWAY[sedeId];
  const locId = cfg?.ghl?.locationId;
  const apiKey = cfg?.ghl?.apiKey;
  if (!locId || !apiKey) return { ok: false, reason: `Sede ${sedeId} sin credenciales cargadas` };

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  const n = Math.min(Math.max(parseInt(muestra, 10) || 40, 5), 100);

  // 1. Muestra de compradores REALES desde vTiger (los más recientes primero).
  const q = `SELECT ${VTIGER_CONTACT_SELECT} FROM Contacts WHERE ${VTIGER_FIELDS.NUM_COMPRAS} > 0${sedeClause(sedeId)} ORDER BY id DESC LIMIT ${n};`;
  let compradores = [];
  try {
    compradores = await vtigerQuery(q, sedeId) || [];
  } catch (err) {
    return { ok: false, reason: `vTiger no respondio: ${err.message}` };
  }

  const vaciosVTiger = {};
  const vaciosGhl = {};
  const huecosNuestros = [];   // vTiger tiene el dato y GHL no: accionable
  const ausentesEnGhl = [];
  const detalle = [];

  for (const campo of CAMPOS) { vaciosVTiger[campo.clave] = 0; vaciosGhl[campo.clave] = 0; }

  let comparados = 0;
  for (const v of compradores) {
    const phone = String(v.mobile || v.phone || v.homephone || v.otherphone || '').replace(/\D/g, '');
    if (phone.length < 10) continue;

    const last10 = phone.slice(-10);
    const rG = await ghlFetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&query=${last10}`,
      { headers },
      1,
      'Auditoria-Comercial'
    );
    await sleep(120);

    if (rG.status !== 200) continue;
    const dG = await rG.json();
    const encontrado = (dG.contacts || []).find(c => String(c.phone || '').replace(/\D/g, '').endsWith(last10)) || (dG.contacts || [])[0];
    if (!encontrado) { ausentesEnGhl.push({ vTigerId: v.id, telefono: last10 }); continue; }

    // [CRÍTICO] El endpoint de BUSQUEDA/LISTA de GHL NO devuelve `customFields`
    // (solo los campos basicos del contacto). Sin este segundo llamado, TODOS los
    // campos personalizados se leian como vacios y la auditoria daba un 100% FALSO
    // de huecos. Se pide el contacto individual, que SI trae customFields.
    let g = encontrado;
    try {
      const rDet = await ghlFetch(
        `https://services.leadconnectorhq.com/contacts/${encontrado.id}`,
        { headers },
        1,
        'Auditoria-Comercial'
      );
      if (rDet.status === 200) {
        const det = await rDet.json();
        if (det?.contact) g = det.contact;
      }
    } catch { /* si falla el detalle se continua con lo que trajo la busqueda */ }
    await sleep(120);

    comparados++;
    const fila = { nombre: `${v.firstname || ''} ${v.lastname || ''}`.trim(), vTigerId: v.id, ghlId: g.id, campos: {} };

    for (const campo of CAMPOS) {
      const valorV = v[campo.vTiger];
      const valorG = campoGhl(g, campo.ghl);
      const vVacio = vacio(valorV);
      const gVacio = vacio(valorG);
      if (vVacio) vaciosVTiger[campo.clave]++;
      if (gVacio) vaciosGhl[campo.clave]++;
      fila.campos[campo.etiqueta] = { vTiger: vVacio ? '(vacío)' : String(valorV).slice(0, 30), ghl: gVacio ? '(vacío)' : String(valorG).slice(0, 30) };

      // Hueco NUESTRO: existe en el origen y no llegó al destino.
      if (!vVacio && gVacio) {
        huecosNuestros.push({ nombre: fila.nombre, ghlId: g.id, campo: campo.etiqueta, valorEnVTiger: String(valorV).slice(0, 40) });
      }
    }
    detalle.push(fila);
  }

  const pct = (x) => (comparados ? Math.round((x / comparados) * 1000) / 10 : 0);
  const porCampo = CAMPOS.map(c => ({
    campo: c.etiqueta,
    vTigerVacioPct: pct(vaciosVTiger[c.clave]),
    ghlVacioPct: pct(vaciosGhl[c.clave]),
    huecoNuestroPct: pct(vaciosGhl[c.clave] - vaciosVTiger[c.clave] > 0 ? vaciosGhl[c.clave] - vaciosVTiger[c.clave] : 0),
    vTigerVacios: vaciosVTiger[c.clave],
    ghlVacios: vaciosGhl[c.clave]
  }));

  const totalHuecos = huecosNuestros.length;
  const veredicto = totalHuecos === 0
    ? '🟢 SIN HUECOS NUESTROS: los vacíos vienen del origen (vTiger), no del motor.'
    : totalHuecos <= comparados * 0.05
      ? '🟡 HUECOS MENORES: la mayoria de vacios son del origen; hay unos pocos accionables.'
      : '🟠 HUECOS ACCIONABLES: hay campos que EXISTEN en vTiger y NO llegaron a GHL.';

  return {
    ok: true,
    sede: sedeId,
    muestraSolicitada: n,
    compradoresLeidosVTiger: compradores.length,
    comparados,
    ausentesEnGhl: ausentesEnGhl.length,
    porCampo,
    totalHuecosNuestros: totalHuecos,
    veredicto,
    ejemplosHuecos: huecosNuestros.slice(0, 20),
    detalle: detalle.slice(0, 20),
    ausentes: ausentesEnGhl.slice(0, 10)
  };
}
