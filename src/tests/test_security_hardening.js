/**
 * ==============================================================================
 * LOA ENGINE - SUITE DE SEGURIDAD Y RESILIENCIA (OFFLINE)
 * ==============================================================================
 * Cubre los requisitos de nivel empresarial sin tocar la red:
 *   1. Saneado estricto de payloads (XSS, prototype pollution, allow-list, límites).
 *   2. Neutralización de inyección en consultas vTiger (entrada y salida).
 *   3. Aislamiento multi-tenant (allow-list de sede; nunca consultar la base completa).
 *   4. Reintentos: backoff exponencial con jitter y clasificación de errores.
 *   5. Idempotencia de la cola de reintentos (encolar 2 veces != 2 registros).
 *   6. Auditoría: redacción de secretos y formato estructurado.
 *
 * Ejecución:  node src/tests/test_security_hardening.js
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';
import {
  sanitizeContactPayload, sanitizeString, sanitizeId, sanitizePhone, sanitizeEmail,
  sanitizeUrl, sanitizeEnum, escapeHtml, sanitizeForVtigerQuery, digitsOnly,
  sanitizeObject, detectInjectionPatterns, LIMITS
} from '../utils/sanitize.js';
import { computeBackoffDelay, isRetryableError, sedeClause, buildSelect, VTIGER_MODULES } from '../services/vtigerClient.js';
import { enqueueVtigerRetry, computeRetryDelay, getVtigerQueueCount, getVtigerQueueStatus } from '../services/vtiger_retry_queue.js';
import { recordAuditEvent, getAuditMetrics, readAuditEvents } from '../services/audit_logger.js';
import { redact } from '../config/secrets.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

console.log('\n==========================================================');
console.log(' [TEST] SEGURIDAD Y RESILIENCIA DEL MOTOR');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
// 1. SANEADO DE ENTRADA
// ------------------------------------------------------------------------------
console.log('[TEST 1] Saneado estricto de payloads');

// XSS almacenado
assert(sanitizeString('<script>alert(1)</script>', 100) === 'scriptalert(1)/script', 'Los ángulos se eliminan del texto');

// Controles y saltos de línea (inyección de cabeceras / notas multilínea)
assert(!sanitizeString('linea1\nlinea2\rmas', 100).includes('\n'), 'Los saltos de línea se neutralizan');

// Truncado por límite
assert(sanitizeString('a'.repeat(1000), LIMITS.NAME).length === LIMITS.NAME, `El texto se trunca al límite del campo (${LIMITS.NAME})`);

// IDs: allow-list de alfabeto
assert(sanitizeId('abc123-XYZ_9') === 'abc123-XYZ_9', 'Un ID válido se conserva íntegro');
assert(sanitizeId("' OR 1=1--") === 'OR11--', 'Un ID elimina comillas, espacios y símbolos peligrosos');

// Teléfonos NANP
assert(sanitizePhone('+1 (305) 555-1234') === '+13055551234', 'El teléfono conserva dígitos y "+" inicial');
assert(sanitizePhone("305'; DROP") === '305', 'Un teléfono manipulado queda sólo con dígitos');

// Email
assert(sanitizeEmail('Juan.Perez@Mail.COM') === 'juan.perez@mail.com', 'El email se normaliza a minúsculas');
assert(sanitizeEmail('no-es-un-email') === '', 'Un email inválido se descarta por completo');
assert(sanitizeEmail('a@b.com\r\nBcc: victima@x.com') === '', 'Se bloquea la inyección de cabeceras por salto de línea (el email se invalida y descarta)');

// URLs: sólo http/https
assert(sanitizeUrl('https://ok.com/x') === 'https://ok.com/x', 'Una URL https se acepta');
assert(sanitizeUrl('javascript:alert(1)') === '', 'Se bloquea el esquema javascript:');
assert(sanitizeUrl('data:text/html;base64,PHNjcmlwdD4=') === '', 'Se bloquea el esquema data:');

// Enum
assert(sanitizeEnum('benavides', ['PALACIOS', 'BENAVIDES'], '') === 'BENAVIDES', 'El enum valida contra la allow-list');
assert(sanitizeEnum('HACKED', ['PALACIOS', 'BENAVIDES'], '') === '', 'Un valor fuera de la allow-list se rechaza');

// Escape de salida (UI / notas del CRM)
const escapado = escapeHtml('<img src=x onerror=alert(1)>');
assert(!escapado.includes('<') && !escapado.includes('>'), 'escapeHtml neutraliza etiquetas para renderizado');

// Prototype pollution
const contaminado = sanitizeObject(JSON.parse('{"a":1,"__proto__":{"pwned":true}}'));
assert(Object.prototype.pwned === undefined, 'sanitizeObject impide contaminar Object.prototype');
assert(contaminado.a === 1, 'sanitizeObject conserva los campos legítimos');

// Allow-list del payload de contacto
const payload = sanitizeContactPayload({
  firstName: 'Juan<script>',
  lastName: 'Perez',
  email: 'juan@mail.com',
  phone: '(305) 555-1234',
  campoInventado: 'no-debe-pasar',
  __proto__: { x: 1 },
  tags: ['<b>Tag</b>', 'sede-benavides'],
  customFields: [{ id: 'abc123', field_value: '<i>v</i>' }, { id: '###', field_value: 'se descarta' }]
});
assert(!('campoInventado' in payload), 'Los campos fuera de la allow-list se descartan');
assert(payload.firstName === 'Juanscript', 'El nombre queda saneado');
assert(payload.tags.length === 2 && !payload.tags[0].includes('<'), 'Las etiquetas se sanean y normalizan');
assert(payload.customFields.length === 1, 'Los custom fields con id inválido se descartan');
assert(!payload.customFields[0].field_value.includes('<'), 'Los valores de custom fields se sanean');

// Detección forense (no bloquea silenciosamente: audita)
assert(detectInjectionPatterns({ q: "' OR '1'='1" }).suspicious, 'Detecta tautología SQL');
assert(detectInjectionPatterns({ q: 'UNION SELECT password FROM users' }).suspicious, 'Detecta UNION SELECT');
assert(detectInjectionPatterns({ q: 'Maria Rodriguez' }).suspicious === false, 'No genera falsos positivos con datos reales');

// ------------------------------------------------------------------------------
// 2. CONSULTAS vTIGER: INYECCIÓN Y NOMENCLATURA NATIVA
// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Consultas vTiger: inyección y nomenclatura nativa');
const inyectado = sanitizeForVtigerQuery("O'Brien' OR '1'='1; DROP TABLE Contacts--");
assert(!inyectado.includes(';'), 'El terminador de sentencia se elimina');
assert(inyectado.includes("\\'"), 'Las comillas simples se escapan');
// Con comillas y punto y coma neutralizados, el contenido queda encerrado dentro
// del literal SQL: ningún fragmento sobrevive como sintaxis ejecutable.
const comillaCruda = /(^|[^\\])'/.test(inyectado.replace(/\\\\/g, ''));
assert(!comillaCruda, 'No sobrevive ninguna comilla sin escapar (el valor queda dentro del literal)');
assert(sanitizeForVtigerQuery('abc\\') === 'abc\\\\', 'Una barra invertida final se duplica (no anula el escape de la comilla siguiente)');
assert(digitsOnly('(305) 555-1234') === '3055551234', 'digitsOnly deja un teléfono puro para consultas');

assert(buildSelect({ module: VTIGER_MODULES.CONTACTS, fields: 'id, firstname', where: "id = 'x'", limit: 5 })
  === "SELECT id, firstname FROM Contacts WHERE id = 'x' LIMIT 5", 'buildSelect usa nomenclatura nativa de vTiger');
let rechazado = false;
try { buildSelect({ module: 'Contacts; DROP TABLE Users' }); } catch { rechazado = true; }
assert(rechazado, 'buildSelect rechaza módulos que no son nativos');

// ------------------------------------------------------------------------------
// 3. AISLAMIENTO MULTI-TENANT CON UN SOLO API KEY GLOBAL
// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Aislamiento multi-tenant con una sola credencial de Administrador');
assert(sedeClause('BENAVIDES').includes("cf_3451 = 'BENAVIDES'"), 'La cláusula filtra por el campo nativo de sede');
assert(sedeClause('').includes('__SIN_SEDE__'), 'Sin sede declarada NO se consulta la base completa');
assert(sedeClause('SEDE_FALSA').includes('__SIN_SEDE__'), 'Una sede inexistente se bloquea');
assert(sedeClause("PALACIOS' OR '1'='1").includes('__SIN_SEDE__'), 'Una sede manipulada se rechaza por allow-list, no se "limpia"');

// ------------------------------------------------------------------------------
// 4. REINTENTOS: BACKOFF EXPONENCIAL
// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Backoff exponencial con jitter');
const d1 = computeBackoffDelay(1, 1000, 60000);
const d2 = computeBackoffDelay(2, 1000, 60000);
const d3 = computeBackoffDelay(3, 1000, 60000);
assert(d1 >= 1000, `El primer reintento respeta la base (${d1}ms)`);
assert(d2 > d1 && d3 > d2, `El backoff crece exponencialmente (${d1} → ${d2} → ${d3} ms)`);
assert(computeBackoffDelay(20, 1000, 8000) <= 8000, 'El backoff está acotado por el máximo');
const muestras = new Set(Array.from({ length: 20 }, () => computeBackoffDelay(4, 1000, 60000)));
assert(muestras.size > 1, 'El jitter produce valores distintos (evita el thundering herd entre las 2 sedes)');

// Clasificación: no reintentar errores de dato
assert(isRetryableError(new Error('504 Gateway Timeout')) === true, 'Reintenta ante 5xx');
assert(isRetryableError(new Error('fetch failed')) === true, 'Reintenta ante fallo de red');
assert(isRetryableError(new Error('Invalid query: mandatory field missing')) === false, 'NO reintenta un error de dato (falla rápido)');
assert(isRetryableError(new Error('Permission denied')) === false, 'NO reintenta un error de permisos');

// ------------------------------------------------------------------------------
// 5. IDEMPOTENCIA DE LA COLA DE REINTENTOS
// ------------------------------------------------------------------------------
console.log('\n[TEST 5] Idempotencia de la cola de reintentos');
const idPrueba = `test-idempotencia-${Date.now()}`;
const antes = getVtigerQueueCount();
const r1 = enqueueVtigerRetry(idPrueba, 'timeout simulado');
const r2 = enqueueVtigerRetry(idPrueba, 'timeout simulado (repetido)');
const r3 = enqueueVtigerRetry(idPrueba);
assert(r1.queued === true && r1.deduplicated === false, 'El primer encolado inserta la entrada');
assert(r2.deduplicated === true && r3.deduplicated === true, 'Encolar el mismo contacto NO duplica la entrada (idempotente)');
assert(getVtigerQueueCount() === antes + 1, 'La cola creció exactamente 1 (no 3)');
const estado = getVtigerQueueStatus();
assert(estado.entries.some(e => e.contactId === idPrueba && e.attempts === 0), 'El reencolado no reinicia ni incrementa los intentos por sí solo');
assert(computeRetryDelay(1, 1000, 60000) >= 1000 && computeRetryDelay(5, 1000, 60000) > computeRetryDelay(1, 1000, 60000), 'El retraso de la cola también es exponencial');

// ------------------------------------------------------------------------------
// 6. AUDITORÍA: REDACCIÓN Y FORMATO ESTRUCTURADO
// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Log de auditoría estructurado');
assert(redact('pit-00000000-1111-2222-3333-444444444444').includes('****'), 'redact enmascara un secreto largo');
assert(!redact('secreto-muy-largo-123456').includes('123456'), 'redact no expone la parte final del secreto');

const evento = recordAuditEvent({
  type: 'TEST_AUDIT',
  severity: 'warn',
  contactId: 'abc123',
  accessKey: 'clave-supersecreta-que-no-debe-salir',
  token: 'pit-00000000-1111-2222-3333-444444444444'
});
const serializado = JSON.stringify(evento);
assert(!serializado.includes('clave-supersecreta-que-no-debe-salir'), 'El log redacta accessKey automáticamente');
assert(!serializado.includes('pit-00000000-1111'), 'El log redacta tokens automáticamente');

const metricas = getAuditMetrics();
assert(metricas.total > 0 && metricas.byType.TEST_AUDIT === 1, 'Las métricas de auditoría contabilizan por tipo');

const leidos = readAuditEvents(10, 'TEST_AUDIT');
assert(leidos.length >= 1 && leidos[0].type === 'TEST_AUDIT', 'Los eventos se persisten en formato JSONL y se pueden releer');
assert(fs.existsSync(path.join(process.cwd(), 'logs', 'audit_sync.jsonl')), 'El archivo de auditoría existe en logs/audit_sync.jsonl');

console.log('\n==========================================================');
console.log(` [METRICS] ${passed} pasadas, ${failed} fallidas`);
console.log('==========================================================\n');

process.exit(failed > 0 ? 1 : 0);
