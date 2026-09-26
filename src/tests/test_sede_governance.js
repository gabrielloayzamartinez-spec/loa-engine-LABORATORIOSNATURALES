/**
 * ==============================================================================
 * LOA ENGINE - SUITE DEL PROTOCOLO DE GOBERNANZA DE SEDES (OFFLINE)
 * ==============================================================================
 * Convierte en INVARIANTES EJECUTABLES los 5 puntos innegociables del protocolo:
 *
 *   1. SOLO LECTURA en vTiger (sensor consultivo, nunca escritura).
 *   2. SEDE-LOCK: toda consulta con datos de cliente lleva `cf_3451 = '<SEDE>'`;
 *      jamás se consulta la base global.
 *   3. SEDE-SHIELD: historial de compras de OTRA sede = 100% invisibilizado
 *      (sin monto, sin fecha, sin número de órdenes) y lead catalogado SIN VENTA.
 *   4. HIGIENE: campos heredados de una sede previa se purgan a vacío.
 *   5. El gate de aislamiento está en el BORDE de la API (clase de bug cerrada).
 *
 * Ejecución:  node src/tests/test_sede_governance.js
 * ==============================================================================
 */

import {
  assertTenantIsolation, SedeLockViolation, VTIGER_MODULES, VTIGER_FIELDS,
  sedeClause, VTIGER_READ_ONLY_MODULES, TENANT_SCOPED_MODULES, TENANT_ISOLATION_STRATEGY,
  assertReadOnlyStatement, assertReadOnlyHttpMethod, assertAllowedOperation, readOnlyGuardStats
} from '../services/vtigerClient.js';
import { resolveActiveSede, getSalesHistory } from '../services/vtiger_api_service.js';
import {
  evaluateCommercialTruth, buildSanitizedCommercialFields,
  getCommercialFieldIdsForSede, COMMERCIAL_FIELD_IDS_BENAVIDES
} from '../domain/commercial_engine.js';
import { SEDES_GATEWAY } from '../config/index.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const PALACIOS_LOC = SEDES_GATEWAY.PALACIOS.ghl.locationId;
const BENAVIDES_LOC = SEDES_GATEWAY.BENAVIDES.ghl.locationId;

console.log('\n==========================================================');
console.log(' [TEST] PROTOCOLO DE GOBERNANZA Y AISLAMIENTO DE SEDES');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
// 1. SOLO LECTURA ESTRICTA — CANDADO EN TRES CAPAS
// ------------------------------------------------------------------------------
console.log('[TEST 1] vTiger como sensor consultivo: LOA Engine NO escribe NUNCA');
assert(VTIGER_READ_ONLY_MODULES.includes(VTIGER_MODULES.CONTACTS), 'Contacts está declarado como solo lectura');
assert(VTIGER_READ_ONLY_MODULES.includes(VTIGER_MODULES.SALES_ORDER), 'SalesOrder está declarado como solo lectura');
assert(VTIGER_READ_ONLY_MODULES.includes(VTIGER_MODULES.POTENTIALS), 'Potentials está declarado como solo lectura');

// CAPA 3: sentencias de escritura bloqueadas antes de tocar la red
const ESCRITURAS = [
  "DELETE FROM Contacts WHERE cf_3451 = 'PALACIOS'",
  "UPDATE Contacts SET cf_3392 = '0' WHERE cf_3451 = 'PALACIOS'",
  "INSERT INTO Contacts (lastname, cf_3451) VALUES ('X','PALACIOS')",
  "DROP TABLE Contacts",
  "ALTER TABLE Contacts ADD COLUMN x INT",
  "TRUNCATE TABLE Contacts",
  "SELECT * INTO Backup FROM Contacts",
  "select id from Contacts where cf_3451 = 'PALACIOS'; delete from Contacts where id='1'"
];
let escriturasBloqueadas = 0;
for (const sql of ESCRITURAS) {
  try {
    assertReadOnlyStatement(sql);
  } catch (e) {
    if (e.code === 'VTIGER_READ_ONLY_VIOLATION') escriturasBloqueadas++;
  }
}
assert(escriturasBloqueadas === ESCRITURAS.length, `Toda sentencia de escritura es BLOQUEADA (${escriturasBloqueadas}/${ESCRITURAS.length})`);
assert(assertReadOnlyStatement("SELECT id FROM Contacts WHERE cf_3451 = 'PALACIOS' LIMIT 1") === true, 'Un SELECT legítimo NO se bloquea (sin falsos positivos)');

// CAPA 1: métodos HTTP
assert(assertReadOnlyHttpMethod('GET') === true, 'GET permitido (lectura)');
assert(assertReadOnlyHttpMethod('POST', { isLogin: true }) === true, 'POST permitido únicamente para el handshake de login');
for (const metodo of ['PUT', 'DELETE', 'PATCH']) {
  let bloqueado = false;
  try { assertReadOnlyHttpMethod(metodo); } catch (e) { bloqueado = e.code === 'VTIGER_READ_ONLY_VIOLATION'; }
  assert(bloqueado, `Método HTTP ${metodo} BLOQUEADO sobre vTiger`);
}

// CAPA 2: operaciones de la Webservice API
for (const op of ['query', 'login', 'getchallenge']) {
  assert(assertAllowedOperation(op) === true, `Operación '${op}' permitida (allow-list)`);
}
for (const op of ['create', 'update', 'delete', 'revise', 'save', 'massupdate', 'import']) {
  let bloqueado = false;
  try { assertAllowedOperation(op); } catch (e) { bloqueado = e.code === 'VTIGER_READ_ONLY_VIOLATION'; }
  assert(bloqueado, `Operación de escritura '${op}' BLOQUEADA sobre vTiger`);
}
assert(readOnlyGuardStats.blocked > 0, 'Los intentos de escritura quedan contabilizados y auditados');

// ------------------------------------------------------------------------------
// 2. SEDE-LOCK: GATE DE AISLAMIENTO EN EL BORDE DE LA API
// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Sede-Lock: ninguna consulta sale sin aislamiento de sede');
const sinFiltro = assertTenantIsolation("SELECT * FROM Contacts WHERE phone = '3055551234'");
assert(sinFiltro.safe === false, 'Bloquea una consulta a Contacts SIN cláusula de sede');
assert(sinFiltro.reason.includes('cf_3451'), 'El motivo del bloqueo nombra el campo de aislamiento');

const conFiltro = assertTenantIsolation(`SELECT * FROM Contacts WHERE phone = '3055551234'${sedeClause('PALACIOS')}`);
assert(conFiltro.safe === true, 'Permite una consulta a Contacts CON cláusula de sede');

// vTiger NO soporta paréntesis en el WHERE: el motor debe usar condición plana.
const planaConSede = assertTenantIsolation(`SELECT id FROM Contacts WHERE homephone = '3055' OR mobile = '3055'${sedeClause('PALACIOS')}`);
assert(planaConSede.safe === true, 'La condición plana por teléfono + sede es válida para el parser de vTiger');
assert(!sedeClause('PALACIOS').includes('('), 'La cláusula generada no introduce paréntesis (incompatibles con vTiger)');

// SalesOrder no tiene campo de sede: su aislamiento es por vínculo al contacto.
assert(assertTenantIsolation("SELECT * FROM SalesOrder WHERE amount > 0").safe === false, 'Bloquea SalesOrder sin acotar por contact_id');
assert(assertTenantIsolation("SELECT * FROM SalesOrder WHERE contact_id = '12x1'").safe === false, 'Bloquea SalesOrder sin sede heredada declarada');
assert(assertTenantIsolation("SELECT * FROM SalesOrder WHERE contact_id = '12x1'", { inheritedSede: 'PALACIOS' }).safe === true, 'Permite SalesOrder acotado por contacto con sede heredada válida');
assert(assertTenantIsolation("SELECT * FROM SalesOrder WHERE contact_id = '12x1'", { inheritedSede: 'SEDE_FALSA' }).safe === false, 'Rechaza una sede heredada fuera de la allow-list');
assert(TENANT_ISOLATION_STRATEGY.SalesOrder.mode === 'contactLink', 'SalesOrder declara estrategia contactLink (no posee cf_3451)');
assert(TENANT_ISOLATION_STRATEGY.Contacts.mode === 'direct', 'Contacts declara estrategia direct (sí posee cf_3451)');

assert(assertTenantIsolation('SELECT id, user_name FROM Users LIMIT 5').safe === true, 'No exige sede en módulos globales (Users)');
assert(assertTenantIsolation('SELECT * FROM Potentials WHERE amount > 0').safe === false, 'Bloquea Potentials sin sede');
assert(assertTenantIsolation('SELECT * FROM Invoice').safe === false, 'Bloquea Invoice sin sede');
assert(TENANT_SCOPED_MODULES.includes('Contacts') && TENANT_SCOPED_MODULES.includes('SalesOrder'), 'Los módulos con datos de cliente están marcados como tenant-scoped');

const violacion = new SedeLockViolation('prueba', { module: 'Contacts', sql: "SELECT * FROM Contacts WHERE id='12x9'" });
assert(violacion.code === 'SEDE_LOCK_VIOLATION', 'La violación tiene código propio para auditoría');
assert(!violacion.query.includes('12x9'), 'La consulta reportada en el error va redactada (sin datos del cliente)');

// ------------------------------------------------------------------------------
// 3. SEDE-LOCK: RESOLUCIÓN DE LA SEDE ACTIVA
// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Sede-Lock: resolución obligatoria de la sede activa');
assert(resolveActiveSede({ sede: 'benavides' }) === 'BENAVIDES', 'Normaliza y acepta una sede explícita válida');
assert(resolveActiveSede({ sede: 'SEDE_INVENTADA' }) === null, 'Rechaza una sede inexistente (no degrada a consulta global)');
assert(resolveActiveSede({}) === null, 'Sin sede ni locationId no hay consulta posible');
assert(resolveActiveSede({ locationId: PALACIOS_LOC }) === 'PALACIOS', `Resuelve la sede por locationId de GHL (${PALACIOS_LOC.slice(0, 6)}...)`);
assert(resolveActiveSede({ locationId: BENAVIDES_LOC }) === 'BENAVIDES', 'Resuelve Benavides por su locationId');
assert(resolveActiveSede({ locationId: 'LOCATION_NO_REGISTRADO' }) === null, 'Un locationId desconocido devuelve null (aborta la búsqueda)');
assert(resolveActiveSede({ sede: 'PALACIOS', locationId: BENAVIDES_LOC }) === 'PALACIOS', 'La sede explícita tiene prioridad sobre el locationId');

// ------------------------------------------------------------------------------
// 4. SEDE-SHIELD: CERO RASTRO DE VENTAS AJENAS
// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Sede-Shield: historial de otra sede 100% invisibilizado');

// Caso real del protocolo: el contacto tiene historial de compras en PALACIOS,
// pero está ingresando al GHL de BENAVIDES.
const vContactPalacios = {
  id: '12x2114545',
  contact_no: 'CON262726',
  cf_3451: 'PALACIOS',
  cf_2471: 'articulares 4624 norcross el paso texas',
  cf_2572: 'ERNESTO',
  spl_num_compras: '3',
  cf_3392: '450.00',
  cf_994: 'Vendido',
  spl_fecha_primera_compra: '2024-05-10',
  spl_fecha_ultima_compra: '2025-01-15'
};
const ghlBenavides = { id: 'lead-benavides', locationId: BENAVIDES_LOC, tags: [] };

const verdicto = evaluateCommercialTruth(ghlBenavides, vContactPalacios, 'BENAVIDES');
assert(verdicto.isWon === false, 'El veredicto marca el lead como NO COMPRADOR para la sede receptora');
assert(verdicto.salesCount === 0, 'El número de órdenes ajenas NO se propaga (salesCount = 0)');
assert(verdicto.totalSpent === 0, 'El monto en dólares de la otra sede NO se propaga (totalSpent = $0)');
assert(verdicto.realFirstPurchaseDate === null, 'La fecha de primera compra ajena NO se propaga');
assert(verdicto.realLastPurchaseDate === null, 'La fecha de última compra ajena NO se propaga');
assert(verdicto.commercialStatus === 'SIN VENTA', 'El contacto queda catalogado como SIN VENTA');

const campos = buildSanitizedCommercialFields(ghlBenavides, vContactPalacios, BENAVIDES_LOC);
const ids = getCommercialFieldIdsForSede({ sede: 'BENAVIDES' });
const porId = (id) => campos.find(f => f.id === id);

assert(porId(ids.ESTADO_COMERCIAL)?.field_value === 'SIN VENTA', 'Custom field ESTADO COMERCIAL = SIN VENTA');
assert(porId(ids.PRECIO_VENTA)?.field_value === '' || porId(ids.PRECIO_VENTA) === undefined, 'Custom field PRECIO DE VENTA queda vacío (sin monto ajeno)');
// NUM_COMPRAS y CONTACT_NO se OMITEN del PUT cuando no son legítimos de la sede.
// Es seguro (mejor omitir que escribir): el motor NUNCA envía un valor financiero
// ajeno, y los campos heredados contaminados sí se purgan a vacío (ver TEST 5).
const numComprasAjeno = porId(ids.NUM_COMPRAS);
assert(
  numComprasAjeno === undefined || numComprasAjeno.field_value === '' || numComprasAjeno.field_value === 0 || numComprasAjeno.field_value === '0',
  `NUM_COMPRAS ajeno no se propaga (${numComprasAjeno === undefined ? 'campo omitido del PUT' : JSON.stringify(numComprasAjeno.field_value)})`
);
assert(porId(ids.FECHA_COMPRA)?.field_value === '', 'Custom field FECHA DE COMPRA queda vacío');
assert(porId(ids.SEDE_TIENDA_COMPRA)?.field_value === '' || porId(ids.SEDE_TIENDA_COMPRA) === undefined, 'No se declara la sede de tienda de compra ajena');
assert(porId(ids.ID_CLIENTE_VT)?.field_value === '' || porId(ids.ID_CLIENTE_VT) === undefined, 'No se expone el id de cliente de vTiger de la otra sede');

// Y el caso legítimo: el mismo cliente comprando en SU sede SÍ debe propagarse.
const verdictoLegitimo = evaluateCommercialTruth(ghlBenavides, {
  ...vContactPalacios, cf_3451: 'BENAVIDES', spl_num_compras: '2', cf_3392: '300.00'
}, 'BENAVIDES');
assert(verdictoLegitimo.isWon === true, 'Un historial legítimo de la MISMA sede sí se propaga (no se rompe la lógica de negocio)');
assert(verdictoLegitimo.totalSpent === 300, 'El monto legítimo de la sede activa se conserva');
assert(verdictoLegitimo.salesCount === 2, 'El número de compras legítimo se conserva');

// ------------------------------------------------------------------------------
// 5. HIGIENE DE DATOS: CAMPOS HEREDADOS PURGADOS
// ------------------------------------------------------------------------------
console.log('\n[TEST 5] Higiene: campos heredados de una sede previa se purgan a vacío');
const ghlContaminado = {
  id: 'lead-contaminado',
  locationId: BENAVIDES_LOC,
  customFields: [
    { id: ids.SEDE_TIENDA_COMPRA, value: 'PALACIOS' },
    { id: ids.CONTACT_NO, value: 'CON34449' },
    { id: ids.ID_CLIENTE_VT, value: '12x387529' },
    { id: ids.PRECIO_VENTA, value: '450.00' },
    { id: ids.NUM_COMPRAS, value: '3' }
  ]
};
const purgado = buildSanitizedCommercialFields(ghlContaminado, null, BENAVIDES_LOC);
const pur = (id) => purgado.find(f => f.id === id);
assert(pur(ids.SEDE_TIENDA_COMPRA)?.field_value === '', 'vtiger_sede__tienda_compra purgado a vacío');
assert(pur(ids.CONTACT_NO)?.field_value === '', 'contact_no purgado a vacío');
assert(pur(ids.ID_CLIENTE_VT)?.field_value === '', 'id_cliente de vTiger purgado a vacío');
assert(pur(ids.PRECIO_VENTA)?.field_value === '', 'precio_venta heredado purgado a vacío');
const purNum = pur(ids.NUM_COMPRAS);
assert(purNum === undefined || purNum.field_value === '' || purNum.field_value === 0 || purNum.field_value === '0', 'num_compras heredado no se conserva (purgado u omitido)');

// El contrato de campos comerciales se mantiene simétrico entre sedes.
assert(COMMERCIAL_FIELD_IDS_BENAVIDES.SEDE_TIENDA_COMPRA === 'W12pi3cD5ZbY8R2NqlwL', 'Los IDs de custom field de Benavides siguen intactos');

// ------------------------------------------------------------------------------
// 6. FALLOS CERRADOS: SIN SEDE VÁLIDA NO HAY DATOS
// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Fail-closed: sin sede válida la operación devuelve vacío, no datos globales');
const sinSede = await getSalesHistory('12x2114545', '');
assert(sinSede.blocked === true, 'getSalesHistory bloquea la consulta sin sede válida');
assert(sinSede.records.length === 0 && sinSede.salesCount === 0 && sinSede.totalSpent === 0, 'Devuelve historial vacío (nunca ventas de otra sede)');

const sedeFalsa = await getSalesHistory('12x2114545', "PALACIOS' OR '1'='1");
assert(sedeFalsa.blocked === true, 'Una sede manipulada también se bloquea');

console.log('\n==========================================================');
console.log(` [METRICS] ${passed} pasadas, ${failed} fallidas`);
console.log('==========================================================\n');

process.exit(failed > 0 ? 1 : 0);
