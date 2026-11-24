/**
 * Persistencia del cursor de los backfills Nivel 2 (one-shot).
 * Escribe/lee un JSON en data/ para que el avance SOBREVIVA a reinicios del servidor.
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

function fileFor(name) {
  return path.join(DATA_DIR, `state_nivel2_${name}.json`);
}

export function loadCursor(name) {
  try {
    if (!fs.existsSync(fileFor(name))) return new Map();
    const raw = fs.readFileSync(fileFor(name), 'utf8');
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

export function saveCursor(name, map) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(map);
    fs.writeFileSync(fileFor(name), JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.error(`[Nivel2-Cursor] No se pudo guardar ${name}: ${e.message}`);
  }
}

export function loadFlag(name) {
  try {
    if (!fs.existsSync(fileFor(name))) return false;
    const raw = fs.readFileSync(fileFor(name), 'utf8');
    return JSON.parse(raw)?.terminado === true;
  } catch {
    return false;
  }
}

export function saveFlag(name, terminado) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(fileFor(name), JSON.stringify({ terminado: !!terminado }), 'utf8');
  } catch (e) {
    console.error(`[Nivel2-Cursor] No se pudo guardar flag ${name}: ${e.message}`);
  }
}
