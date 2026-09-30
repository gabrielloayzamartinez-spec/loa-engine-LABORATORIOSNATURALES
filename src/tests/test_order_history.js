/**
 * ==============================================================================
 * LOA ENGINE - SUITE DEL HISTORIAL DE ÓRDENES vTiger -> GHL
 * ==============================================================================
 * Blinda la capa que publica el DETALLE comercial (no sólo el resumen):
 *   1. Normalización de una orden cruda de SalesOrder (151 campos).
 *   2. Orden cronológico descendente.
 *   3. Nota legible en la tarjeta del contacto (con nº de orden, guía, entrega).
 *   4. Campo estructurado para filtros y automatizaciones.
 *   5. Idempotencia: la marca de la nota permite ACTUALIZAR sin duplicar.
 *   6. Aislamiento: la nota de sede no declara el alcance global.
 *
 * Ejecución:  node src/tests/test_order_history.js
 * ==============================================================================
 */

import {
  normalizeOrder, sortOrdersDesc, buildOrderHistoryNote, buildOrderHistoryField,
  MARCADOR_NOTA
} from '../services/vtiger_order_history_service.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

console.log('\n==========================================================');
console.log(' [TEST] HISTORIAL DE ORDENES vTiger -> GHL');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
// 1. NORMALIZACIÓN (campos verificados contra la instancia real)
// ------------------------------------------------------------------------------
console.log('[TEST 1] Normalización de una orden cruda de SalesOrder');
const ordenCruda = {
  id: '6x35385',
  salesorder_no: 'G-04212158',
  subject: 'ALFA-L-179',
  createdtime: '2019-11-21 14:21:32',
  sostatus: 'Approved',
  cf_1057: 'Liquidada',
  cf_1063: '2019-11-15',
  hdnGrandTotal: '160.00000000',
  cf_1069: 'Artritis',
  cf_3156: 'ALFA-L-179',
  cf_3298: '1.00',
  cf_2606: 'CLICK2RING',
  cf_2713: 'MARIBEL',
  cf_3490: 'PALACIOS-CLICK2RING-FB-MSGR-Artritis',
  cf_3513: 'FB-MSGR',
  cf_890: 'Correo-USPS',
  cf_1045: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9405511699000396289341',
  cf_882: 'ENTREGADA',
  cf_886: 'CONFORME',
  cf_876: 'COLUMBUS',
  cf_1053: 'Ohio',
  cf_872: '43204',
  cf_902: 'Tarjeta de Credito',
  cf_912: 'SQUARE',
  comment: '<p>Pedido <b>verificado</b> por telefono</p>'
};

const o = normalizeOrder(ordenCruda);
assert(o.numeroOrden === 'G-04212158', 'Extrae el número de orden');
assert(o.fecha === '2019-11-21', 'Normaliza la fecha a YYYY-MM-DD');
assert(o.total === 160, `Convierte el monto a número (${o.total})`);
assert(o.tratamiento === 'Artritis', 'Extrae el tratamiento del pedido');
assert(o.producto === 'ALFA-L-179', 'Extrae el producto');
assert(o.cantidad === 1, 'Extrae la cantidad');
assert(o.proveedor === 'CLICK2RING', 'Extrae el proveedor');
assert(o.vendedor === 'MARIBEL', 'Extrae el vendedor');
assert(o.guia === '9405511699000396289341', `Extrae la guía de USPS del enlace de rastreo (${o.guia})`);
assert(o.estadoEntrega === 'ENTREGADA', 'Extrae el estado de entrega');
assert(o.formaPago === 'Tarjeta de Credito', 'Extrae la forma de pago');
assert(o.procesadorPago === 'SQUARE', 'Extrae el procesador de pago');
assert(!o.notas.includes('<'), 'Limpia el HTML de las notas');

// Robustez ante datos vacíos
const vacia = normalizeOrder({});
assert(vacia.total === 0 && vacia.cantidad === 1, 'Una orden vacía no rompe: total 0 y cantidad 1 por defecto');
assert(normalizeOrder({ hdnGrandTotal: 'no-numero' }).total === 0, 'Un monto no numérico se resuelve a 0 (no NaN)');

// ------------------------------------------------------------------------------
// 2. ORDEN CRONOLÓGICO
// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Ordenamiento cronológico descendente');
const desordenadas = [
  { fecha: '2019-11-21', total: 160, numeroOrden: 'A' },
  { fecha: '2020-03-05', total: 100, numeroOrden: 'C' },
  { fecha: '2019-12-19', total: 120, numeroOrden: 'B' }
];
const ordenadas = sortOrdersDesc(desordenadas);
assert(ordenadas[0].numeroOrden === 'C', 'La más reciente queda primero');
assert(ordenadas[2].numeroOrden === 'A', 'La más antigua queda al final');

// ------------------------------------------------------------------------------
// 3. NOTA LEGIBLE EN LA TARJETA DEL CONTACTO
// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Nota de la tarjeta del contacto');
const nota = buildOrderHistoryNote('MIGUEL REVILLA', ordenadas, 'PALACIOS');
assert(nota.startsWith(MARCADOR_NOTA), 'La nota empieza con la marca de idempotencia');
assert(nota.includes('MIGUEL REVILLA'), 'Incluye el nombre del cliente');
assert(nota.includes('PALACIOS'), 'Declara el alcance (sede)');
assert(nota.includes('Ordenes: 3'), 'Indica la cantidad de órdenes');
assert(nota.includes('$380.00'), 'Suma el total acumulado de las 3 órdenes');
assert(nota.includes('DETALLE'), 'Incluye la sección de detalle');
assert(nota.includes('Sincronizado por LOA Engine'), 'Firma el origen del dato');

// El marcador es lo que hace posible la idempotencia
assert(MARCADOR_NOTA === '[LOA-ORDER-HISTORY]', 'La marca es estable (permite localizar y actualizar la nota existente)');

// Límite de tamaño: no debe generar una nota gigante con 200 órdenes
const muchas = Array.from({ length: 200 }, (_, i) => normalizeOrder({
  id: `6x${i}`, salesorder_no: `G-${i}`, createdtime: '2020-01-01', hdnGrandTotal: '100'
}));
const notaGigante = buildOrderHistoryNote('CLIENTE FRECUENTE', muchas, 'PALACIOS');
assert(notaGigante.includes('y 170 ordenes mas'), 'Recorta el detalle y avisa cuántas quedaron fuera (evita notas enormes)');
assert(notaGigante.length < 20000, `La nota se mantiene en un tamaño razonable (${notaGigante.length} caracteres)`);

// ------------------------------------------------------------------------------
// 4. CAMPO ESTRUCTURADO
// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Campo estructurado para filtros y automatizaciones');
const campo = buildOrderHistoryField(ordenadas);
const parsed = JSON.parse(campo);
assert(parsed.ordenes === 3, 'El campo declara el número de órdenes');
assert(parsed.total === 380, 'El campo declara el total acumulado');
assert(parsed.ultimaCompra === '2020-03-05', 'El campo declara la última compra');
assert(parsed.primeraCompra === '2019-11-21', 'El campo declara la primera compra');
assert(Array.isArray(parsed.detalle) && parsed.detalle.length === 3, 'El campo incluye el detalle por orden');
assert(parsed.detalle[0].n === 'C' && parsed.detalle[0].m === 100, 'El detalle está ordenado y con monto numérico');
assert(campo.length < 65535, 'El JSON cabe en un campo LARGE_TEXT');

// ------------------------------------------------------------------------------
// 5. CASOS LÍMITE
// ------------------------------------------------------------------------------
console.log('\n[TEST 5] Casos límite');
assert(buildOrderHistoryNote('X', [], 'PALACIOS').includes('Ordenes: 0'), 'Sin órdenes la nota se genera igual (no lanza)');
assert(JSON.parse(buildOrderHistoryField([])).total === 0, 'Sin órdenes el campo reporta total 0');
const sinFecha = normalizeOrder({ salesorder_no: 'G-1' });
assert(sinFecha.fecha === '', 'Una orden sin fecha no rompe el ordenamiento');
assert(sortOrdersDesc([sinFecha]).length === 1, 'El ordenamiento tolera fechas vacías');

console.log('\n==========================================================');
console.log(` [METRICS] ${passed} pasadas, ${failed} fallidas`);
console.log('==========================================================\n');

process.exit(failed > 0 ? 1 : 0);
