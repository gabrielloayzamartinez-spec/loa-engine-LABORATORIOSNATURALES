import assert from 'assert';
import { buildSanitizedCommercialFields, COMMERCIAL_FIELD_IDS_BENAVIDES } from '../domain/commercial_engine.js';

console.log('🧪 Iniciando pruebas de Aislamiento Estricto de Sede (Sede-Lock & Sede-Shield)...');

// Test 1: Sede-Shield en buildSanitizedCommercialFields (vContact de Palacios en subcuenta Benavides)
console.log('Test 1: Sede-Shield bloquea vContact de Palacios en subcuenta Benavides...');
const ghlContactBenavides = {
  id: 'test-benavides-lead',
  locationId: 'QXcNBK6XCgpQaZ81Z8pv', // Sede Benavides
  tags: []
};

const vContactPalacios = {
  id: '12x2114545',
  contact_no: 'CON262726',
  cf_3451: 'PALACIOS', // Sede Palacios
  cf_2471: 'articulares 4624 norcross el paso texas',
  cf_2572: 'ERNESTO',
  cf_3507: 'FB-MSGR',
  spl_num_compras: '0'
};

const fieldsCrossSede = buildSanitizedCommercialFields(ghlContactBenavides, vContactPalacios, 'QXcNBK6XCgpQaZ81Z8pv');
// El Sede-Shield debió descartar vContactPalacios: no debe inyectar id_cliente, contact_no ni sede PALACIOS
const injectedClienteId = fieldsCrossSede.find(f => f.id === COMMERCIAL_FIELD_IDS_BENAVIDES.ID_CLIENTE_VT);
const injectedSede = fieldsCrossSede.find(f => f.id === COMMERCIAL_FIELD_IDS_BENAVIDES.SEDE_TIENDA_COMPRA);
const injectedContactNo = fieldsCrossSede.find(f => f.id === COMMERCIAL_FIELD_IDS_BENAVIDES.CONTACT_NO);

assert.strictEqual(injectedClienteId, undefined, 'ERROR: Se inyectó ID Cliente de Palacios en subcuenta Benavides!');
assert.strictEqual(injectedSede, undefined, 'ERROR: Se inyectó Sede PALACIOS en subcuenta Benavides!');
assert.strictEqual(injectedContactNo, undefined, 'ERROR: Se inyectó Contact No de Palacios en subcuenta Benavides!');
console.log('✅ Test 1 Pasado: vContact cruzado de Palacios fue 100% neutralizado.');

// Test 2: Sede-Shield permite vContact legítimo de Benavides en subcuenta Benavides
console.log('\nTest 2: Sede-Shield permite vContact legítimo de Benavides en subcuenta Benavides...');
const vContactBenavides = {
  id: '12x2817961',
  contact_no: 'CON487172',
  cf_3451: 'BENAVIDES',
  cf_2471: 'SALUD 5903 glenhurst Houston texas 77033',
  cf_3507: 'FB-MSGR',
  createdtime: '2026-09-18 10:57:00'
};

const fieldsLegit = buildSanitizedCommercialFields(ghlContactBenavides, vContactBenavides, 'QXcNBK6XCgpQaZ81Z8pv');
const legitClienteId = fieldsLegit.find(f => f.id === COMMERCIAL_FIELD_IDS_BENAVIDES.ID_CLIENTE_VT);
const legitSede = fieldsLegit.find(f => f.id === COMMERCIAL_FIELD_IDS_BENAVIDES.SEDE_TIENDA_COMPRA);
const legitContactNo = fieldsLegit.find(f => f.id === COMMERCIAL_FIELD_IDS_BENAVIDES.CONTACT_NO);

assert.strictEqual(legitClienteId?.field_value, '12x2817961', 'ERROR: No se inyectó el ID legítimo de Benavides');
assert.strictEqual(legitSede?.field_value, 'BENAVIDES', 'ERROR: No se inyectó la sede BENAVIDES');
assert.strictEqual(legitContactNo?.field_value, 'CON487172', 'ERROR: No se inyectó CON487172');
console.log('✅ Test 2 Pasado: vContact legítimo de Benavides inyectado con total precisión.');

// Test 3: Purga comercial cuando no hay match en vTiger
console.log('\nTest 3: Lead sin compras en vTiger queda como SIN VENTA y purga fechas falsas...');
const fieldsNoSale = buildSanitizedCommercialFields(ghlContactBenavides, null, 'QXcNBK6XCgpQaZ81Z8pv');
const statusComercial = fieldsNoSale.find(f => f.id === COMMERCIAL_FIELD_IDS_BENAVIDES.ESTADO_COMERCIAL);
const fechaCompra = fieldsNoSale.find(f => f.id === COMMERCIAL_FIELD_IDS_BENAVIDES.FECHA_COMPRA);

assert.strictEqual(statusComercial?.field_value, 'SIN VENTA');
assert.strictEqual(fechaCompra?.field_value, '');
console.log('✅ Test 3 Pasado: Purga de fechas falsas y estatus SIN VENTA intactos.');

// Test 4: Purga de campos contaminados de Palacios en contacto de Benavides
console.log('\nTest 4: Purga campos de Palacios heredados previamente si el lead no existe en vTiger Benavides...');
const ghlContaminatedBenavides = {
  id: 'lead-contaminated',
  locationId: 'QXcNBK6XCgpQaZ81Z8pv',
  customFields: [
    { id: COMMERCIAL_FIELD_IDS_BENAVIDES.SEDE_TIENDA_COMPRA, value: 'PALACIOS' },
    { id: COMMERCIAL_FIELD_IDS_BENAVIDES.CONTACT_NO, value: 'CON34449' },
    { id: COMMERCIAL_FIELD_IDS_BENAVIDES.ID_CLIENTE_VT, value: '12x387529' }
  ]
};

const purgedFields = buildSanitizedCommercialFields(ghlContaminatedBenavides, null, 'QXcNBK6XCgpQaZ81Z8pv');
const purgedSede = purgedFields.find(f => f.id === COMMERCIAL_FIELD_IDS_BENAVIDES.SEDE_TIENDA_COMPRA);
const purgedContactNo = purgedFields.find(f => f.id === COMMERCIAL_FIELD_IDS_BENAVIDES.CONTACT_NO);
const purgedIdVT = purgedFields.find(f => f.id === COMMERCIAL_FIELD_IDS_BENAVIDES.ID_CLIENTE_VT);

assert.strictEqual(purgedSede?.field_value, '', 'ERROR: No se purgó la sede ajena');
assert.strictEqual(purgedContactNo?.field_value, '', 'ERROR: No se purgó el contact_no ajeno');
assert.strictEqual(purgedIdVT?.field_value, '', 'ERROR: No se purgó el id_cliente ajeno');
console.log('✅ Test 4 Pasado: Campos de Palacios purgados a vacío en Benavides.');

console.log('\n🎉 TODAS LAS PRUEBAS DE AISLAMIENTO DE SEDE (SEDE-LOCK / SEDE-SHIELD) PASARON AL 100%.');
