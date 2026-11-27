#!/usr/bin/env node
/**
 * ==============================================================================
 * JORNADA — cambia el ritmo de los trabajos LOCALES según la jornada laboral
 * ==============================================================================
 * N1 (atención de redes) es prioridad SIEMPRE. Los runners locales de N2 son
 * trabajo de fondo: de día van lento para no quitarle cuota a N1, y de noche van
 * a full porque no hay chats que atender.
 *
 * MODOS
 *   oficina   07:00–22:00  N2 lento (no compite con N1)
 *   noche     23:00–06:00  N2 full performance
 *   auto      usa la hora actual
 *
 * USO
 *   node tools/jornada.mjs estado
 *   node tools/jornada.mjs oficina
 *   node tools/jornada.mjs noche
 *   node tools/jornada.mjs auto          (lo deja en modo automático por hora)
 *
 * Los runners leen `scratch/jornada.json` en cada página y ajustan su ritmo.
 * ==============================================================================
 */
import fs from 'fs';
import path from 'path';

const RUTA = path.join(process.cwd(), 'scratch', 'jornada.json');

/** Perfiles de ritmo. `pausaMs` = espera entre tandas; `concurrencia` = fichas a la vez. */
export const PERFILES = {
  oficina: { pausaMs: 1200, concurrencia: 2, etiqueta: 'OFICINA (N1 prioritario)' },
  noche: { pausaMs: 40, concurrencia: 6, etiqueta: 'NOCHE (N2 full performance)' },
  transicion: { pausaMs: 500, concurrencia: 4, etiqueta: 'TRANSICIÓN' }
};

/** Modo que corresponde a una hora (0-23). */
export function modoPorHora(hora) {
  if (hora >= 7 && hora < 22) return 'oficina';
  if (hora >= 23 || hora < 6) return 'noche';
  return 'transicion'; // 22:00–23:00 y 06:00–07:00
}

export function leerJornada() {
  try {
    const j = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
    const modo = j.auto ? modoPorHora(new Date().getHours()) : j.modo;
    return { ...j, modoEfectivo: modo, ...PERFILES[modo], actualizado: j.actualizado };
  } catch {
    const modo = modoPorHora(new Date().getHours());
    return { auto: true, modoEfectivo: modo, ...PERFILES[modo] };
  }
}

function guardar(obj) {
  fs.mkdirSync(path.dirname(RUTA), { recursive: true });
  fs.writeFileSync(RUTA, JSON.stringify({ ...obj, actualizado: new Date().toISOString() }, null, 2), 'utf8');
}

const esCLI = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jornada.mjs');
if (esCLI) {
  const accion = (process.argv[2] || 'estado').toLowerCase();

  if (accion === 'oficina' || accion === 'noche' || accion === 'transicion') {
    guardar({ auto: false, modo: accion });
    console.log(`▶ Jornada fijada en ${PERFILES[accion].etiqueta}`);
    console.log(`   ritmo: ${PERFILES[accion].pausaMs} ms entre tandas · ${PERFILES[accion].concurrencia} fichas en paralelo`);
    console.log('   los runners lo toman en la próxima página (≤ 1 min)');
  } else if (accion === 'auto') {
    guardar({ auto: true });
    const j = leerJornada();
    console.log(`▶ Jornada AUTOMÁTICA · ahora: ${j.etiqueta}`);
  } else {
    const j = leerJornada();
    console.log('=== JORNADA ===');
    console.log(`modo: ${j.auto ? 'AUTOMÁTICO por hora' : 'FIJADO a mano'} → ${j.etiqueta}`);
    console.log(`ritmo actual: ${j.pausaMs} ms · ${j.concurrencia} en paralelo`);
    console.log('');
    console.log('horarios:');
    console.log('  07:00–22:00  oficina  (N2 lento, N1 prioritario)');
    console.log('  22:00–23:00  transición');
    console.log('  23:00–06:00  noche    (N2 full performance)');
    console.log('  06:00–07:00  transición');
    if (j.actualizado) console.log(`\núltimo cambio: ${j.actualizado}`);
  }
}
