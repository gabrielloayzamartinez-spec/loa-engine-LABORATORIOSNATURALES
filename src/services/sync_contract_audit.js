/**
 * ==============================================================================
 * AUDITORÍA DEL CONTRATO DE SINCRONIZACIÓN (Nivel 1 + Nivel 2) — SOLO LECTURA
 * ==============================================================================
 * Responde UNA pregunta con números: "¿están TODOS los custom fields y todas las
 * etiquetas que el motor promete en cada subcuenta?".
 *
 * QUÉ MIDE, por subcuenta:
 *   1. Diccionario real de campos (los CF que existen de verdad, no los que el
 *      código cree que existen).
 *   2. Cobertura de cada campo del contrato sobre una muestra de contactos.
 *   3. Cobertura de cada familia de etiquetas (canal/proveedor/sede/pagina/producto).
 *   4. Conflictos: dos canales, dos proveedores, dos sedes, dos productos.
 *   5. Ruido: `vtiger`, `vtiger-sincronizado`, `vtiger-status-*` y variantes
 *      legadas de canal (`canal-form`, `canal-fb-msgr`).
 *   6. Contactos sin ninguna etiqueta (invisibles para las Smart Views).
 *
 * No escribe nada: ni en GHL ni en vTiger. Consume ~1 llamada por cada 100
 * contactos muestreados + 1 por subcuenta (diccionario de campos).
 * ==============================================================================
 */

import { ghlFetch } from '../utils/ghl_http_client.js';
import { SEDES_GATEWAY, getActiveSedes } from '../config/index.js';
import { obtenerMapaCamposGhl, normalizarNombreCampo } from './ghl_fields_map.js';
import { CANALES_VALIDOS, SEDES_VALIDAS } from '../domain/ghl_tags.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Campos del contrato. `ghl` son las variantes de nombre aceptadas (la primera
 * que exista en el diccionario manda). `nivel`: 'N1' si lo escribe la atención en
 * vivo, 'N2' si lo escribe la sincronización con vTiger, 'ambos' si comparten.
 */
export const CAMPOS_CONTRATO = [
  // --- Identidad y enrutamiento ---
  { logico: 'sedeAsignada', etiqueta: 'Sede Asignada', nivel: 'ambos', ghl: ['Sede Asignada', 'Sede Origen', 'Oficina Origen'] },
  { logico: 'sedeTiendaCompra', etiqueta: 'Sede / Tienda Compra', nivel: 'N2', ghl: ['Sede / Tienda Compra', 'Sede Tienda Compra'] },
  { logico: 'tratamientoComprado', etiqueta: 'Tratamiento comprado', nivel: 'ambos', ghl: ['Tratamiento comprado', 'Tratamiento'] },
  { logico: 'proveedor', etiqueta: 'Proveedor', nivel: 'ambos', ghl: ['Proveedor'] },
  { logico: 'canalCaptacion', etiqueta: 'Canal Captacion', nivel: 'ambos', ghl: ['Canal Captacion', 'Canal'] },
  { logico: 'campana', etiqueta: 'Campaña / UTM Campaign', nivel: 'ambos', ghl: ['Campaña Meta', 'UTM Campaign', 'Campaña Origen'] },
  { logico: 'origenLead', etiqueta: 'Origen Lead', nivel: 'N1', ghl: ['Origen Lead'] },
  { logico: 'origenCompra', etiqueta: 'Origen Compra', nivel: 'N2', ghl: ['Origen Compra'] },
  // --- Comerciales (14 del estándar) ---
  { logico: 'sexo', etiqueta: 'Sexo', nivel: 'N2', ghl: ['Sexo'] },
  { logico: 'etapaComercial', etiqueta: 'Etapa Comercial', nivel: 'N2', ghl: ['Etapa Comercial'] },
  { logico: 'estadoComercial', etiqueta: 'Estado Comercial', nivel: 'ambos', ghl: ['Estado Comercial'] },
  { logico: 'estadoCompra', etiqueta: 'Estado de Compra', nivel: 'ambos', ghl: ['Estado de Compra'] },
  { logico: 'statusContacto', etiqueta: 'Status del Contacto', nivel: 'ambos', ghl: ['Status del Contacto'] },
  { logico: 'contactNo', etiqueta: 'Contact No', nivel: 'N2', ghl: ['Contact No', 'Contacto No'] },
  { logico: 'idCliente', etiqueta: 'ID Cliente', nivel: 'N2', ghl: ['ID Cliente', 'ID de Cliente'] },
  { logico: 'totalCompras', etiqueta: 'Total Compras', nivel: 'N2', ghl: ['Total Compras', 'Numero de compras'] },
  { logico: 'precioVenta', etiqueta: 'Precio venta (última orden)', nivel: 'N2', ghl: ['Precio venta', 'Monto Invertido'] },
  { logico: 'totalHistorico', etiqueta: 'Total Historico Gastado USD', nivel: 'N2', ghl: ['Total Historico Gastado USD', 'Total Histórico Gastado USD'] },
  { logico: 'fechaPrimeraCompra', etiqueta: 'Fecha Primera Compra', nivel: 'N2', ghl: ['Fecha Primera Compra'] },
  { logico: 'fechaUltimaCompra', etiqueta: 'Fecha Última Compra', nivel: 'N2', ghl: ['Fecha Última Compra', 'Fecha Ultima Compra', 'Fecha compra'] },
  { logico: 'fechaUltimaFactura', etiqueta: 'Fecha Ultima Factura', nivel: 'N2', ghl: ['Fecha Ultima Factura'] },
  { logico: 'fechaCreacion', etiqueta: 'Fecha Creacion', nivel: 'ambos', ghl: ['Fecha Creacion', 'Fecha Creación (Fecha)'] },
  { logico: 'fechaAsignacion', etiqueta: 'Fecha Ultima Asignacion', nivel: 'N1', ghl: ['Fecha Ultima Asignacion'] },
  { logico: 'asesorAsignado', etiqueta: 'Asesor Asignado', nivel: 'N2', ghl: ['Asesor Asignado'] },
  { logico: 'anotacionesRedes', etiqueta: 'Anotaciones Redes', nivel: 'N2', ghl: ['Anotaciones Redes'] },
  { logico: 'historialCompleto', etiqueta: 'Historial Completo', nivel: 'N2', ghl: ['Historial Completo'] },
  // --- Control y atribución ---
  { logico: 'tieneTelefono', etiqueta: 'Tiene Teléfono', nivel: 'ambos', ghl: ['Tiene Teléfono', 'Tiene Telefono'] },
  { logico: 'ultimaInteraccion', etiqueta: 'Ultima Interaccion', nivel: 'ambos', ghl: ['Ultima Interaccion', 'Ultima Interaccion (Fecha)'] },
  { logico: 'idAnuncio', etiqueta: 'ID de Anuncio', nivel: 'N1', ghl: ['ID de Anuncio', 'ID Anuncio'] },
  { logico: 'adIdAlt', etiqueta: 'Ad ID', nivel: 'N1', ghl: ['Ad ID'] },
  { logico: 'utmSource', etiqueta: 'UTM Source', nivel: 'N1', ghl: ['UTM Source'] },
  { logico: 'utmMedium', etiqueta: 'UTM Medium', nivel: 'N1', ghl: ['UTM Medium'] },
  { logico: 'utmContent', etiqueta: 'UTM Content', nivel: 'N1', ghl: ['UTM Content'] },
  { logico: 'utmTerm', etiqueta: 'UTM Term', nivel: 'N1', ghl: ['UTM Term'] },
  { logico: 'adsetId', etiqueta: 'Conjunto de Anuncios', nivel: 'N1', ghl: ['Conjunto de Anuncios', 'Adset ID'] },
  { logico: 'nombreAnuncio', etiqueta: 'Nombre del Anuncio', nivel: 'N1', ghl: ['Nombre del Anuncio'] },
  // --- Orden (Sales Bridge / Order History) ---
  { logico: 'estadoEntrega', etiqueta: 'Estado de Entrega', nivel: 'N2', ghl: ['Estado de Entrega'] },
  { logico: 'conformidad', etiqueta: 'Conformidad', nivel: 'N2', ghl: ['Conformidad'] },
  { logico: 'formaPago', etiqueta: 'Forma de Pago', nivel: 'N2', ghl: ['Forma de Pago'] },
  { logico: 'transportista', etiqueta: 'Transportista', nivel: 'N2', ghl: ['Transportista'] },
  { logico: 'tracking', etiqueta: 'Tracking', nivel: 'N2', ghl: ['Tracking'] },
  { logico: 'ultimoProducto', etiqueta: 'Ultimo Producto', nivel: 'N2', ghl: ['Ultimo Producto'] }
];

/** Familias de etiquetas y su etiqueta canónica esperada. */
export const FAMILIAS_TAG = [
  { familia: 'canal-', etiqueta: 'Canal', validas: CANALES_VALIDOS },
  { familia: 'prov-', etiqueta: 'Proveedor', validas: null },
  { familia: 'sede-', etiqueta: 'Sede', validas: SEDES_VALIDAS.map(s => `sede-${s.toLowerCase()}`) },
  { familia: 'pagina-', etiqueta: 'Página', validas: null },
  { familia: 'producto-', etiqueta: 'Producto', validas: null }
];

const RUIDO = /^(vtiger$|vtiger-sincronizado$|vtiger-status-|form$|organico$)/;
const CANAL_LEGADO = /^canal-(form|fb-msgr|wsp|fb|messenger-old)$/;

const vacio = v => v === undefined || v === null || String(v).trim() === '' || String(v).trim() === '--';

/**
 * Audita UNA subcuenta.
 *
 * @param {object} opts
 * @param {string} opts.sede          PALACIOS | BENAVIDES | ROOSEVELT | PIURA
 * @param {number} [opts.paginas=3]   páginas de 100 contactos a muestrear (máx. 20)
 * @param {number} [opts.maxMuestras=10] cuántos contactos concretos se listan como hueco
 */
export async function auditarContratoSede({ sede = 'PALACIOS', paginas = 3, maxMuestras = 10 } = {}) {
  const sedeId = String(sede).toUpperCase();
  const cfg = SEDES_GATEWAY[sedeId];
  const locId = cfg?.ghl?.locationId;
  const apiKey = cfg?.ghl?.apiKey;
  if (!locId || !apiKey) return { ok: false, sede: sedeId, reason: `sede ${sedeId} sin credenciales cargadas` };

  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', Accept: 'application/json' };
  const limite = Math.min(Math.max(parseInt(paginas, 10) || 3, 1), 20);

  // 1. Diccionario REAL de la subcuenta (id -> nombre).
  const mapa = await obtenerMapaCamposGhl(locId, headers);
  const camposExistentes = new Set([...mapa.porId.keys()]);

  // Resolver cada campo del contrato a su ID real (o marcarlo ausente).
  const resolucion = CAMPOS_CONTRATO.map(c => {
    let id = null;
    for (const nombre of c.ghl) {
      for (const [fid, fname] of mapa.porId.entries()) {
        if (normalizarNombreCampo(fname) === normalizarNombreCampo(nombre)) { id = fid; break; }
      }
      if (id) break;
    }
    return { ...c, id, existe: Boolean(id) };
  });

  // 2. Muestra de contactos (orden por defecto de GHL: los más recientes primero).
  const contactos = [];
  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=100`;
  for (let p = 0; p < limite && url; p++) {
    const res = await ghlFetch(url, { headers }, 1, 'Auditoria-Contrato');
    if (res.status !== 200) break;
    const d = await res.json();
    contactos.push(...(d.contacts || []));
    url = d?.meta?.nextPageUrl || null;
    await sleep(100);
  }
  const total = contactos.length;
  const pct = n => (total ? Math.round((n / total) * 1000) / 10 : 0);
  const pctDe = (n, base) => (base ? Math.round((n / base) * 1000) / 10 : 0);

  // [COHORTES] No se puede juzgar un campo comercial (fechas de compra, precio,
  // historial) sobre leads que todavía no compraron: daría un "hueco" falso. Se
  // separa la muestra en leads (Nivel 1) y compradores (Nivel 2).
  const idTotalCompras = resolucion.find(c => c.logico === 'totalCompras')?.id || null;
  const idEstadoCompra = resolucion.find(c => c.logico === 'estadoCompra')?.id || null;
  const esComprador = g => {
    const tags = (g.tags || []).map(t => String(t).toLowerCase());
    if (tags.includes('compro') || tags.includes('cliente-vtiger') || tags.includes('convertido')) return true;
    const cf = g.customFields || [];
    const totalCompras = cf.find(x => x.id === idTotalCompras)?.value;
    if (Number(String(totalCompras || '0').replace(/[^0-9.]/g, '')) > 0) return true;
    const estadoCompra = String(cf.find(x => x.id === idEstadoCompra)?.value || '').toLowerCase();
    return estadoCompra.includes('comprador') && !estadoCompra.includes('no comprador');
  };
  const compradores = contactos.filter(esComprador);
  const nCompradores = compradores.length;

  // 3. Cobertura de campos (global y, para los comerciales, solo compradores).
  const cobertura = resolucion.map(c => {
    if (!c.existe) return { logico: c.logico, etiqueta: c.etiqueta, nivel: c.nivel, existe: false, llenos: 0, pct: 0, llenosCompradores: 0, pctCompradores: 0 };
    let llenos = 0;
    let llenosCompradores = 0;
    for (const g of contactos) {
      const f = (g.customFields || []).find(x => x.id === c.id);
      const v = f?.value ?? f?.field_value;
      if (vacio(v)) continue;
      llenos++;
    }
    for (const g of compradores) {
      const f = (g.customFields || []).find(x => x.id === c.id);
      const v = f?.value ?? f?.field_value;
      if (!vacio(v)) llenosCompradores++;
    }
    // Un campo EXCLUSIVO del Nivel 2 se juzga sobre compradores; los de identidad
    // y atribución (N1 o compartidos) sobre toda la muestra. Así un lead que aún no
    // compró no cuenta como "hueco comercial".
    const base = c.nivel === 'N2' ? llenosCompradores : llenos;
    const baseN = c.nivel === 'N2' ? nCompradores : total;
    return {
      logico: c.logico, etiqueta: c.etiqueta, nivel: c.nivel, existe: true,
      llenos, pct: pct(llenos),
      llenosCompradores, pctCompradores: pctDe(llenosCompradores, nCompradores),
      cobertura: pctDe(base, baseN)
    };
  });

  // 4. Etiquetas.
  const fam = Object.fromEntries(FAMILIAS_TAG.map(f => [f.familia, 0]));
  const conflictos = { canal: [], prov: [], sede: [], producto: [] };
  const ruido = {};
  let sinTags = 0;
  const sinNinguna = [];

  for (const g of contactos) {
    const tags = (g.tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean);
    if (!tags.length) {
      sinTags++;
      if (sinNinguna.length < maxMuestras) sinNinguna.push({ id: g.id, nombre: `${g.firstName || ''} ${g.lastName || ''}`.trim(), fecha: g.dateUpdated || g.dateAdded });
    }
    for (const f of FAMILIAS_TAG) {
      const lista = [...new Set(tags.filter(t => t.startsWith(f.familia)))];
      if (lista.length) fam[f.familia]++;
      const clave = f.familia.replace('-', '');
      if (lista.length > 1 && conflictos[clave] && conflictos[clave].length < maxMuestras) {
        conflictos[clave].push({ id: g.id, tags: lista });
      }
    }
    for (const t of tags) {
      if (RUIDO.test(t) || CANAL_LEGADO.test(t)) ruido[t] = (ruido[t] || 0) + 1;
    }
  }

  const familias = Object.fromEntries(FAMILIAS_TAG.map(f => [f.familia, { n: fam[f.familia], pct: pct(fam[f.familia]) }]));

  // 5. Veredicto: DOS notas separadas (N1 / N2) y una global.
  const presentes = cobertura.filter(c => c.existe).length;
  const nucleoN1 = ['sedeAsignada', 'tratamientoComprado', 'proveedor', 'canalCaptacion', 'tieneTelefono'];
  const nucleoN2 = ['estadoComercial', 'totalCompras', 'fechaUltimaCompra', 'fechaPrimeraCompra', 'precioVenta', 'idCliente'];
  const media = lista => {
    const vals = lista.map(k => cobertura.find(c => c.logico === k)).filter(c => c && c.existe).map(c => c.cobertura);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };
  const saludN1Campos = media(nucleoN1);
  const saludN1Tags = Math.round((familias['canal-'].pct + familias['prov-'].pct + familias['sede-'].pct) / 3);
  const saludN1 = (saludN1Campos === null) ? saludN1Tags : Math.round((saludN1Campos + saludN1Tags) / 2);
  // El Nivel 2 se mide SIEMPRE sobre compradores (es su población objetivo).
  const mediaCompradores = lista => {
    if (nCompradores < 5) return null;
    const vals = lista.map(k => cobertura.find(c => c.logico === k)).filter(c => c && c.existe).map(c => c.pctCompradores);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };
  const saludN2 = mediaCompradores(nucleoN2);
  const notas = [saludN1, saludN2].filter(n => n !== null);
  const salud = notas.length ? Math.round(notas.reduce((a, b) => a + b, 0) / notas.length) : 0;

  return {
    ok: true,
    sede: sedeId,
    locationId: locId,
    contactosMuestreados: total,
    cohortes: { leads: total - nCompradores, compradores: nCompradores },
    camposEnDiccionario: camposExistentes.size,
    camposContrato: {
      total: CAMPOS_CONTRATO.length,
      existentes: presentes,
      ausentes: cobertura.filter(c => !c.existe).map(c => c.etiqueta)
    },
    coberturaCampos: cobertura,
    coberturaTags: familias,
    conflictos,
    etiquetasRuido: Object.entries(ruido).sort((a, b) => b[1] - a[1]).map(([tag, n]) => ({ tag, n, pct: pct(n) })),
    sinEtiquetas: { n: sinTags, pct: pct(sinTags), muestra: sinNinguna },
    saludN1,
    saludN2,
    saludContrato: salud,
    veredicto: salud >= 90 ? '🟢 CONTRATO SANO' : salud >= 70 ? '🟡 CONTRATO PARCIAL' : '🔴 CONTRATO ROTO'
  };
}

/**
 * Audita las 4 subcuentas activas y devuelve un consolidado.
 * @param {object} [opts] { paginas, sedes }
 */
export async function auditarContratoTodas({ paginas = 3, sedes = null } = {}) {
  const objetivo = (sedes && sedes.length ? sedes : getActiveSedes().map(s => s.sedeId))
    .map(s => String(s).toUpperCase())
    .filter(s => SEDES_VALIDAS.includes(s));

  const porSede = {};
  for (const sede of objetivo) {
    try {
      porSede[sede] = await auditarContratoSede({ sede, paginas });
    } catch (err) {
      porSede[sede] = { ok: false, sede, reason: err.message };
    }
  }

  const validas = Object.values(porSede).filter(r => r.ok);
  const salud = validas.length ? Math.round(validas.reduce((a, r) => a + r.saludContrato, 0) / validas.length) : 0;

  return {
    ok: true,
    generado: new Date().toISOString(),
    paginas,
    sedes: porSede,
    saludGlobal: salud,
    veredicto: salud >= 90 ? '🟢 CONTRATO SANO' : salud >= 70 ? '🟡 CONTRATO PARCIAL' : '🔴 CONTRATO ROTO'
  };
}
