/**
 * TEST — FRONTERA N1 (HOY) / N2 (HISTÓRICO)
 * La regla del negocio: el Nivel 1 atiende SOLO hoy; el Nivel 2 cubre todo lo
 * anterior a hoy. La frontera es medianoche de Lima (UTC-5), sin excepciones.
 */
import {
  inicioDiaLima, esDeHoy, fechaLimaISO, fechaAyerLimaISO,
  filtroVtigerAntesDeHoy, n2SoloHistorico
} from '../domain/ventana_temporal.js';

let pasadas = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg); pasadas++; };

console.log('[TEST] Ventana temporal N1/N2…');

// 27-nov-2026 15:47 UTC = 10:47 Lima
const ahora = Date.UTC(2026, 10, 27, 15, 47, 0);
const medianoche = inicioDiaLima(ahora);
assert(medianoche === Date.UTC(2026, 10, 27, 5, 0, 0), 'La medianoche de Lima es 05:00 UTC');

assert(esDeHoy(medianoche) === true, 'La medianoche exacta ya es HOY');
assert(esDeHoy(medianoche + 1) === true, 'Un segundo después es HOY');
assert(esDeHoy(medianoche - 1) === false, 'Un segundo antes es HISTÓRICO');
assert(esDeHoy(ahora) === true, 'El instante actual es HOY');
assert(esDeHoy(0) === false && esDeHoy(null) === false, 'Sin fecha válida no es HOY');

// Frontera de día: 26-nov 23:59 Lima = 27-nov 04:59 UTC
const antesDeMedianoche = Date.UTC(2026, 10, 27, 4, 59, 0);
assert(esDeHoy(antesDeMedianoche) === false, '23:59 de ayer (Lima) es HISTÓRICO');

assert(fechaLimaISO(ahora) === '2026-11-27', 'La fecha de Lima se calcula bien');
assert(fechaAyerLimaISO(ahora) === '2026-11-26', 'La fecha de ayer se calcula bien');

// Cláusula para vTiger: corta en la medianoche local, no en UTC.
const filtro = filtroVtigerAntesDeHoy('createdtime', ahora);
assert(filtro === " AND createdtime < '2026-11-27 00:00:00'", `El filtro de vTiger corta a medianoche de Lima (${filtro})`);

// El nombre del campo se sanea (no se puede inyectar SQL por el parámetro).
const filtroSucio = filtroVtigerAntesDeHoy("createdtime' OR '1'='1", ahora);
assert(filtroSucio.startsWith(' AND createdtimeOR <'), `El saneado deja solo letras y guiones bajos (${filtroSucio})`);
assert((filtroSucio.match(/'/g) || []).length === 2, 'Solo quedan las dos comillas del valor de fecha');

// Interruptor del recorte histórico.
const previo = process.env.N2_HASTA_AYER;
delete process.env.N2_HASTA_AYER;
assert(n2SoloHistorico() === true, 'Por defecto el N2 es solo histórico (hasta ayer)');
process.env.N2_HASTA_AYER = 'false';
assert(n2SoloHistorico() === false, 'Se puede desactivar el recorte');
if (previo === undefined) delete process.env.N2_HASTA_AYER; else process.env.N2_HASTA_AYER = previo;

console.log(`[SUCCESS] ${pasadas} aserciones de la ventana temporal validadas al 100%.`);
