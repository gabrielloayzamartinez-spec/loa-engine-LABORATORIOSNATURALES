/**
 * ==============================================================================
 * LOA ENGINE - SUITE DE RESOLUCIÓN DE COLISIONES DE CONTACTO (MERGE SOP)
 * ==============================================================================
 * Blinda la lógica de enfrentamiento de 2+ contactos de vTiger con el mismo
 * teléfono, en los dos niveles que ocurren en producción:
 *
 *   A) INTERNA  : mismo teléfono, 2+ contactos en la MISMA sede.
 *   B) EXTERNA  : el mismo teléfono existe en OTRA sede (Sede-Shield: sin fuga).
 *
 * Y el rescate de datos relevantes:
 *   1. Las VENTAS mandan: si sólo uno tiene compras, ése es la persona real.
 *   2. Si dos tienen compras -> REVISION HUMANA (fusionar mal une 2 clientes).
 *   3. Sin ventas -> similitud de nombre; sin certeza -> REVISIÓN.
 *
 * Ejecución:  node src/tests/test_contact_collision.js
 * ==============================================================================
 */

import {
  similitudNombre, mismoTelefono, resolveCollision, buildCollisionNote,
  TIPO_COLISION, CONFIANZA, MOTIVO, UMBRAL_MISMA_PERSONA
} from '../services/contact_collision_service.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

console.log('\n==========================================================');
console.log(' [TEST] RESOLUCION DE COLISIONES DE CONTACTO (MERGE SOP)');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
// 1. COMPARACIÓN DE NOMBRES Y TELÉFONOS
// ------------------------------------------------------------------------------
console.log('[TEST 1] Comparación de nombres y teléfonos');
assert(similitudNombre({ firstname: 'MARIA', lastname: 'PEREZ' }, { firstname: 'MARIA', lastname: 'PEREZ' }) === 1, 'Nombres idénticos dan similitud 1');
assert(similitudNombre({ firstname: 'CARLOS', lastname: 'RUIZ' }, { firstname: 'CARLOS', lastname: 'RUIZ MARTINEZ' }) > 0.5, 'Un apellido compuesto mantiene similitud alta');
assert(similitudNombre({ firstname: 'MARIA', lastname: 'PEREZ' }, { firstname: 'JUAN', lastname: 'GOMEZ' }) === 0, 'Personas distintas dan similitud 0');
assert(similitudNombre({}, { firstname: 'X' }) === 0, 'Sin tokens no hay similitud (no rompe)');
// Tolerancia a acentos y mayúsculas
assert(similitudNombre({ firstname: 'JOSÉ', lastname: 'MUÑOZ' }, { firstname: 'jose', lastname: 'munoz' }) === 1, 'Ignora acentos y mayúsculas');

assert(mismoTelefono('+1 305-555-1234', '3055551234') === true, 'Compara teléfonos por los últimos 10 dígitos');
assert(mismoTelefono('3055551234', '3055559999') === false, 'Teléfonos distintos no coinciden');
assert(mismoTelefono('123', '123') === false, 'Un teléfono demasiado corto no se considera coincidencia');

// ------------------------------------------------------------------------------
// 2. CRITERIO COMERCIAL: ¿ES LA MISMA PERSONA?
// ------------------------------------------------------------------------------
console.log('[TEST 2] Criterio comercial: se conserva el MÁS RECIENTE y se rescatan datos');

// A) DUPLICADO: mismo cliente con el nombre ampliado. El registro RECIENTE no
//    tiene compras, el antiguo sí -> se conserva el reciente y se rescatan las
//    compras del antiguo. ESTE es el caso que el motor perdía antes.
const informeDuplicado = {
  telefono: '+13055551234',
  sedeActiva: 'PALACIOS',
  tipo: TIPO_COLISION.INTERNA,
  interna: {
    sede: 'PALACIOS',
    total: 2,
    contactos: [
      { vTigerId: 'V1', nombre: 'MIGUEL REVILLA', compras: 5, monto: 800, tratamiento: 'Potencia', modificado: '2024-03-01', etiquetas: ['vip'] },
      { vTigerId: 'V2', nombre: 'MIGUEL REVILLA SANCHEZ', compras: 0, monto: 0, tratamiento: '', modificado: '2026-09-20', etiquetas: ['nuevo'] }
    ]
  },
  externa: null
};

const rDup = resolveCollision(informeDuplicado, { id: 'V1' });
assert(rDup.requiereRevision === false, 'Un duplicado del mismo cliente se resuelve SIN revisión humana');
assert(rDup.motivo === MOTIVO.MISMA_PERSONA, 'El motivo declara que es el mismo cliente');
assert(rDup.elegido.vTigerId === 'V2', 'Se conserva el contacto MÁS RECIENTE (V2), no el que tiene compras');
assert(rDup.elegido.modificado === '2026-09-20', 'La fecha del conservado es la más reciente');
assert(rDup.descartados.length === 1 && rDup.descartados[0].vTigerId === 'V1', 'El registro antiguo queda como descartado');
assert(rDup.datosRescatados.compras === 5, `SE RESCATAN las compras del descartado (${rDup.datosRescatados.compras})`);
assert(rDup.datosRescatados.monto === 800, `SE RESCATA el monto del descartado ($${rDup.datosRescatados.monto})`);
assert(rDup.datosRescatados.tratamiento === 'Potencia', 'SE RESCATA el tratamiento');
assert(rDup.datosRescatados.fuenteCompras === 'V1', 'Se registra de dónde vinieron los datos rescatados (trazabilidad)');
assert(rDup.datosRescatados.etiquetas.includes('vip') && rDup.datosRescatados.etiquetas.includes('nuevo'), 'Se unen las etiquetas de ambos registros');

// B) FAMILIARES: nombres claramente distintos con el mismo celular.
const informeFamiliares = {
  telefono: '+13055559999',
  sedeActiva: 'PALACIOS',
  tipo: TIPO_COLISION.AMBAS,
  interna: {
    sede: 'PALACIOS', total: 2,
    contactos: [
      { vTigerId: 'V3', nombre: 'MIGUEL REVILLA', compras: 5, monto: 800, tratamiento: 'Potencia', modificado: '2024-03-01', etiquetas: [] },
      { vTigerId: 'V4', nombre: 'MARIA REVILLA', compras: 2, monto: 200, tratamiento: 'Colageno', modificado: '2026-09-20', etiquetas: [] }
    ]
  },
  externa: { sedesConElMismoTelefono: ['BENAVIDES'] }
};

const rFam = resolveCollision(informeFamiliares, informeFamiliares.interna.contactos[0]);
assert(rFam.requiereRevision === true, 'Personas distintas con el mismo celular -> REVISIÓN HUMANA');
assert(rFam.motivo === MOTIVO.PERSONAS_DISTINTAS, 'El motivo declara que son personas distintas');
assert(Object.keys(rFam.datosRescatados).length === 0, 'NO se fusionan datos entre dos personas distintas');
assert(rFam.elegido.vTigerId === 'V4', 'Se propone el reciente como referencia, pero SIN decidir');

// C) DUPLICADO POR ERROR DE CARGA: nombre idéntico.
const informeIdentico = {
  telefono: '+13055550000', sedeActiva: 'PALACIOS', tipo: TIPO_COLISION.INTERNA,
  interna: {
    sede: 'PALACIOS', total: 2,
    contactos: [
      { vTigerId: 'V5', nombre: 'ANA UMAÑA', compras: 3, monto: 450, tratamiento: 'Diabetes', modificado: '2025-01-01', etiquetas: [] },
      { vTigerId: 'V6', nombre: 'ANA UMAÑA', compras: 0, monto: 0, tratamiento: '', modificado: '2026-09-25', etiquetas: [] }
    ]
  }
};
const rIdem = resolveCollision(informeIdentico, { id: 'V5' });
assert(rIdem.elegido.vTigerId === 'V6', 'Nombre idéntico: se conserva el más reciente');
assert(rIdem.confianza === CONFIANZA.ALTA, 'Con similitud 1.0 la confianza es ALTA');
assert(rIdem.datosRescatados.compras === 3, 'Se rescatan las compras del duplicado antiguo');

// El "más reciente" debe respetar formatos de fecha comparables
const informeFechas = {
  telefono: '+13055551111', sedeActiva: 'PALACIOS', tipo: TIPO_COLISION.INTERNA,
  interna: { sede: 'PALACIOS', total: 2, contactos: [
    { vTigerId: 'A', nombre: 'PEDRO GOMEZ', compras: 1, monto: 10, tratamiento: '', modificado: '2026-01-05', etiquetas: [] },
    { vTigerId: 'B', nombre: 'PEDRO GOMEZ', compras: 1, monto: 10, tratamiento: '', modificado: '2026-11-30', etiquetas: [] }
  ] }
};
assert(resolveCollision(informeFechas, {}).elegido.vTigerId === 'B', 'Compara fechas correctamente (YYYY-MM-DD)');

// ------------------------------------------------------------------------------
// 3. RESOLUCIÓN: SIN COLISIÓN
// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Sin colisión: el contacto base es el elegido');
const r5 = resolveCollision({ interna: null, externa: null, tipo: TIPO_COLISION.NINGUNA }, { id: 'V9', firstname: 'SOLO', lastname: 'UNO', spl_num_compras: '1', cf_3392: '100' });
assert(r5.elegido.vTigerId === 'V9', 'Sin colisión se elige el contacto base');
assert(r5.requiereRevision === false, 'Sin colisión no hay revisión');
assert(r5.motivo === MOTIVO.SIN_COLISION, 'El motivo lo declara explícitamente');

// Con discrepancia de nombre reportada por quien consulta, el motivo lo refleja
const r5b = resolveCollision(
  { interna: null, externa: null, tipo: TIPO_COLISION.NINGUNA, discrepanciaNombre: [{ id: 'V8', firstname: 'REAL', lastname: 'CLIENTE', spl_num_compras: '2', cf_3392: '300' }] },
  { id: 'V9', firstname: 'LEAD', lastname: 'NUEVO' }
);
assert(r5b.motivo === MOTIVO.NOMBRE_DISCREPANTE, 'Declara que el nombre difería (no lo oculta como "sin colisión")');
assert(r5b.elegido.vTigerId === 'V8' && r5b.elegido.compras === 2, 'Conserva el contacto real con su historial');

// ------------------------------------------------------------------------------
// 6. NOTA PARA LA TARJETA + AISLAMIENTO ENTRE SEDES
// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Nota del enfrentamiento y aislamiento entre sedes');
// Se usa el caso de FAMILIARES (personas distintas): es el que requiere revisión
// humana y el que debe documentarse en la tarjeta.
const nota = buildCollisionNote(informeFamiliares, rFam);
assert(nota.includes('[LOA-COLLISION]'), 'La nota tiene marca identificable');
assert(nota.includes('+13055559999'), 'Declara el teléfono en conflicto');
assert(nota.includes('AMBAS'), 'Declara el tipo de colisión');
assert(nota.includes('MIGUEL REVILLA') && nota.includes('MARIA REVILLA'), 'Lista los candidatos de la MISMA sede con su detalle');
assert(nota.includes('<< ELEGIDO'), 'Marca cuál fue elegido');
assert(nota.includes('(descartado)'), 'Marca cuáles quedaron descartados');
assert(nota.includes('BENAVIDES'), 'Menciona que existe conflicto en otra sede');
assert(nota.includes('SEDE-SHIELD'), 'Declara explícitamente que no expone datos ajenos');
assert(nota.includes('REQUIERE REVISION HUMANA'), 'Avisa cuando hace falta criterio humano');

// AISLAMIENTO: la nota NO debe filtrar datos de la otra sede.
// Se verifica de forma SEMÁNTICA: junto a la sede ajena sólo puede aparecer la
// aclaración del shield, nunca un nombre, monto, compra o tratamiento ajeno.
const trasSedeAjena = nota.slice(nota.indexOf('BENAVIDES'));
assert(!/\$\d/.test(trasSedeAjena), 'No expone montos junto a la otra sede');
assert(!/Compras:\s*\d/i.test(trasSedeAjena), 'No expone número de compras de la otra sede');
assert(!/Tratamiento:/i.test(trasSedeAjena), 'No expone tratamientos de la otra sede');
assert(trasSedeAjena.includes('[SEDE-SHIELD]'), 'Declara explícitamente que los datos ajenos no se exponen');
assert(trasSedeAjena.split('\n').filter(l => l.trim()).length < 12, 'Junto a la sede ajena sólo va la aclaración, sin historial detallado');

// Sin colisión no se genera nota
assert(buildCollisionNote({ interna: null, externa: null }, {}) === null, 'Sin colisión no se genera nota (no ensucia la tarjeta)');

console.log('\n==========================================================');
console.log(` [METRICS] ${passed} pasadas, ${failed} fallidas`);
console.log('==========================================================\n');

process.exit(failed > 0 ? 1 : 0);
