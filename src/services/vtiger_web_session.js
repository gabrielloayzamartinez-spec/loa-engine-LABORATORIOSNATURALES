/**
 * ==============================================================================
 * LOA ENGINE - SESION WEB DE VTIGER (DESCARGA DEL PDF OFICIAL DE FACTURA)
 * ==============================================================================
 * POR QUE EXISTE UN CANAL WEB APARTE:
 *   El PDF de la factura NO viaja dentro del registro (comprobado: `Invoice` no
 *   es legible por API y no tiene campo de archivo) ni se puede bajar por la
 *   Webservice API (allow-list `query/getchallenge/login`). El PDF lo genera la
 *   UI de vTiger en la accion `ExportPDF`, detras de una SESION WEB (usuario +
 *   contrasena). Este modulo implementa ese unico canal, aislado del resto.
 *
 * CANDADO DE SOLO LECTURA (se mantiene y se EXTIENDE a este canal):
 *   - El UNICO POST permitido es el handshake de login (`action=Login`).
 *   - La allow-list de acciones web es CERRADA: `Login`, `ExportPDF`, `Detail`,
 *     `index`. `Save`, `Edit`, `Delete`, `MassEdit`, `Import`... se rechazan
 *     ANTES de tocar la red (misma filosofia que `vtigerClient.js`).
 *   - LOA Engine NO escribe, NO modifica y NO inyecta datos en vTiger. JAMAS.
 *
 * DISENO PARA PRUEBAS: toda la red entra por `fetchImpl` (por defecto `fetch`
 * global). Asi la mecanica completa (CSRF, cookies, sesion, descarga) se prueba
 * con un doble de prueba, sin tocar vTiger ni depender de credenciales.
 *
 * VARIABLES DE ENTORNO (nombres): VTIGER_URL, VTIGER_WEB_USERNAME,
 * VTIGER_WEB_PASSWORD, VTIGER_WEB_SESSION_TTL_MS (opcional).
 * ==============================================================================
 */

import { readSecret, envInt } from '../config/secrets.js';

/** Acciones web de vTiger permitidas (allow-list CERRADA, no deny-list). */
export const ACCIONES_WEB_PERMITIDAS = ['login', 'exportpdf', 'detail', 'index'];

/** Excepcion de violacion del candado de solo lectura en el canal web. */
export class VtigerWebActionViolation extends Error {
  constructor(accion) {
    super(`Accion web '${accion}' prohibida: LOA Engine solo LEE de vTiger (allow-list: ${ACCIONES_WEB_PERMITIDAS.join(', ')}).`);
    this.name = 'VtigerWebActionViolation';
    this.code = 'VTIGER_WEB_READ_ONLY_VIOLATION';
    this.accion = accion;
  }
}

/** Error de configuracion o de sesion web. */
export class VtigerWebSessionError extends Error {
  constructor(message, { code = 'VTIGER_WEB_ERROR', status = null } = {}) {
    super(message);
    this.name = 'VtigerWebSessionError';
    this.code = code;
    this.status = status;
  }
}

// ------------------------------------------------------------------------------
// 1. CANDADO: acciones web permitidas
// ------------------------------------------------------------------------------
export function assertAccionWebPermitida(accion = '') {
  const a = String(accion).toLowerCase().trim();
  if (!ACCIONES_WEB_PERMITIDAS.includes(a)) throw new VtigerWebActionViolation(accion);
  return true;
}

// ------------------------------------------------------------------------------
// 2. PARSERS PUROS (aqui es donde estas integraciones suelen romperse)
// ------------------------------------------------------------------------------

/** Extrae action/method y los campos ocultos del formulario de login. */
export function extraerDatosFormularioLogin(html = '') {
  const fuente = String(html);

  // El formulario de login es el que contiene el input de contrasena.
  const formularios = [...fuente.matchAll(/<form[^>]*>[\s\S]*?<\/form>/gi)].map(m => m[0]);
  const formLogin = formularios.find(f => /name=["']password["']/i.test(f)) || '';

  const action = (/action=["']([^"']+)["']/i.exec(formLogin) || [])[1] || 'index.php';
  const method = ((/method=["']([^"']+)["']/i.exec(formLogin) || [])[1] || 'POST').toUpperCase();

  const ocultos = {};
  for (const tag of formLogin.matchAll(/<input[^>]*>/gi)) {
    const t = tag[0];
    const nombre = (/name=["']([^"']+)["']/i.exec(t) || [])[1];
    const tipo = ((/type=["']([^"']+)["']/i.exec(t) || [])[1] || 'text').toLowerCase();
    const valor = (/value=["']([^"']*)["']/i.exec(t) || [])[1] || '';
    if (nombre && tipo === 'hidden') ocultos[nombre] = valor;
  }

  return { action, method, ocultos, tieneFormulario: Boolean(formLogin) };
}

/** True si el HTML es la pantalla de login (sesion ausente o expirada). */
export function esPantallaDeLogin(html = '') {
  const fuente = String(html);
  return /<input[^>]*type=["']password["']/i.test(fuente) || /<input[^>]*name=["']password["']/i.test(fuente);
}

/** Extrae los `Set-Cookie` de una respuesta (solo pares nombre=valor). */
export function extraerSetCookie(res) {
  const bruto = typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pares = [];
  for (const c of bruto) {
    const par = String(c).split(';')[0];
    const i = par.indexOf('=');
    if (i > 0) pares.push([par.slice(0, i).trim(), par.slice(i + 1).trim()]);
  }
  return pares;
}

/** Aplica los Set-Cookie de una respuesta sobre el jar (Map). */
export function aplicarCookies(jar, res) {
  for (const [k, v] of extraerSetCookie(res)) {
    if (v) jar.set(k, v);
    else jar.delete(k);
  }
  return jar;
}

/** Cabecera `Cookie` a partir del jar. Devuelve '' si esta vacio. */
export function construirCabeceraCookie(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Descubre los `folderid` de las plantillas PDF disponibles en una vista. */
export function extraerFolderIdsPdf(html = '') {
  return [...new Set([...String(html).matchAll(/folderid=(\d+)/gi)].map(m => m[1]))];
}

/** Valida los bytes magicos de un PDF. */
export function esPdf(buf) {
  if (!buf) return false;
  const cabecera = Buffer.isBuffer(buf) ? buf.slice(0, 5).toString('latin1') : String(buf).slice(0, 5);
  return cabecera === '%PDF-';
}

/** Estado de configuracion del canal web, SIN lanzar excepcion (fail-safe). */
export function getVtigerWebConfigStatus() {
  const url = readSecret('VTIGER_URL');
  const usuario = readSecret('VTIGER_WEB_USERNAME');
  const clave = readSecret('VTIGER_WEB_PASSWORD');
  const faltantes = [];
  if (!url) faltantes.push('VTIGER_URL');
  if (!usuario) faltantes.push('VTIGER_WEB_USERNAME');
  if (!clave) faltantes.push('VTIGER_WEB_PASSWORD');
  return { configurado: faltantes.length === 0, faltantes, urlHost: url ? String(url).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null };
}

// ------------------------------------------------------------------------------
// 3. CLIENTE DE SESION WEB
// ------------------------------------------------------------------------------
const TTL_SESION_WEB_MS = Math.min(Math.max(envInt('VTIGER_WEB_SESSION_TTL_MS', 20 * 60 * 1000), 60 * 1000), 4 * 60 * 60 * 1000);

/**
 * Crea un cliente de sesion web de vTiger.
 *
 * La sesion se cachea y se renueva sola: el motor NO debe loguearse por cada
 * factura (seria un POST por orden y un riesgo de bloqueo por parte de vTiger).
 *
 * @param {object}   [opts]
 * @param {string}   [opts.baseUrl]   Por defecto VTIGER_URL.
 * @param {string}   [opts.username]  Por defecto VTIGER_WEB_USERNAME.
 * @param {string}   [opts.password]  Por defecto VTIGER_WEB_PASSWORD.
 * @param {Function} [opts.fetchImpl] Inyectable para pruebas.
 * @param {number}   [opts.ttlMs]     Vida de la sesion cacheada.
 */
export function crearClienteSesionWeb(opts = {}) {
  const baseUrl = String(opts.baseUrl || readSecret('VTIGER_URL') || '').replace(/\/+$/, '');
  const username = opts.username || readSecret('VTIGER_WEB_USERNAME') || '';
  const password = opts.password || readSecret('VTIGER_WEB_PASSWORD') || '';
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const ttlMs = opts.ttlMs || TTL_SESION_WEB_MS;

  const jar = new Map();
  let expiraEn = 0;
  let enVuelo = null; // single-flight: N llamadas concurrentes = 1 solo login

  function cookiesVigentes() {
    return jar.size > 0 && Date.now() < expiraEn;
  }

  async function hacerLogin() {
    assertAccionWebPermitida('Login');

    if (!baseUrl || !username || !password) {
      throw new VtigerWebSessionError(
        `Credenciales web de vTiger incompletas (${getVtigerWebConfigStatus().faltantes.join(', ')}).`,
        { code: 'WEB_CREDENTIALS_MISSING' }
      );
    }

    // 1) GET del formulario: entrega la cookie de sesion y el token CSRF.
    const resLogin = await fetchImpl(`${baseUrl}/index.php?module=Users&action=Login`, { redirect: 'follow' });
    const html = await resLogin.text();
    aplicarCookies(jar, resLogin);

    const { action, method, ocultos } = extraerDatosFormularioLogin(html);
    if (!ocultos.__vtrftk) {
      throw new VtigerWebSessionError('No se obtuvo el token CSRF (__vtrftk) del formulario de login.', { code: 'WEB_CSRF_MISSING', status: resLogin.status });
    }

    // 2) POST del login (UNICO POST permitido en todo el canal web).
    const cuerpo = new URLSearchParams();
    cuerpo.set('__vtrftk', ocultos.__vtrftk);
    cuerpo.set('module', ocultos.module || 'Users');
    cuerpo.set('action', ocultos.action || 'Login');
    cuerpo.set('username', username);
    cuerpo.set('password', password);

    const destino = action.startsWith('http') ? action : `${baseUrl}/${action.replace(/^\/+/, '')}`;
    const resPost = await fetchImpl(destino, {
      method,
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: construirCabeceraCookie(jar),
        Referer: `${baseUrl}/index.php?module=Users&action=Login`
      },
      body: cuerpo.toString()
    });
    aplicarCookies(jar, resPost);

    // 3) Verificacion real de sesion: una pagina interna no debe ser el login.
    const resHome = await fetchImpl(`${baseUrl}/index.php?module=Home&action=index`, {
      headers: { Cookie: construirCabeceraCookie(jar) },
      redirect: 'follow'
    });
    const htmlHome = await resHome.text();
    aplicarCookies(jar, resHome);

    if (esPantallaDeLogin(htmlHome)) {
      throw new VtigerWebSessionError(
        'El login web de vTiger no prospero (usuario/contrasena web incorrectos o rol sin acceso web).',
        { code: 'WEB_LOGIN_REJECTED', status: resPost.status }
      );
    }

    expiraEn = Date.now() + ttlMs;
    return true;
  }

  /** Garantiza una sesion web valida (cacheada, single-flight). */
  async function asegurarSesion() {
    if (cookiesVigentes()) return true;
    if (enVuelo) return enVuelo;
    enVuelo = hacerLogin().finally(() => { enVuelo = null; });
    return enVuelo;
  }

  /** GET autenticado con la sesion web. Solo acciones de la allow-list. */
  async function getWeb(pathODestino, { accion } = {}) {
    if (accion) assertAccionWebPermitida(accion);
    await asegurarSesion();

    const destino = String(pathODestino).startsWith('http') ? String(pathODestino) : `${baseUrl}/${String(pathODestino).replace(/^\/+/, '')}`;
    const res = await fetchImpl(destino, {
      headers: { Cookie: construirCabeceraCookie(jar) },
      redirect: 'follow'
    });
    aplicarCookies(jar, res);

    const buf = Buffer.from(await res.arrayBuffer());

    // Sesion caida a mitad de camino: se renueva UNA vez y se reintenta.
    if (esPantallaDeLogin(buf.toString('latin1'))) {
      expiraEn = 0;
      await asegurarSesion();
      const res2 = await fetchImpl(destino, {
        headers: { Cookie: construirCabeceraCookie(jar) },
        redirect: 'follow'
      });
      aplicarCookies(jar, res2);
      return { status: res2.status, buf: Buffer.from(await res2.arrayBuffer()) };
    }

    return { status: res.status, buf };
  }

  /** Descubre los folderid de plantillas PDF de un registro concreto. */
  async function descubrirFolderIds({ record, modulo = 'SalesOrder' } = {}) {
    const { buf } = await getWeb(`index.php?module=${modulo}&view=Detail&record=${encodeURIComponent(record)}`, { accion: 'Detail' });
    return extraerFolderIdsPdf(buf.toString('utf8'));
  }

  /**
   * Descarga el PDF oficial de un registro.
   * @returns {{ ok: boolean, buf: Buffer|null, status: number, folderId: string|null }}
   */
  async function descargarPdf({ record, modulo = 'SalesOrder', folderId = null } = {}) {
    assertAccionWebPermitida('ExportPDF');
    const base = `index.php?module=${modulo}&action=ExportPDF&record=${encodeURIComponent(record)}`;
    const intentos = folderId ? [`${base}&folderid=${encodeURIComponent(folderId)}`] : [base];
    let ultimoStatus = 0;

    for (const destino of intentos) {
      const { status, buf } = await getWeb(destino, { accion: 'ExportPDF' });
      if (esPdf(buf)) return { ok: true, buf, status, folderId };
      ultimoStatus = status;
    }
    return { ok: false, buf: null, status: ultimoStatus, folderId: null };
  }

  /** Lista de folderid probados (util para el probe y la observabilidad). */
  async function descargarPdfAuto({ record, modulo = 'SalesOrder' } = {}) {
    assertAccionWebPermitida('ExportPDF');
    const folders = await descubrirFolderIds({ record, modulo });
    const candidatos = [...folders.map(f => ({ folderId: f })), { folderId: null }];

    for (const c of candidatos) {
      const r = await descargarPdf({ record, modulo, folderId: c.folderId });
      if (r.ok) return { ...r, intentos: candidatos.length };
    }
    return { ok: false, buf: null, status: 0, folderId: null, intentos: candidatos.length };
  }

  return {
    asegurarSesion,
    getWeb,
    descubrirFolderIds,
    descargarPdf,
    descargarPdfAuto,
    sesionVigente: cookiesVigentes,
    cookieHeader: () => construirCabeceraCookie(jar),
    cerrar: () => { jar.clear(); expiraEn = 0; }
  };
}
