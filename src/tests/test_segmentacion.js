/**
 * TEST — SEGMENTACIÓN DERIVADA (recompra, comprador, fecha DATE)
 * Valida las reglas que alimentan las Listas Inteligentes de GHL.
 */
import {
  clasificarCliente, camposDerivadosDeSegmentacion, etiquetasDeSegmentacion,
  TIPO_CLIENTE, FUENTE_ORDEN, RECETAS_SMART_LIST
} from '../domain/segmentacion.js';

let pasadas = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg); pasadas++; };

console.log('[TEST] Segmentación derivada (Listas Inteligentes)…');

// ---------------------------------------------------------------------------
// 1. CLASIFICACIÓN
// ---------------------------------------------------------------------------
const prospecto = clasificarCliente({ numCompras: 0 });
assert(prospecto.tipo === TIPO_CLIENTE.PROSPECTO && prospecto.esComprador === false, '0 compras → PROSPECTO / No comprador');
assert(prospecto.fuenteUltimaOrden === '', 'Prospecto no tiene "Fuente Última Orden"');

const nuevo = clasificarCliente({ numCompras: 1 });
assert(nuevo.tipo === TIPO_CLIENTE.NUEVO && nuevo.esComprador && !nuevo.esRecompra, '1 compra → NUEVO comprador');
assert(nuevo.fuenteUltimaOrden === FUENTE_ORDEN.PRIMERA, "1 compra → 'Primera Compra'");

const recompra = clasificarCliente({ numCompras: 5 });
assert(recompra.tipo === TIPO_CLIENTE.RECOMPRA && recompra.esRecompra, '2+ compras → RECOMPRA');
assert(recompra.fuenteUltimaOrden === FUENTE_ORDEN.REORDEN, "2+ compras → 'Mi Re-Orden'");

const porOrdenes = clasificarCliente({ numCompras: 0, ordenes: [{}, {}] });
assert(porOrdenes.tipo === TIPO_CLIENTE.RECOMPRA, 'El nº real de órdenes manda sobre spl_num_compras');

// ---------------------------------------------------------------------------
// 2. CAMPOS DERIVADOS
// ---------------------------------------------------------------------------
const campos = camposDerivadosDeSegmentacion({
  vContact: { id: '12x1', createdtime: '2026-03-15 10:20:00', spl_fecha_ultima_compra: '2026-11-01' },
  numCompras: 3
});
const porLogico = Object.fromEntries(campos.map(c => [c.logico, c.valor]));
assert(porLogico.estadoCompra === 'Comprador', 'Estado de Compra = Comprador');
assert(porLogico.fuenteUltimaOrden === 'Mi Re-Orden', 'Fuente = Mi Re-Orden');
assert(porLogico.fechaCreacionFecha === '2026-03-15', 'Fecha Creación (DATE) en formato AAAA-MM-DD');
assert(porLogico.fechaUltimaCompra === '2026-11-01', 'Fecha Última Compra publicada al comprador');

const prospectoCampos = camposDerivadosDeSegmentacion({ vContact: { createdtime: '2026-03-15 10:20:00' }, numCompras: 0 });
const pLog = Object.fromEntries(prospectoCampos.map(c => [c.logico, c.valor]));
assert(pLog.estadoCompra === 'No Comprador', 'Prospecto → No Comprador');
assert(pLog.fuenteUltimaOrden === undefined, 'Prospecto no publica recompra');
assert(pLog.fechaUltimaCompra === undefined, 'Prospecto no publica fecha de compra');

const sinFecha = camposDerivadosDeSegmentacion({ vContact: { createdtime: '' }, numCompras: 1 });
assert(!sinFecha.some(c => c.logico === 'fechaCreacionFecha'), 'Sin createdtime no se inventa la fecha DATE');

// ---------------------------------------------------------------------------
// 3. ETIQUETAS Y RECETAS
// ---------------------------------------------------------------------------
assert(etiquetasDeSegmentacion({ numCompras: 2 }).includes('recompra'), 'Recompra produce su etiqueta');
assert(etiquetasDeSegmentacion({ numCompras: 1 }).includes('primera-compra'), 'Primera compra produce su etiqueta');
assert(etiquetasDeSegmentacion({ numCompras: 0 }).length === 0, 'Prospecto no produce etiqueta de compra');

assert(RECETAS_SMART_LIST.length >= 6, 'Hay recetas de Listas Inteligentes documentadas');
for (const r of RECETAS_SMART_LIST) {
  assert(Boolean(r.nombre && r.filtro && r.campo), `La receta "${r.nombre}" declara nombre, filtro y campo`);
}

console.log(`[SUCCESS] ${pasadas} aserciones de segmentación validadas al 100%.`);
