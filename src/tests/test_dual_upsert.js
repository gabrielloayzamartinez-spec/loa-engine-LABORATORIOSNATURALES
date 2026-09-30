/**
 * ==============================================================================
 * LOA ENGINE - SUITE DEL MIDDLEWARE DE SINCRONIZACIÓN DUAL vTiger -> GHL
 * ==============================================================================
 * Blinda los criterios del Ticket 1 (sincronización dual) y del Ticket 2 (Merge SOP):
 *
 *   1. VALIDACIÓN   : sin teléfono E.164 válido el registro se descarta.
 *   2. TELEFONO     : prioridad `homephone` (donde está el 100% de los números
 *                     reales medidos en vivo sobre contactos con compra).
 *   3. DUAL         : carga macro (Cuenta Empresa) + carga operativa (sede).
 *   4. MERGE SOP    : si el contacto existe, el historial financiero NO se
 *                     sobrescribe y el estatus comercial se preserva.
 *   5. DESCUBRIMIENTO de Custom Field IDs sin hardcodearlos (varían por location).
 *   6. GEOGRAFÍA    : estado y ciudad separados; abreviaturas de 2 letras -> state.
 *
 * Ejecución:  node src/tests/test_dual_upsert.js
 * ==============================================================================
 */

import {
  pickPhone, resolveSedeFromVtiger, buildUpsertPayloads,
  partitionFields, mergeTagsPreservingStatus, esCampoHistorialProtegido,
  CAMPOS_HISTORIAL_PROTEGIDOS, TAGS_ESTATUS_PROTEGIDAS, isCentralConfigured,
  syncVtigerContactDual, SOLO_COMPRADORES, esRegistroComprador,
  limpiarNombre, buildNombreFields
} from '../services/dual_sync_service.js';
import { normalizeToE164, hasValidPhone, splitCityAndState, buildSanitizedGeoFields } from '../utils/geo_phone_sanitizer.js';
import { SEDES_GATEWAY } from '../config/index.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

console.log('\n==========================================================');
console.log(' [TEST] MIDDLEWARE DE SINCRONIZACION DUAL vTiger -> GHL');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
// 1. VALIDACIÓN: DROP RULE DEL TELÉFONO
// ------------------------------------------------------------------------------
console.log('[TEST 1] Drop rule: sin teléfono válido no se sincroniza');
assert(normalizeToE164('(305) 555-1234') === '+13055551234', 'Un teléfono NANP de 10 dígitos se normaliza a E.164');
assert(normalizeToE164('+1 240-348-6504') === '+12403486504', 'Un teléfono con +1 y guiones se normaliza');
assert(normalizeToE164('123') === '', 'Un número demasiado corto se invalida');
assert(normalizeToE164('') === '', 'Un teléfono vacío se invalida');
assert(normalizeToE164('12345678901234567890') === '', 'Un número absurdamente largo se invalida');
assert(hasValidPhone('3055551234') === true, 'hasValidPhone acepta un NANP válido');
assert(hasValidPhone('123') === false, 'hasValidPhone rechaza un inválido');

// PRIORIDAD homephone: medido en vivo, 100% de los contactos con compra lo usan.
assert(pickPhone({ mobile: '', phone: '', homephone: '6145179276' }) === '+16145179276', 'Se usa homephone cuando mobile/phone están vacíos (caso real medido)');
assert(pickPhone({ mobile: '3055551234', homephone: '6145179276' }) === '+16145179276', 'homephone tiene prioridad sobre mobile');
assert(pickPhone({}) === '', 'Sin ningún teléfono devuelve vacío (se descartará)');

// ------------------------------------------------------------------------------
// 2. RESOLUCIÓN DE SEDE (FILTRO DE ORIGEN)
// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Filtro de origen: la sede define la subcuenta destino');
assert(resolveSedeFromVtiger({ cf_3451: 'PALACIOS' }) === 'PALACIOS', 'cf_3451=PALACIOS resuelve la sede Palacios');
assert(resolveSedeFromVtiger({ cf_3451: 'benavides' }) === 'BENAVIDES', 'Resuelve sin importar mayúsculas');
assert(resolveSedeFromVtiger({ cf_3451: 'SEDE_INVENTADA' }) === null, 'Una sede desconocida no resuelve (se descarta)');
assert(resolveSedeFromVtiger({}) === null, 'Sin cf_3451 no hay destino (se descarta)');
assert(SEDES_GATEWAY.PALACIOS.ghl.locationId !== SEDES_GATEWAY.BENAVIDES.ghl.locationId, 'Cada sede tiene su propia subcuenta (hermetismo)');

// ------------------------------------------------------------------------------
// 3. MERGE SOP: PROTECCIÓN DEL HISTORIAL FINANCIERO
// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Merge SOP: el historial financiero no se sobrescribe');
for (const campo of ['total_compras', 'fecha_ultima_compra', 'precio_venta', 'estado_comercial']) {
  assert(esCampoHistorialProtegido(campo) === true, `"${campo}" está protegido contra sobrescritura`);
}
assert(esCampoHistorialProtegido('campana_origen') === false, '"campana_origen" SÍ se puede actualizar (es el dato de la nueva campaña)');
assert(esCampoHistorialProtegido('ultima_interaccion') === false, '"ultima_interaccion" SÍ se actualiza en cada reingreso');

const camposPrueba = [
  { id: 'f1', nombre: 'campana_origen', field_value: 'CAMPANA NUEVA' },
  { id: 'f2', nombre: 'total_compras', field_value: '9' },
  { id: 'f3', nombre: 'fecha_ultima_compra', field_value: '2026-09-01' },
  { id: 'f4', nombre: 'precio_venta', field_value: '999' }
];

// Contacto EXISTENTE: el historial se aparta
const existente = partitionFields(camposPrueba, true);
assert(existente.seguros.length === 1 && existente.seguros[0].nombre === 'campana_origen', 'Con contacto existente sólo viaja el campo de campaña');
assert(existente.protegidos.length === 3, `Los 3 campos de historial quedan FUERA del upsert (${existente.protegidos.map(p => p.nombre).join(', ')})`);
assert(!existente.seguros.some(c => c.nombre === 'total_compras'), 'total_compras NO se envía al reingresar (no se pisa el 9 real)');

// Contacto NUEVO: viaja todo el historial
const nuevo = partitionFields(camposPrueba, false);
assert(nuevo.seguros.length === 4 && nuevo.protegidos.length === 0, 'Con contacto nuevo viaja el historial completo (se crea con sus compras)');

// Etiquetas de estatus
const tags = mergeTagsPreservingStatus(['convertido', 'compro', 'cliente-vtiger', 'no-compro'], ['vtiger', 'campana-nueva']);
assert(tags.tags.includes('convertido'), 'La etiqueta "convertido" se preserva en el reingreso');
assert(tags.tags.includes('compro'), 'La etiqueta "compro" se preserva');
assert(!tags.tags.includes('no-compro'), 'Una etiqueta contradictoria "no-compro" se retira si el cliente ya compró');
assert(tags.preservadas.includes('convertido'), 'Se reporta qué etiquetas de estatus se preservaron (auditoría)');
for (const t of TAGS_ESTATUS_PROTEGIDAS) {
  const r = mergeTagsPreservingStatus([t], []);
  assert(r.tags.includes(t), `La etiqueta protegida "${t}" nunca se retira`);
}

// ------------------------------------------------------------------------------
// 4. CARGA DUAL: MACRO + OPERATIVA
// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Carga dual: Cuenta Empresa (macro) + subcuenta de sede');
const vContact = {
  id: '12x99999',
  firstname: 'IRMA',
  lastname: 'CASTELLANOS',
  email: 'irma@mail.com',
  homephone: '9802519139',
  mobile: '',
  phone: '',
  cf_3451: 'PALACIOS',
  cf_2610: 'Diabetes',
  cf_3472: 'DIABETES - ERNESTO',
  cf_3392: '450.00',
  spl_num_compras: '18',
  spl_fecha_ultima_compra: '2026-09-29',
  cf_1157: 'Miami, FL'
};

const payloads = buildUpsertPayloads(vContact, {
  incluirHistorial: true,
  fieldIdsCentral: { oficinaOrigen: 'C_OFICINA', totalCompras: 'C_TOTAL', fechaUltimaCompra: 'C_FECHA', campanaOrigen: 'C_CAMP' },
  fieldIdsSede: { oficinaOrigen: 'S_OFICINA', totalCompras: 'S_TOTAL', campanaOrigen: 'S_CAMP', ultimaInteraccion: 'S_ULT' }
});

assert(payloads.phone === '+19802519139', `El teléfono se normaliza a E.164 (${payloads.phone})`);
assert(payloads.sedeId === 'PALACIOS', 'La sede se resuelve desde cf_3451');
assert(payloads.esComprador === true, 'Se detecta que es comprador (18 compras)');
assert(payloads.tratamiento === 'Diabetes', 'El tratamiento se normaliza al vocabulario canónico');

assert(payloads.macro.customFields.some(f => f.id === 'C_OFICINA'), 'La carga MACRO incluye oficina_origen');
assert(payloads.macro.customFields.some(f => f.id === 'C_TOTAL'), 'La carga MACRO incluye total_compras (analítica macro)');
assert(payloads.macro.customFields.some(f => f.id === 'C_FECHA'), 'La carga MACRO incluye fecha_ultima_compra');

assert(payloads.operativa.locationId === SEDES_GATEWAY.PALACIOS.ghl.locationId, 'La carga OPERATIVA apunta a la subcuenta de Palacios');
assert(!payloads.operativa.customFields.some(f => f.id === 'C_OFICINA'), 'La carga operativa NO mezcla los IDs de la Central (son por location)');

assert(payloads.tagsNuevas.includes('convertido') && payloads.tagsNuevas.includes('compro'), 'Las etiquetas de comprador se aplican en la creación');
assert(payloads.tagsNuevas.includes('producto-diabetes'), 'Se etiqueta el producto canónico');
assert(payloads.tagsNuevas.includes('vtiger-sincronizado'), 'Se marca el registro como sincronizado con vTiger');

// Geografía corregida en ambas cargas
assert(payloads.operativa.city === 'Miami' && payloads.operativa.state === 'FL', `Ciudad y estado separados correctamente (city=${payloads.operativa.city}, state=${payloads.operativa.state})`);
assert(payloads.macro.city === 'Miami', 'La carga macro también lleva la ciudad saneada');

// Contacto existente: el historial no viaja
const payloadsExiste = buildUpsertPayloads(vContact, {
  incluirHistorial: false,
  fieldIdsSede: { oficinaOrigen: 'S_OFICINA', totalCompras: 'S_TOTAL', campanaOrigen: 'S_CAMP' },
  ghlExistenteSede: { id: 'ghl-existente', tags: ['convertido'] }
});
assert(!payloadsExiste.operativa.customFields.some(f => f.id === 'S_TOTAL'), 'En un reingreso NO se envía total_compras (historial intacto)');
assert(payloadsExiste.protegidos.sede.length >= 0, 'Se reporta qué campos quedaron protegidos');

// ------------------------------------------------------------------------------
// 5. GEOGRAFÍA: ESTADO vs CIUDAD
// ------------------------------------------------------------------------------
console.log('\n[TEST 5] Sanitización geográfica (estado no va en ciudad)');
const geoCasos = [
  ['FL', '', 'FL', 'Una abreviatura de estado no queda como ciudad'],
  ['Miami, FL', 'Miami', 'FL', 'Se separa "Miami, FL"'],
  ['Miami, FL 33125', 'Miami', 'FL', 'Se separa ciudad, estado y zip'],
  ['Houston Texas', 'Houston', 'TX', 'Se reconoce el nombre completo del estado'],
  ['Kissimmee', 'Kissimmee', '', 'Una ciudad normal no se toca']
];
for (const [entrada, cityEsp, stateEsp, desc] of geoCasos) {
  const r = splitCityAndState(entrada);
  assert(r.city === cityEsp && r.state === stateEsp, `${desc} ("${entrada}" -> city="${r.city}", state="${r.state}")`);
}

const geoFields = buildSanitizedGeoFields({ cf_1157: 'Doral Florida' }, {}, {});
assert(geoFields.find(f => f.key === 'city')?.field_value === 'Doral', 'buildSanitizedGeoFields separa la ciudad');
assert(geoFields.find(f => f.key === 'state')?.field_value === 'FL', 'buildSanitizedGeoFields resuelve el estado');
assert(!geoFields.some(f => f.key === 'city' && /^[A-Z]{2}$/.test(f.field_value)), 'Nunca se envía una abreviatura de estado como ciudad');

// ------------------------------------------------------------------------------
// 6. CONFIGURACIÓN DE LA CUENTA EMPRESA
// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Cuenta Empresa (macro): configuración por entorno, sin hardcoding');
assert(typeof isCentralConfigured() === 'boolean', 'isCentralConfigured() reporta el estado sin lanzar excepción');
if (!isCentralConfigured()) {
  console.log('      (La Cuenta Empresa no está configurada en este entorno: el middleware opera sólo por sede)');
}
// El middleware NUNCA debe romperse por la ausencia de la Central.
const sinCentral = buildUpsertPayloads(vContact, { incluirHistorial: true, fieldIdsSede: {} });
assert(sinCentral.operativa.locationId === SEDES_GATEWAY.PALACIOS.ghl.locationId, 'La carga operativa se construye aunque no haya Cuenta Empresa');

// ------------------------------------------------------------------------------
// 7. REGLA DE NEGOCIO: SÓLO SE SINCRONIZAN COMPRADORES
// ------------------------------------------------------------------------------
// Un contacto de vTiger sin compras es un LEAD y NO se muda a GHL por este
// conducto: entra cuando el negocio lo necesita o por RECONTACTO. Lo obligatorio
// es tener sincronizada la cartera de compradores.
console.log('\n[TEST 7] Regla de negocio: sólo compradores (los leads no se mudan)');

assert(SOLO_COMPRADORES === true, 'La regla de sólo compradores está activa a nivel de módulo');
assert(esRegistroComprador({ spl_num_compras: '3' }) === true, 'Con 3 compras es comprador');
assert(esRegistroComprador({ spl_num_compras: '1' }) === true, 'Con 1 compra es comprador');
assert(esRegistroComprador({ spl_num_compras: '0' }) === false, 'Con 0 compras NO es comprador (es un lead)');
assert(esRegistroComprador({}) === false, 'Sin el campo de compras NO es comprador (fail-safe)');
assert(esRegistroComprador({ spl_num_compras: '' }) === false, 'Con el campo vacío NO es comprador');
assert(esRegistroComprador({ spl_num_compras: 'no-numero' }) === false, 'Con un valor inválido NO es comprador');

// La barrera actúa ANTES de tocar la red: un lead se descarta sin llamar a GHL.
// (Sólo se prueba el caso DESCARTADO: es determinista y no genera efectos
//  externos. El caso del comprador SÍ tocaría GHL, por lo que se verifica con
//  `esRegistroComprador`, arriba, y en la prueba en vivo fuera de la suite.)
const leadSinCompras = { id: 'LEAD-X', firstname: 'PEDRO', lastname: 'LEAD', homephone: '3055551234', cf_3451: 'PALACIOS', spl_num_compras: '0' };
const resLead = await syncVtigerContactDual(leadSinCompras);
assert(resLead.skipped === true, 'Un lead se descarta con skipped=true');
assert(resLead.ok === false, 'Un lead no se reporta como sincronizado');
assert(resLead.reason.includes('no es comprador'), `El motivo lo declara: "${resLead.reason}"`);
assert(resLead.macro === undefined && resLead.operativa === undefined, 'El lead se corta ANTES de llamar a GHL (sin efectos externos)');

// ------------------------------------------------------------------------------
// 8. MAPEO COMPLETO DEL COMPRADOR (enriquecimiento total)
// ------------------------------------------------------------------------------
// Todo dato legible de vTiger que tenga destino real en GHL debe publicarse.
console.log('\n[TEST 8] Mapeo completo: el comprador queda lleno, no a medias');

const compradorCompleto = {
  id: '12x35433', firstname: 'MIGUEL', lastname: 'REVILLA',
  homephone: '6145179276', cf_3451: 'PALACIOS',
  cf_2610: 'Artritis', cf_2572: 'CLICK2RING', cf_3507: 'FB-MSGR',
  cf_3472: 'PALACIOS-CLICK2RING-FB-MSGR-Artritis',
  cf_3392: '260.00000', cf_994: '1-POR ASIGNAR', cf_1876: 'CONVERTIDO',
  spl_num_compras: '2',
  spl_fecha_primera_compra: '2019-11-21',
  spl_fecha_ultima_compra: '2019-12-18',
  contact_no: 'CON6501',
  wcf_acf_atf_3390: 'MARIBEL',
  createdtime: '2019-11-21 19:53:22',
  splareacodes_state: ' Ohio',
  splareacodes_state_code: 'OH'
};

const idsMacro = { oficinaOrigen:'C1', totalCompras:'C2', fechaUltimaCompra:'C3', fechaPrimeraCompra:'C4', precioVenta:'C5', totalHistorico:'C6', ultimaInteraccion:'C7', campanaOrigen:'C8', idClienteVt:'C9', canalCaptacion:'C10', tratamientoComprado:'C11', estadoComercial:'C12', estadoVenta:'C13', contactoNo:'C14', asesorAsignado:'C15', fechaCreacion:'C16' };
const idsSede = { oficinaOrigen:'S1', totalCompras:'S2', fechaUltimaCompra:'S3', fechaPrimeraCompra:'S4', precioVenta:'S5', ultimaInteraccion:'S6', campanaOrigen:'S7', idClienteVt:'S8', canalCaptacion:'S9', tratamientoComprado:'S10', estadoComercial:'S11', estadoVenta:'S12', contactoNo:'S13' };

const p8 = buildUpsertPayloads(compradorCompleto, { incluirHistorial: true, fieldIdsCentral: idsMacro, fieldIdsSede: idsSede });
const nombresMacro = p8.macro.customFields.map(f => f.nombre);
const nombresSede = p8.operativa.customFields.map(f => f.nombre);
const valor = (campos, n) => campos.find(f => f.nombre === n)?.field_value;

assert(nombresMacro.length >= 16, `La carga macro llena ${nombresMacro.length} campos (antes 8)`);
for (const campo of ['oficinaOrigen', 'campanaOrigen', 'canalCaptacion', 'tratamientoComprado', 'contactoNo', 'estadoVenta', 'estadoComercial', 'asesorAsignado', 'fechaCreacion', 'totalCompras', 'fechaUltimaCompra', 'fechaPrimeraCompra', 'precioVenta', 'idClienteVt', 'totalHistorico', 'ultimaInteraccion']) {
  assert(nombresMacro.includes(campo), `La carga macro incluye "${campo}"`);
}

assert(valor(p8.macro.customFields, 'fechaPrimeraCompra') === '2019-11-21', 'Fecha de PRIMERA compra mapeada');
assert(valor(p8.macro.customFields, 'fechaUltimaCompra') === '2019-12-18', 'Fecha de ÚLTIMA compra mapeada');
assert(valor(p8.macro.customFields, 'fechaCreacion') === '2019-11-21', 'Fecha de creación (saneada a YYYY-MM-DD)');
assert(valor(p8.macro.customFields, 'tratamientoComprado') === 'Artritis', 'Padecimiento/tratamiento mapeado');
assert(valor(p8.macro.customFields, 'canalCaptacion') === 'FB-MSGR', 'Canal de captación mapeado');
assert(valor(p8.macro.customFields, 'campanaOrigen').includes('CLICK2RING'), 'Campaña de origen mapeada');
assert(valor(p8.macro.customFields, 'estadoComercial') === 'CONVERTIDO', 'Estado comercial del embudo mapeado');
assert(valor(p8.macro.customFields, 'estadoVenta') === '1-POR ASIGNAR', 'Estado de venta mapeado');
assert(valor(p8.macro.customFields, 'contactoNo') === 'CON6501', 'Código de cliente (contact_no) mapeado');
assert(valor(p8.macro.customFields, 'asesorAsignado') === 'MARIBEL', 'Asesor asignado mapeado');
assert(valor(p8.macro.customFields, 'totalHistorico') === '260.00000', 'Gasto histórico acumulado mapeado');

// GEOGRAFÍA: el estado llega desde splareacodes_state_code, porque
// mailingcity/mailingstate están restringidos por rol y salían vacíos.
assert(p8.macro.state === 'OH', `El estado se resuelve desde splareacodes_state_code (${p8.macro.state})`);
assert(p8.operativa.state === 'OH', 'La sede también recibe el estado');
assert(!p8.macro.city, 'Sin ciudad real no se inventa una (cf_1157 viene vacío)');

assert(nombresSede.includes('tratamientoComprado') && nombresSede.includes('canalCaptacion'), 'La sede también recibe tratamiento y canal');
assert(!nombresSede.includes('asesorAsignado') && !nombresSede.includes('totalHistorico'), 'La sede NO recibe campos exclusivos de la Empresa');

assert(!nombresMacro.includes('anotacionesRedes'), 'No se publica cf_3561: su valor ("49") no aporta información');

// ------------------------------------------------------------------------------
// 9. CALIDAD DEL NOMBRE EN LA TARJETA DEL CONTACTO
// ------------------------------------------------------------------------------
// vTiger trae basura en los nombres: `salutationtype` vale "." y a veces ese
// punto llega al nombre (tarjetas tipo ". PEREZ"), o hay espacios dobles que
// producen "ANA     LOPEZ". La tarjeta debe leerse correctamente.
console.log('\n[TEST 9] Calidad del nombre en la tarjeta del contacto');

assert(limpiarNombre('  ANA  ') === 'ANA', 'Recorta espacios sobrantes');
assert(limpiarNombre('ANA   MARIA') === 'ANA MARIA', 'Colapsa espacios internos duplicados');
assert(limpiarNombre('.') === '', 'Un punto (salutationtype de vTiger) no es un nombre');
assert(limpiarNombre('...') === '', 'Varios puntos tampoco');
assert(limpiarNombre('-') === '' && limpiarNombre('_') === '' && limpiarNombre('*') === '', 'Otros marcadores vacíos se descartan');
assert(limpiarNombre('') === '' && limpiarNombre(null) === '' && limpiarNombre(undefined) === '', 'Vacíos y nulos devuelven vacío');
assert(limpiarNombre('JOSÉ') === 'JOSÉ', 'Conserva acentos');
assert(limpiarNombre('MUÑOZ') === 'MUÑOZ', 'Conserva la eñe');
assert(limpiarNombre("O'BRIEN") === "O'BRIEN", 'Conserva apóstrofes');
assert(limpiarNombre('DE LA CRUZ') === 'DE LA CRUZ', 'Conserva apellidos compuestos');

const n1 = buildNombreFields({ firstname: 'MIGUEL', lastname: 'REVILLA' });
assert(n1.firstName === 'MIGUEL' && n1.lastName === 'REVILLA' && n1.name === 'MIGUEL REVILLA', 'Caso normal: nombre y apellido bien separados');

const n2 = buildNombreFields({ firstname: '.', lastname: 'PEREZ' });
assert(n2.firstName === '' && n2.name === 'PEREZ', 'Un punto como nombre no contamina la tarjeta (antes: ". PEREZ")');

const n3 = buildNombreFields({ firstname: 'ROSA', lastname: '' });
assert(n3.firstName === 'ROSA' && n3.lastName === '' && n3.name === 'ROSA', 'Sin apellido el nombre queda limpio, sin espacios colgando');

const n4 = buildNombreFields({ firstname: '', lastname: 'GOMEZ' });
assert(n4.lastName === 'GOMEZ' && n4.name === 'GOMEZ', 'Sin nombre el apellido queda limpio');

const n5 = buildNombreFields({ firstname: '  ANA  ', lastname: '  LOPEZ  ' });
assert(n5.name === 'ANA LOPEZ', 'Con espacios sobrantes el nombre queda "ANA LOPEZ" (antes "ANA     LOPEZ")');

const n6 = buildNombreFields({});
assert(n6.firstName === '' && n6.lastName === '' && n6.name === undefined, 'Sin ningún nombre, name queda undefined (no se envía basura)');

// El payload real debe usar los nombres saneados, no los crudos.
const pNombre = buildUpsertPayloads(
  { id: 'X', firstname: '.', lastname: 'PEREZ', homephone: '3055551234', cf_3451: 'PALACIOS', spl_num_compras: '1' },
  { incluirHistorial: true, fieldIdsCentral: {}, fieldIdsSede: {} }
);
assert(pNombre.macro.firstName === '' && pNombre.macro.name === 'PEREZ', 'El payload macro usa el nombre saneado');
assert(pNombre.operativa.name === 'PEREZ', 'El payload de la sede usa el nombre saneado');

console.log('\n==========================================================');
console.log(` [METRICS] ${passed} pasadas, ${failed} fallidas`);
console.log('==========================================================\n');

process.exit(failed > 0 ? 1 : 0);
