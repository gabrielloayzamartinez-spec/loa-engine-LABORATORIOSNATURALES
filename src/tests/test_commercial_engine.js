import { evaluateCommercialTruth, buildSanitizedCommercialFields, COMMERCIAL_FIELD_IDS } from '../domain/commercial_engine.js';

console.log('🧪 Iniciando pruebas de CommercialStatusEngine...');

// CASO 1: Prospecto nuevo sin compras (con fechas falsas en GHL)
const prospectGHL = { id: 'prospect1', tags: ['lead'] };
const fieldsProspect = buildSanitizedCommercialFields(prospectGHL, null);
const estadoField = fieldsProspect.find(f => f.id === COMMERCIAL_FIELD_IDS.ESTADO_COMERCIAL);
const fechaCompraField = fieldsProspect.find(f => f.id === COMMERCIAL_FIELD_IDS.FECHA_COMPRA);
const fechaAsignacionField = fieldsProspect.find(f => f.id === COMMERCIAL_FIELD_IDS.FECHA_ASIGNACION);

if (estadoField.field_value !== 'SIN VENTA') throw new Error('Falló Estado Comercial en prospecto');
if (fechaCompraField.field_value !== '') throw new Error('Falló Purga de Fecha de Compra en prospecto');
if (!fechaAsignacionField.field_value) throw new Error('Falló Fecha Asignación en prospecto');
console.log('✅ Caso 1 Pasado: Prospecto purgado a SIN VENTA y fecha de compra vacía.');

// CASO 2: Cliente con venta real en vTiger
const customerGHL = { id: 'cust1', tags: [] };
const customerVT = {
  cf_994: 'Vendido',
  spl_num_compras: '2',
  spl_fecha_primera_compra: '2024-05-10',
  spl_fecha_ultima_compra: '2024-08-20',
  cf_3392: '150.00'
};
const fieldsCustomer = buildSanitizedCommercialFields(customerGHL, customerVT);
const estadoCust = fieldsCustomer.find(f => f.id === COMMERCIAL_FIELD_IDS.ESTADO_COMERCIAL);
const fCompraCust = fieldsCustomer.find(f => f.id === COMMERCIAL_FIELD_IDS.FECHA_COMPRA);
const numCompCust = fieldsCustomer.find(f => f.id === COMMERCIAL_FIELD_IDS.NUM_COMPRAS);

if (estadoCust.field_value !== 'CONVERTIDO') throw new Error('Falló Estado Comercial en cliente');
if (fCompraCust.field_value !== '2024-05-10') throw new Error('Falló Fecha Compra en cliente');
if (numCompCust.field_value !== '2') throw new Error('Falló Num Compras en cliente');
console.log('✅ Caso 2 Pasado: Cliente con venta real preservado como CONVERTIDO.');

// CASO 3: Fallo de red / vContact es null (Aislamiento de fallos)
const fieldsOffline = buildSanitizedCommercialFields(prospectGHL, null);
if (fieldsOffline.length === 0) throw new Error('Falló manejo offline');
console.log('✅ Caso 3 Pasado: Manejo offline resiliente sin excepciones.');

console.log('🎉 TODAS LAS PRUEBAS UNITARIAS PASARON EXITOSAMENTE.');
