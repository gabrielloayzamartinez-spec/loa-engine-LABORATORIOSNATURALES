/**
 * TEST — CONTROL POR SUBCUENTA (4 workers independientes + efectividad por contacto)
 *
 * Sin red: el procesador se inyecta con `setProcesador`.
 * Valida:
 *   · aislamiento real entre subcuentas (cola y cuota propias);
 *   · clasificación correcta de cada resultado (ok / sin_cambios / omitido / fallido);
 *   · reintentos y lista de fallidos;
 *   · efectividad por sede y total, con la fórmula acordada.
 */

// Se fijan ANTES del import: `envInt` los lee al cargar el módulo.
process.env.CONTROL_MAX_INTENTOS = '1';       // un solo intento → fallo inmediato (test rápido)
process.env.CONTROL_PAUSA_MS = '0';
process.env.VTIGER_LECTURAS_POR_MIN_SEDE = '600';

const {
  encolarContacto, setProcesador, bombear, getEstadoSubcuenta, getEstadoGlobal,
  efectividadDe, clasificarResultado, reintentarFallidos, pausarSede, reanudarSede,
  reiniciarLibro, RESULTADOS
} = await import('../services/subaccount_controller.js');

let pasadas = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg); pasadas++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function esperarColaVacia(sede, maxMs = 4000) {
  const inicio = Date.now();
  while (Date.now() - inicio < maxMs) {
    const e = getEstadoSubcuenta(sede);
    if (!e.procesando && e.cola === 0) return true;
    await sleep(25);
  }
  return false;
}

console.log('[TEST] Control por subcuenta (4 procesos independientes)…');

// ---------------------------------------------------------------------------
// 1. FÓRMULA DE EFECTIVIDAD (por contacto, no por intento)
// ---------------------------------------------------------------------------
const ef = efectividadDe({ contactosOk: 7, contactosSinCambios: 1, contactosOmitidos: 1, contactosFallidos: 1 });
assert(ef.debianEscribirse === 9, 'Los omitidos no cuentan como "debían escribirse"');
assert(ef.exitosos === 8, 'Éxitos = ok + sin_cambios');
assert(ef.efectividadPct === 88.9, `Efectividad = 8/9 = 88.9% (recibido ${ef.efectividadPct})`);
assert(ef.tasaFalloPct === 11.1, 'Tasa de fallo = 1/9');
assert(efectividadDe({}).efectividadPct === null, 'Sin datos la efectividad es null, no 0');
const efPerfecta = efectividadDe({ contactosOk: 4, contactosSinCambios: 1, contactosOmitidos: 0, contactosFallidos: 0 });
assert(efPerfecta.efectividadPct === 100, '100% cuando no hay fallos');

// ---------------------------------------------------------------------------
// 2. CLASIFICACIÓN DE RESULTADOS
// ---------------------------------------------------------------------------
assert(clasificarResultado({ ok: true, resultado: { ok: true } }).estado === RESULTADOS.OK, 'Escritura confirmada → ok');
assert(clasificarResultado({ ok: true, resultado: { skipped: true, reason: 'NO_CHANGES' } }).estado === RESULTADOS.SIN_CAMBIOS, 'Sin cambios → sin_cambios (éxito idempotente)');
assert(clasificarResultado({ ok: true, accion: 'saltar', motivo: 'cooldown' }).estado === RESULTADOS.OMITIDO, 'Saltar → omitido');
assert(clasificarResultado({ ok: false, motivo: 'sin teléfono válido' }).estado === RESULTADOS.OMITIDO, 'Sin teléfono → omitido (no es fallo del motor)');
assert(clasificarResultado({ ok: false, reintentable: true, motivo: 'sin cuota' }).estado === RESULTADOS.FALLIDO, 'Reintentable agotado → fallido');
assert(clasificarResultado({ ok: true, resultado: { ok: false, error: 'x' } }).estado === RESULTADOS.FALLIDO, 'Error del sincronizador → fallido');

// ---------------------------------------------------------------------------
// 3. AISLAMIENTO ENTRE SUBCUENTAS
// ---------------------------------------------------------------------------
reiniciarLibro();
await encolarContacto({ sede: 'PALACIOS', vtigerId: 'P1', prioridad: 2 });
await encolarContacto({ sede: 'PALACIOS', vtigerId: 'P2', prioridad: 2 });
await encolarContacto({ sede: 'BENAVIDES', vtigerId: 'B1', prioridad: 2 });

assert(getEstadoSubcuenta('PALACIOS').cola === 2, 'La cola de Palacios tiene 2');
assert(getEstadoSubcuenta('BENAVIDES').cola === 1, 'La cola de Benavides tiene 1 (no comparten cola)');
assert(getEstadoSubcuenta('ROOSEVELT').cola === 0, 'Roosevelt no se ve afectado');
assert((await encolarContacto({ sede: 'LIMA', vtigerId: 'X' })).ok === false, 'Una sede inválida se rechaza');
assert((await encolarContacto({ sede: 'PIURA', vtigerId: '' })).ok === false, 'Sin vtigerId se rechaza');

// ---------------------------------------------------------------------------
// 4. EJECUCIÓN: OK, SIN CAMBIOS, OMITIDO
// ---------------------------------------------------------------------------
await encolarContacto({ sede: 'BENAVIDES', vtigerId: 'B2' });
await encolarContacto({ sede: 'BENAVIDES', vtigerId: 'B3' });

const respuestas = {
  P1: { ok: true, resultado: { ok: true } },
  P2: { ok: true, resultado: { skipped: true, reason: 'NO_CHANGES' } },
  B1: { ok: false, motivo: 'sin teléfono válido' },
  B2: { ok: true, resultado: { ok: true } },
  B3: { ok: true, resultado: { ok: true } }
};
setProcesador(async ({ id }) => respuestas[id] || { ok: true, resultado: { ok: true } });

bombear('PALACIOS');
bombear('BENAVIDES');
assert(await esperarColaVacia('PALACIOS'), 'La cola de Palacios se drena');
assert(await esperarColaVacia('BENAVIDES'), 'La cola de Benavides se drena');

const pal = getEstadoSubcuenta('PALACIOS');
assert(pal.libro.contactosOk === 1 && pal.libro.contactosSinCambios === 1, 'Palacios: 1 escritura + 1 sin cambios');
assert(pal.efectividad.efectividadPct === 100, 'Palacios queda al 100%');

const ben = getEstadoSubcuenta('BENAVIDES');
assert(ben.libro.contactosOk === 2 && ben.libro.contactosOmitidos === 1, 'Benavides: 2 escrituras + 1 omitido');
assert(ben.efectividad.efectividadPct === 100, 'Los omitidos no bajan la efectividad');

// ---------------------------------------------------------------------------
// 5. FALLO → LISTA DE FALLIDOS → REINTENTO
// ---------------------------------------------------------------------------
reiniciarLibro();
setProcesador(async () => { throw new Error('GHL 500'); });
await encolarContacto({ sede: 'PIURA', vtigerId: 'F1' });
bombear('PIURA');
assert(await esperarColaVacia('PIURA'), 'La cola se drena incluso con error');

const piura = getEstadoSubcuenta('PIURA');
assert(piura.libro.contactosFallidos === 1, 'El error cuenta como contacto fallido');
assert(piura.fallidosPendientes === 1, 'Queda en la lista de fallidos');
assert(piura.efectividad.efectividadPct === 0, 'Efectividad 0% con un fallo y cero éxitos');

// El reintento se hace cuando la causa ya se resolvió (aquí: el procesador ya funciona).
setProcesador(async () => ({ ok: true, resultado: { ok: true } }));
const reintento = await reintentarFallidos('PIURA');
assert(reintento.reencolados.PIURA === 1, 'El fallido se reencola');
assert(await esperarColaVacia('PIURA'), 'El reintento se procesa');
const piuraOk = getEstadoSubcuenta('PIURA');
assert(piuraOk.fallidosPendientes === 0 && piuraOk.libro.contactosOk === 1, 'Tras el reintento: 1 éxito y 0 fallidos pendientes');
assert(piuraOk.libro.contactosFallidos === 0, 'El fallido anterior se descuenta (no se cuenta dos veces)');
assert(piuraOk.efectividad.efectividadPct === 100, 'La efectividad vuelve al 100% cuando el contacto se recupera');

// ---------------------------------------------------------------------------
// 6. PAUSA INDEPENDIENTE
// ---------------------------------------------------------------------------
reiniciarLibro();
setProcesador(async () => ({ ok: true, resultado: { ok: true } }));
pausarSede('ROOSEVELT', 5);
await encolarContacto({ sede: 'ROOSEVELT', vtigerId: 'R1' });
bombear('ROOSEVELT');
await sleep(120);
const roosPausado = getEstadoSubcuenta('ROOSEVELT');
assert(roosPausado.pausado === true && roosPausado.cola === 1, 'Una sede pausada conserva su cola y no procesa');

await encolarContacto({ sede: 'PALACIOS', vtigerId: 'P9' });
bombear('PALACIOS');
assert(await esperarColaVacia('PALACIOS'), 'La pausa de Roosevelt NO frena a Palacios');
assert(getEstadoSubcuenta('PALACIOS').libro.contactosOk === 1, 'Palacios procesó su contacto durante la pausa de Roosevelt');

reanudarSede('ROOSEVELT');
bombear('ROOSEVELT');
assert(await esperarColaVacia('ROOSEVELT'), 'Al reanudar, Roosevelt procesa');
assert(getEstadoSubcuenta('ROOSEVELT').libro.contactosOk === 1, 'Roosevelt sincronizó su contacto');

// ---------------------------------------------------------------------------
// 7. CONSOLIDADO
// ---------------------------------------------------------------------------
const global = getEstadoGlobal();
assert(Object.keys(global.sedes).length === 4, 'El consolidado cubre las 4 subcuentas');
assert(typeof global.total.efectividadPct === 'number', 'Hay efectividad total');
assert(global.total.efectividadPct === 100, `Total al 100% (recibido ${global.total.efectividadPct})`);
assert(global.objetivos.efectividadPct === 100 && global.objetivos.fallidosPendientes === 0, 'Los objetivos están declarados (100% y 0 fallidos)');

console.log(`[SUCCESS] ${pasadas} aserciones del control por subcuenta validadas al 100%.`);
