#!/usr/bin/env node
/**
 * ==============================================================================
 * CONTROL DE TRABAJOS — PAUSAR / REANUDAR LOS RUNNERS SIN REINICIARLOS
 * ==============================================================================
 * Los runners leen `scratch/runner_control.json` en cada página. Si está pausado,
 * esperan sin gastar cuota y siguen solos cuando se reanuda (o cuando vence la hora).
 *
 * USO
 *   node tools/runner_control.mjs estado
 *   node tools/runner_control.mjs pausar --motivo="almuerzo" --minutos=60
 *   node tools/runner_control.mjs pausar --sede=ROOSEVELT --motivo="mantenimiento"
 *   node tools/runner_control.mjs reanudar
 *   node tools/runner_control.mjs reanudar --sede=ROOSEVELT
 *
 * Sin --minutos, la pausa es INDEFINIDA hasta que se reanude a mano.
 * ==============================================================================
 */
import fs from 'fs';
import path from 'path';

const RUTA = path.join(process.cwd(), 'scratch', 'runner_control.json');

export function leerControl() {
  try {
    const c = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
    return { pausado: false, hasta: null, motivo: null, porSede: {}, ...c };
  } catch {
    return { pausado: false, hasta: null, motivo: null, porSede: {} };
  }
}

function guardar(control) {
  fs.mkdirSync(path.dirname(RUTA), { recursive: true });
  fs.writeFileSync(RUTA, JSON.stringify(control, null, 2), 'utf8');
}

/** ¿Está pausada esta sede ahora mismo? (pausa global o de sede, con vencimiento) */
export function estaPausado(sede) {
  const c = leerControl();
  const ahora = Date.now();
  const vencida = c.hasta ? new Date(c.hasta).getTime() < ahora : false;

  if (c.pausado && !vencida) {
    return { pausado: true, motivo: c.motivo || 'pausa global', hasta: c.hasta };
  }
  const porSede = c.porSede?.[String(sede || '').toUpperCase()];
  if (porSede?.pausado) {
    const vence = porSede.hasta ? new Date(porSede.hasta).getTime() < ahora : false;
    if (!vence) return { pausado: true, motivo: porSede.motivo || 'pausa de sede', hasta: porSede.hasta };
  }
  return { pausado: false };
}

export function pausar({ sede = null, minutos = null, motivo = 'pausa manual' } = {}) {
  const c = leerControl();
  const hasta = minutos ? new Date(Date.now() + Math.max(1, minutos) * 60000).toISOString() : null;

  if (sede) {
    const id = String(sede).toUpperCase();
    c.porSede = c.porSede || {};
    c.porSede[id] = { pausado: true, desde: new Date().toISOString(), hasta, motivo };
    guardar(c);
    return { ok: true, alcance: id, hasta, motivo };
  }
  c.pausado = true;
  c.desde = new Date().toISOString();
  c.hasta = hasta;
  c.motivo = motivo;
  guardar(c);
  return { ok: true, alcance: 'TODAS', hasta, motivo };
}

export function reanudar({ sede = null } = {}) {
  const c = leerControl();
  if (sede) {
    const id = String(sede).toUpperCase();
    if (c.porSede?.[id]) {
      c.porSede[id] = { pausado: false, hasta: null, motivo: null };
      guardar(c);
    }
    return { ok: true, alcance: id, reanudado: true };
  }
  c.pausado = false;
  c.hasta = null;
  c.motivo = null;
  c.desde = null;
  for (const id of Object.keys(c.porSede || {})) c.porSede[id] = { pausado: false, hasta: null, motivo: null };
  guardar(c);
  return { ok: true, alcance: 'TODAS', reanudado: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const esCLI = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('runner_control.mjs');
if (esCLI) {
  const [accion = 'estado', ...resto] = process.argv.slice(2);
  const op = {};
  for (const a of resto) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) op[m[1]] = m[2] === undefined ? true : m[2];
  }
  const minutos = op.minutos ? parseInt(op.minutos, 10) : null;

  if (accion === 'pausar') {
    const r = pausar({ sede: op.sede, minutos, motivo: op.motivo || 'pausa manual' });
    console.log(`⏸  Pausado: ${r.alcance} · motivo: ${r.motivo} · ${r.hasta ? 'hasta ' + new Date(r.hasta).toLocaleString('es-PE') : 'INDEFINIDO (reanudar a mano)'}`);
  } else if (accion === 'reanudar') {
    const r = reanudar({ sede: op.sede });
    console.log(`▶  Reanudado: ${r.alcance}`);
  } else {
    const c = leerControl();
    const estado = estaPausado(op.sede || '');
    console.log('=== CONTROL DE TRABAJOS ===');
    console.log(`Global: ${c.pausado ? 'PAUSADO' : 'corriendo'}${c.pausado && c.hasta ? ' (hasta ' + new Date(c.hasta).toLocaleString('es-PE') + ')' : ''}${c.motivo ? ' · ' + c.motivo : ''}`);
    const sedes = Object.entries(c.porSede || {}).filter(([, v]) => v?.pausado);
    if (sedes.length) console.log('Sedes pausadas: ' + sedes.map(([k, v]) => `${k}${v.hasta ? ' (hasta ' + new Date(v.hasta).toLocaleTimeString('es-PE') + ')' : ''}`).join(', '));
    else console.log('Sedes pausadas: ninguna');
    if (op.sede) console.log(`Estado de ${String(op.sede).toUpperCase()}: ${estado.pausado ? 'PAUSADA (' + estado.motivo + ')' : 'trabajando'}`);
  }
}
