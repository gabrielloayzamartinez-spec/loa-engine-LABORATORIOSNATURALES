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
  TIPO_COLISION, CONFIANZA
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
// 2. RESOLUCIÓN: LAS VENTAS MANDAN
// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Las ventas mandan: se rescata el historial real');
const informeInterno = {
  telefono: '+13055551234',
  sedeActiva: 'PALACIOS',
  tipo: TIPO_COLISION.INTERNA,
  interna: {
    sede: 'PALACIOS',
    total: 2,
    contactos: [
      { vTigerId: 'V1', nombre: 'MARIA PEREZ', compras: 0, monto: 0, tratamiento: '', modificado: '2026-01-10', similitudConBase: 1 },
      { vTigerId: 'V2', nombre: 'JUAN GOMEZ', compras: 3, monto: 450, tratamiento: 'Diabetes', modificado: '2026-08-15', similitudConBase: 0 }
    ]
  },
  externa: null
};

const r1 = resolveCollision(informeInterno, { id: 'V1', firstname: 'MARIA', lastname: 'PEREZ' });
assert(r1.elegido.vTigerId === 'V2', 'Gana el contacto con compras, no el que coincide en nombre');
assert(r1.confianza === CONFIANZA.ALTA, 'La resolución es de confianza ALTA (criterio inequívoco)');
assert(r1.requiereRevision === false, 'No requiere revisión humana');
assert(r1.datosRescatados.compras === 3 && r1.datosRescatados.monto === 450, `Rescata el historial: ${r1.datosRescatados.compras} compras por $${r1.datosRescatados.monto}`);
assert(r1.datosRescatados.tratamiento === 'Diabetes', 'Rescata también el tratamiento');
assert(r1.descartados.length === 1 && r1.descartados[0].vTigerId === 'V1', 'El otro candidato queda listado como descartado (trazabilidad)');
assert(r1.motivo.includes('compras'), 'El motivo explica el criterio aplicado');

// ------------------------------------------------------------------------------
// 3. RESOLUCIÓN: CONFLICTO CRÍTICO (DOS CON VENTAS)
// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Conflicto crítico: dos contactos con compras -> revisión humana');
const informeCritico = {
  telefono: '+13055559999',
  sedeActiva: 'PALACIOS',
  tipo: TIPO_COLISION.AMBAS,
  interna: {
    sede: 'PALACIOS', total: 2,
    contactos: [
      { vTigerId: 'V1', nombre: 'CARLOS RUIZ', compras: 2, monto: 300, tratamiento: 'Artritis', modificado: '2026-05-01', similitudConBase: 1 },
      { vTigerId: 'V2', nombre: 'CARLOS RUIZ MARTINEZ', compras: 5, monto: 890, tratamiento: 'Potencia', modificado: '2026-09-01', similitudConBase: 0.66 }
    ]
  },
  externa: { sedesConElMismoTelefono: ['BENAVIDES'] }
};

const r2 = resolveCollision(informeCritico, informeCritico.interna.contactos[0]);
assert(r2.confianza === CONFIANZA.REVISION, 'La confianza es REVISION (no se automatiza)');
assert(r2.requiereRevision === true, 'Se marca que requiere revisión humana');
assert(r2.motivo.includes('dos clientes reales') || r2.motivo.includes('contactos con compras'), 'El motivo explica el riesgo de fusionar');
assert(r2.elegido.vTigerId === 'V2', 'Propone el de mayor monto como candidato, pero SIN decidir');

// ------------------------------------------------------------------------------
// 4. RESOLUCIÓN: SIN VENTAS -> SIMILITUD DE NOMBRE
// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Sin ventas en ninguno: decide por similitud de nombre');
const informeSinVentas = {
  telefono: '+13055550000', sedeActiva: 'PALACIOS', tipo: TIPO_COLISION.INTERNA,
  interna: {
    sede: 'PALACIOS', total: 2,
    contactos: [
      { vTigerId: 'V1', nombre: 'ANA LOPEZ', compras: 0, monto: 0, tratamiento: '', modificado: '2026-01-01', similitudConBase: 0.9 },
      { vTigerId: 'V2', nombre: 'PEDRO DIAZ', compras: 0, monto: 0, tratamiento: '', modificado: '2026-02-01', similitudConBase: 0 }
    ]
  }
};
const r3 = resolveCollision(informeSinVentas, { id: 'V1' });
assert(r3.elegido.vTigerId === 'V1', 'Elige el de mayor similitud de nombre');
assert(r3.confianza === CONFIANZA.MEDIA, 'Confianza MEDIA: resoluble pero conviene revisar');

const informeAmbigua = {
  telefono: '+13055551111', sedeActiva: 'PALACIOS', tipo: TIPO_COLISION.INTERNA,
  interna: {
    sede: 'PALACIOS', total: 2,
    contactos: [
      { vTigerId: 'V1', nombre: 'XX YY', compras: 0, monto: 0, similitudConBase: 0 },
      { vTigerId: 'V2', nombre: 'ZZ WW', compras: 0, monto: 0, similitudConBase: 0 }
    ]
  }
};
const r4 = resolveCollision(informeAmbigua, { id: 'V1' });
assert(r4.requiereRevision === true, 'Sin ventas ni coincidencia de nombre -> revisión humana');
assert(r4.elegido === null, 'No se elige a ciegas cuando no hay certeza');

// ------------------------------------------------------------------------------
// 5. SIN COLISIÓN: COMPORTAMIENTO NORMAL
// ------------------------------------------------------------------------------
console.log('\n[TEST 5] Sin colisión: el contacto base es el elegido');
const r5 = resolveCollision({ interna: null, externa: null, tipo: TIPO_COLISION.NINGUNA }, { id: 'V9', firstname: 'SOLO', lastname: 'UNO', spl_num_compras: '1', cf_3392: '100' });
assert(r5.elegido.vTigerId === 'V9', 'Sin colisión se elige el contacto base');
assert(r5.requiereRevision === false, 'Sin colisión no hay revisión');
assert(r5.motivo === 'sin colisión interna', 'El motivo lo declara explícitamente');

// ------------------------------------------------------------------------------
// 6. NOTA PARA LA TARJETA + AISLAMIENTO ENTRE SEDES
// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Nota del enfrentamiento y aislamiento entre sedes');
const nota = buildCollisionNote(informeCritico, r2);
assert(nota.includes('[LOA-COLLISION]'), 'La nota tiene marca identificable');
assert(nota.includes('+13055559999'), 'Declara el teléfono en conflicto');
assert(nota.includes('AMBAS'), 'Declara el tipo de colisión');
assert(nota.includes('CARLOS RUIZ') && nota.includes('CARLOS RUIZ MARTINEZ'), 'Lista los candidatos de la MISMA sede con su detalle');
assert(nota.includes('<< ELEGIDO'), 'Marca cuál fue elegido');
assert(nota.includes('(descartado)'), 'Marca cuáles quedaron descartados');
assert(nota.includes('BENAVIDES'), 'Menciona que existe conflicto en otra sede');
assert(nota.includes('SEDE-SHIELD'), 'Declara explícitamente que no expone datos ajenos');
assert(nota.includes('REQUIERE REVISION HUMANA'), 'Avisa cuando hace falta criterio humano');

// AISLAMIENTO: la nota NO debe filtrar datos de la otra sede.
const notaString = JSON.stringify(nota);
assert(!/BENAVIDES[^\n]*\$\d/.test(nota), 'No expone montos de la otra sede');
assert(nota.split('BENAVIDES')[1].length < 400, 'Junto a la sede ajena sólo hay la aclaración del shield, sin historial');

// Sin colisión no se genera nota
assert(buildCollisionNote({ interna: null, externa: null }, {}) === null, 'Sin colisión no se genera nota (no ensucia la tarjeta)');

console.log('\n==========================================================');
console.log(` [METRICS] ${passed} pasadas, ${failed} fallidas`);
console.log('==========================================================\n');

process.exit(failed > 0 ? 1 : 0);
