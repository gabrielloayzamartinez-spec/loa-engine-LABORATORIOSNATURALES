/**
 * ==============================================================================
 * LOA ENGINE - LOG DE AUDITORÍA ESTRUCTURADO (JSONL)
 * ==============================================================================
 * Requisito: "Registrar cualquier fallo de sincronización en un archivo de log
 * estructurado para detectar anomalías inmediatamente".
 *
 * FORMATO: una línea JSON por evento (JSON Lines) → parseable por `jq`, grep o
 * cualquier colector (Datadog, Loki, CloudWatch) sin configuración extra.
 *
 * GARANTÍAS:
 * - Nunca lanza excepción: un fallo de logging JAMÁS debe tumbar la sincronización.
 * - Rota por tamaño (5 MB) conservando el histórico reciente.
 * - Redacta secretos y datos personales antes de escribir.
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';
import { redact, sanitizeForLog, envInt } from '../config/secrets.js';

const LOG_DIR = path.join(process.cwd(), 'logs');
const AUDIT_FILE = path.join(LOG_DIR, 'audit_sync.jsonl');
const MAX_BYTES = envInt('AUDIT_LOG_MAX_BYTES', 5 * 1024 * 1024);
const KEEP_LINES = envInt('AUDIT_LOG_KEEP_LINES', 2000);

/** Contadores en proceso para /api/health y diagnóstico rápido. */
const counters = {
  total: 0,
  retries: 0,
  failures: 0,
  critical: 0,
  byType: {},
  lastEventAt: null
};

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    return true;
  } catch {
    return false; // Entorno de sólo lectura: el log se degrada a consola.
  }
}

/** Rota el archivo si excede el tamaño máximo (evita saturar el disco de Render). */
function rotateIfNeeded() {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return;
    if (fs.statSync(AUDIT_FILE).size <= MAX_BYTES) return;

    const lines = fs.readFileSync(AUDIT_FILE, 'utf-8').split('\n').filter(Boolean);
    fs.writeFileSync(AUDIT_FILE, lines.slice(-KEEP_LINES).join('\n') + '\n', 'utf-8');
    console.log(`[AUDIT] [ROTATE] Log truncado a las últimas ${KEEP_LINES} entradas (límite ${Math.round(MAX_BYTES / 1024 / 1024)} MB).`);
  } catch (e) {
    console.warn(`[AUDIT] [WARN] Rotación de log fallida: ${e.message}`);
  }
}

/**
 * Registra un evento de auditoría.
 *
 * @param {object} event
 * @param {string} event.type       ej. 'VTIGER_QUERY_FAILED', 'WEBHOOK_REJECTED'
 * @param {'info'|'warn'|'error'|'critical'} [event.severity]
 * @param {string} [event.context]  módulo o sede afectada
 * @param {object} [event.data]     datos adicionales (se redactan automáticamente)
 */
export function recordAuditEvent(event = {}) {
  // `sanitizeForLog` enmascara recursivamente cualquier llave sensible
  // (token, accessKey, secret, authorization, pit...) antes de tocar el disco.
  const { ts, type, severity, ...payload } = event;
  const record = {
    ts: ts || new Date().toISOString(),
    type: type || 'GENERIC',
    severity: severity || 'info',
    ...sanitizeForLog(payload, 0)
  };

  counters.total++;
  counters.byType[record.type] = (counters.byType[record.type] || 0) + 1;
  counters.lastEventAt = record.ts;
  if (record.type === 'VTIGER_QUERY_RETRY') counters.retries++;
  if (record.severity === 'error') counters.failures++;
  if (record.severity === 'critical') counters.critical++;

  const line = JSON.stringify(record);

  // Espejo en consola para Render (nivel según severidad).
  const logFn = record.severity === 'critical' || record.severity === 'error'
    ? console.error
    : record.severity === 'warn' ? console.warn : console.log;
  logFn(`[AUDIT] [${record.type}] ${line}`);

  try {
    if (ensureLogDir()) {
      rotateIfNeeded();
      fs.appendFileSync(AUDIT_FILE, line + '\n', 'utf-8');
    }
  } catch (e) {
    // El logging nunca debe romper la sincronización.
    console.warn(`[AUDIT] [WARN] No se pudo escribir el log de auditoría: ${e.message}`);
  }

  return record;
}

/**
 * Lee los últimos eventos (para /api/audit/log o diagnóstico manual).
 * @param {number} limit
 * @param {string} [typeFilter]
 */
export function readAuditEvents(limit = 50, typeFilter = '') {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];
    const lines = fs.readFileSync(AUDIT_FILE, 'utf-8').split('\n').filter(Boolean);
    const filtered = typeFilter ? lines.filter(l => l.includes(`"type":"${typeFilter}"`)) : lines;
    return filtered
      .slice(-limit)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

export function getAuditMetrics() {
  return {
    ...counters,
    file: AUDIT_FILE,
    exists: fs.existsSync(AUDIT_FILE),
    sizeBytes: (() => { try { return fs.statSync(AUDIT_FILE).size; } catch { return 0; } })()
  };
}

// Alias explícito para secretos: se exporta para que otros módulos no escriban
// valores sensibles directamente en consola.
export { redact };
