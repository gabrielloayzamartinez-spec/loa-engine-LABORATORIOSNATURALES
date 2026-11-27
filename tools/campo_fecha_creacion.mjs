/**
 * CAMPO `contact.contactfecha_creacion_fecha` — ¿está lleno y correcto?
 *
 * Es el campo DATE de GHL que se usa para las campañas por rango de fechas
 * ("creados este mes", "del último trimestre"). Este script mide, por subcuenta:
 *   1. que el campo exista con esa clave exacta,
 *   2. qué % de los contactos lo tiene lleno,
 *   3. en una muestra, si el valor coincide con el `createdtime` de vTiger.
 *
 * SOLO LECTURA. node tools/campo_fecha_creacion.mjs [muestra=50]
 */
import 'dotenv/config';
import { SEDES_GATEWAY } from '../src/config/index.js';
import { query, VTIGER_FIELDS } from '../src/services/vtigerClient.js';

const SEDES = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'];
const N = Math.max(10, parseInt(process.argv[2] || '50', 10));
const BASE = 'https://services.leadconnectorhq.com';
const CLAVE = 'contact.contactfecha_creacion_fecha';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digitos = v => String(v || '').replace(/\D/g, '');
const normFecha = v => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{12,}$/.test(s)) { const d = new Date(Number(s)); return isNaN(d) ? '' : d.toISOString().slice(0, 10); }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
};

const salida = [];
for (const sede of SEDES) {
  const loc = SEDES_GATEWAY[sede]?.ghl?.locationId;
  const key = SEDES_GATEWAY[sede]?.ghl?.apiKey;
  if (!loc || !key) { console.log(`[SKIP] ${sede}: sin credenciales locales`); continue; }
  const h = { Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json' };

  const dic = await (await fetch(`${BASE}/locations/${loc}/customFields`, { headers: h })).json();
  const campo = (dic.customFields || []).find(f => String(f.fieldKey || '').toLowerCase() === CLAVE);
  if (!campo) {
    salida.push({ sede, campo: 'NO EXISTE', lleno: '—', coincide: '—' });
    continue;
  }

  const lista = await (await fetch(`${BASE}/contacts/?locationId=${loc}&limit=${Math.min(N, 100)}`, { headers: h })).json();
  const contactos = lista.contacts || [];

  let llenos = 0, comparados = 0, coinciden = 0;
  for (const c of contactos) {
    const f = (c.customFields || []).find(x => x.id === campo.id);
    const valor = normFecha(f?.value ?? f?.field_value);
    if (!valor) continue;
    llenos++;

    // Verificación contra vTiger (sólo para una submuestra: cuesta 1 consulta c/u).
    if (comparados >= 10) continue;
    const tel = digitos(c.phone);
    if (tel.length < 10) continue;
    try {
      const r = await query(
        `SELECT id, createdtime FROM Contacts WHERE ${VTIGER_FIELDS.SEDE_ACTUAL} = '${sede}' AND ${VTIGER_FIELDS.HOME_PHONE} = '${tel.slice(-10)}' LIMIT 1;`,
        { context: 'campo-fecha' }
      );
      if (r?.[0]) {
        comparados++;
        if (normFecha(r[0].createdtime) === valor) coinciden++;
      }
    } catch { /* sin par en vTiger */ }
    await sleep(80);
  }

  const pct = contactos.length ? Math.round(llenos / contactos.length * 100) : 0;
  salida.push({
    sede,
    campo: `${campo.id} (${campo.dataType})`,
    'lleno': `${llenos}/${contactos.length} (${pct}%)`,
    'coincide con vTiger': comparados ? `${coinciden}/${comparados}` : 'sin muestra'
  });
  console.log(`${sede}: ${llenos}/${contactos.length} con ${CLAVE} lleno (${pct}%) · coincide con vTiger: ${coinciden}/${comparados}`);
}

console.log('');
console.table(salida);
process.exit(0);
