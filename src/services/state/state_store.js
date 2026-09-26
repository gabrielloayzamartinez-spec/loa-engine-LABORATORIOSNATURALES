/**
 * ==============================================================================
 * LOA ENGINE - ESTADO PERSISTENTE (ARQUITECTURA STATELESS)
 * ==============================================================================
 * PROBLEMA RESUELTO: el proceso de Node NO debe ser la fuente de verdad.
 * Cursores del curador, historial y el "learning_brain" viven en un almacén
 * durable, de modo que un redeploy de Render, un escalado horizontal o un
 * reinicio por OOM no pierdan progreso ni reaprendizaje.
 *
 * DRIVERS:
 * - `postgres` (DATABASE_URL + PERSISTENCE_DRIVER=postgres): tabla única `loa_state`.
 * - `file` (por defecto): respaldo local con escritura ATÓMICA (tmp + rename),
 *   que además sirve de fallback automático si PostgreSQL no responde.
 *
 * FAIL-SAFE: cualquier error del driver externo degrada a `file` con un WARN.
 * El motor nunca muere en el arranque por un problema de base de datos.
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { readSecret, envInt } from '../../config/secrets.js';

const require = createRequire(import.meta.url);

export const PERSISTENCE_DRIVER = String(readSecret('PERSISTENCE_DRIVER') || 'file').toLowerCase();
const DATABASE_URL = readSecret('DATABASE_URL');

const DATA_DIR = path.join(process.cwd(), 'data');
const TABLE = 'loa_state';

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) { /* directorio no escribible: el driver file degradará a memoria */ }
}

// ------------------------------------------------------------------------------
// DRIVER FILE (ESCRITURA ATÓMICA)
// ------------------------------------------------------------------------------
class FileStateDriver {
  constructor(namespace) {
    this.namespace = namespace;
    this.file = path.join(DATA_DIR, `state_${namespace}.json`);
    this._cache = null;
    this._writeTimer = null;
    this._dirty = false;
    ensureDataDir();
  }

  _load() {
    if (this._cache) return this._cache;
    try {
      if (fs.existsSync(this.file)) {
        this._cache = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
        if (typeof this._cache !== 'object' || this._cache === null) this._cache = {};
      } else {
        this._cache = {};
      }
    } catch (e) {
      console.warn(`[STATE:${this.namespace}] [WARN] Archivo ilegible (${e.message}). Se inicia estado vacío sin perder el proceso.`);
      this._cache = {};
    }
    return this._cache;
  }

  async get(key) {
    const data = this._load();
    return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
  }

  async set(key, value) {
    const data = this._load();
    data[key] = value;
    this._dirty = true;
    this._scheduleFlush();
    return true;
  }

  async del(key) {
    const data = this._load();
    delete data[key];
    this._dirty = true;
    this._scheduleFlush();
    return true;
  }

  async keys() {
    return Object.keys(this._load());
  }

  _scheduleFlush() {
    if (this._writeTimer) return;
    const debounceMs = envInt('STATE_FLUSH_MS', 1500);
    this._writeTimer = setTimeout(() => { this.flush().catch(() => {}); }, debounceMs);
  }

  async flush() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    if (!this._dirty) return true;
    const tmp = `${this.file}.tmp`;
    try {
      // Escritura atómica: nunca se deja un JSON truncado si el proceso muere.
      fs.writeFileSync(tmp, JSON.stringify(this._cache, null, 2), 'utf-8');
      fs.renameSync(tmp, this.file);
      this._dirty = false;
      return true;
    } catch (e) {
      console.error(`[STATE:${this.namespace}] [ERROR] No se pudo persistir el estado: ${e.message}`);
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* limpieza best-effort */ }
      return false;
    }
  }

  async close() {
    return this.flush();
  }

  describe() {
    return { driver: 'file', namespace: this.namespace, file: this.file };
  }
}

// ------------------------------------------------------------------------------
// DRIVER POSTGRES (FUENTE DE VERDAD DISTRIBUIDA)
// ------------------------------------------------------------------------------
class PostgresStateDriver {
  constructor(namespace, pool) {
    this.namespace = namespace;
    this.pool = pool;
    this.ready = false;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        namespace  TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (namespace, key)
      )
    `);
    this.ready = true;
    return true;
  }

  async get(key) {
    const { rows } = await this.pool.query(
      `SELECT value FROM ${TABLE} WHERE namespace = $1 AND key = $2`,
      [this.namespace, key]
    );
    return rows.length > 0 ? rows[0].value : null;
  }

  async set(key, value) {
    await this.pool.query(
      `INSERT INTO ${TABLE} (namespace, key, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (namespace, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [this.namespace, key, JSON.stringify(value)]
    );
    return true;
  }

  async del(key) {
    await this.pool.query(`DELETE FROM ${TABLE} WHERE namespace = $1 AND key = $2`, [this.namespace, key]);
    return true;
  }

  async keys() {
    const { rows } = await this.pool.query(`SELECT key FROM ${TABLE} WHERE namespace = $1`, [this.namespace]);
    return rows.map(r => r.key);
  }

  async flush() { return true; }
  async close() { return true; }
  describe() { return { driver: 'postgres', namespace: this.namespace, table: TABLE }; }
}

// ------------------------------------------------------------------------------
// DRIVER MEMORIA (ÚLTIMO RECURSO, NUNCA FALLA)
// ------------------------------------------------------------------------------
class MemoryStateDriver {
  constructor(namespace) {
    this.namespace = namespace;
    this.map = new Map();
  }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async set(key, value) { this.map.set(key, value); return true; }
  async del(key) { this.map.delete(key); return true; }
  async keys() { return [...this.map.keys()]; }
  async flush() { return true; }
  async close() { return true; }
  describe() { return { driver: 'memory', namespace: this.namespace }; }
}

// ------------------------------------------------------------------------------
// FACHADA: STATESTORE
// ------------------------------------------------------------------------------
let _pool = null;
let _pgAvailable = null;
let _degradeReason = null;

async function getPool() {
  if (_pool) return _pool;
  if (_pgAvailable === false) return null;
  try {
    const { Pool } = require('pg');
    _pool = new Pool({
      connectionString: DATABASE_URL,
      max: envInt('PG_POOL_MAX', 5),
      connectionTimeoutMillis: envInt('PG_CONNECT_TIMEOUT_MS', 3000),
      idleTimeoutMillis: 30000
    });
    _pool.on('error', (err) => console.warn(`[STATE] [PG-WARN] ${err.message}`));
    _pgAvailable = true;
    return _pool;
  } catch (err) {
    _pgAvailable = false;
    _degradeReason = `driver 'pg' no disponible: ${err.message}`;
    console.warn(`[STATE] [DEGRADADO] ${_degradeReason}. Se usa persistencia en archivo (fail-safe).`);
    return null;
  }
}

/**
 * Almacén de estado por namespace ('learning_brain', 'curator_cursors', ...).
 * `get`/`set` mantienen una caché en memoria para lecturas calientes, pero el
 * valor autoritativo siempre se escribe en el driver durable.
 */
export class StateStore {
  constructor(namespace) {
    this.namespace = namespace;
    this.driver = new FileStateDriver(namespace);
    this._hydrated = false;
  }

  /**
   * Hidrata el store desde el driver durable (PostgreSQL si está configurado).
   * Se invoca explícitamente en el arranque, fuera del camino crítico.
   */
  async hydrate() {
    if (this._hydrated) return this.describe();
    if (PERSISTENCE_DRIVER !== 'postgres') {
      this._hydrated = true;
      return this.describe();
    }
    if (!DATABASE_URL) {
      console.warn('[STATE] [WARN] PERSISTENCE_DRIVER=postgres sin DATABASE_URL. Persistiendo en archivo.');
      this._hydrated = true;
      return this.describe();
    }
    const pool = await getPool();
    if (!pool) {
      this._hydrated = true;
      return this.describe();
    }
    try {
      const pgDriver = new PostgresStateDriver(this.namespace, pool);
      await pgDriver.init();
      this.driver = pgDriver;
      console.log(`[STATE] [POSTGRES] Namespace '${this.namespace}' montado sobre PostgreSQL (${TABLE}).`);
    } catch (err) {
      _degradeReason = err.message;
      console.error(`[STATE] [DEGRADADO] PostgreSQL no respondió (${err.message}). Fallback a archivo local: el motor continúa operando.`);
    }
    this._hydrated = true;
    return this.describe();
  }

  async get(key, fallback = null) {
    try {
      const value = await this.driver.get(key);
      return value === null || value === undefined ? fallback : value;
    } catch (err) {
      console.warn(`[STATE:${this.namespace}] [READ-WARN] ${err.message}. Devolviendo fallback sin romper el flujo.`);
      return fallback;
    }
  }

  async set(key, value) {
    try {
      await this.driver.set(key, value);
      return true;
    } catch (err) {
      console.warn(`[STATE:${this.namespace}] [WRITE-WARN] ${err.message}. Operación no persistida (el proceso sigue vivo).`);
      return false;
    }
  }

  async del(key) {
    try { return await this.driver.del(key); } catch (err) { return false; }
  }

  async keys() {
    try { return await this.driver.keys(); } catch (err) { return []; }
  }

  async flush() {
    try { return await this.driver.flush(); } catch (err) { return false; }
  }

  async close() {
    try { return await this.driver.close(); } catch (err) { return false; }
  }

  describe() {
    return { ...this.driver.describe(), configuredDriver: PERSISTENCE_DRIVER, degraded: _degradeReason !== null, degradeReason: _degradeReason };
  }
}

const stores = new Map();

export function getStateStore(namespace = 'default') {
  if (!stores.has(namespace)) stores.set(namespace, new StateStore(namespace));
  return stores.get(namespace);
}

/**
 * Hidrata en paralelo todos los stores creados (uso típico: callback de listen()).
 */
export async function hydrateAllStores() {
  const results = await Promise.all([...stores.values()].map(s => s.hydrate()));
  return results;
}

export async function shutdownStateStores() {
  for (const store of stores.values()) {
    await store.close();
  }
  if (_pool) {
    try { await _pool.end(); } catch (e) { /* best-effort */ }
    _pool = null;
  }
}
