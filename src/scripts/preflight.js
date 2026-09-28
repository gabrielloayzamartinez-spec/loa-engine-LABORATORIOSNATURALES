#!/usr/bin/env node
/**
 * ==============================================================================
 * LOA ENGINE - PREFLIGHT (GATE DE ARRANQUE OFFLINE, < 5 s)
 * ==============================================================================
 * Simula EXACTAMENTE lo que Render evalúa al arrancar, pero sin abrir puertos
 * ni tocar la red. Sirve para validar la rama ANTES del merge:
 *
 *   npm run preflight
 *
 * Verifica, en orden:
 *   1. Carga segura de secretos (fail-safe, sin valores hardcodeados).
 *   2. Pre-Flight Sanity Check protocolar completo (reglas de negocio).
 *   3. Presupuesto de tiempo del gate (< PREFLIGHT_MAX_MS, por defecto 5000 ms).
 *
 * Códigos de salida: 0 = apto para deploy, 1 = bloqueado.
 * ==============================================================================
 */

import { runPreFlightSanityCheck } from '../tests/test_audit_engine.js';
import { auditSecrets } from '../config/secrets.js';
import { getOperationalSedeIds, getDegradedSedes, SEDES_GATEWAY } from '../config/sedes_gateway.js';
import { getQueueStatus } from '../services/queue/durable_queue.js';
import { normalizeTreatment, CANONICAL_TREATMENTS } from '../domain/clinical_vocabulary.js';
import { learningBrain } from '../services/learning_brain.js';
import { getVtigerConfigStatus, assertTenantIsolation, assertReadOnlyStatement, assertReadOnlyHttpMethod, assertAllowedOperation } from '../services/vtigerClient.js';
import { sanitizeForVtigerQuery, sanitizeContactPayload, escapeHtml } from '../utils/sanitize.js';
import { evaluateCommercialTruth } from '../domain/commercial_engine.js';
import { detectSystemMessage, resolveChannelFromEvent } from '../utils/system_message_filter.js';
import { normalizeTreatmentOrUnknown } from '../domain/clinical_vocabulary.js';

const BUDGET_MS = parseInt(process.env.PREFLIGHT_MAX_MS || '5000', 10);
const startedAt = Date.now();

console.log('==========================================================');
console.log(' LOA ENGINE - PREFLIGHT GATE (offline)');
console.log('==========================================================');

let failures = 0;

// ------------------------------------------------------------------------------
// 1. ARQUITECTURA: la cuenta central no debe existir en ninguna forma
// ------------------------------------------------------------------------------
console.log('\n[1/8] Arquitectura descentralizada (point-to-point)');
if ('CENTRAL' in SEDES_GATEWAY) {
  console.error('  [FAIL] SEDES_GATEWAY.CENTRAL sigue presente: purga incompleta del GHL Central.');
  failures++;
} else {
  console.log('  [PASS] Sin cuenta central: cada sede opera con su propio PIT + Location ID.');
}
const centralFlags = Object.values(SEDES_GATEWAY).filter(s => s.allowActiveRouting !== undefined || s.isUniversalCentral !== undefined);
if (centralFlags.length > 0) {
  console.error(`  [FAIL] Persisten banderas centrales en: ${centralFlags.map(s => s.sedeId).join(', ')}`);
  failures++;
} else {
  console.log('  [PASS] Sin banderas heredadas (allowActiveRouting / isUniversalCentral).');
}

// ------------------------------------------------------------------------------
// 2. SECRETOS: fail-safe, sin fallbacks hardcodeados
// ------------------------------------------------------------------------------
console.log('\n[2/8] Auditoría de secretos (fail-safe)');
const secretReport = auditSecrets({ operationalSedes: getOperationalSedeIds() });
for (const w of secretReport.warnings) console.warn(`  [WARN] ${w}`);
if (secretReport.fatal.length > 0) {
  for (const f of secretReport.fatal) console.error(`  [FAIL] ${f}`);
  failures += secretReport.fatal.length;
}
console.log(`  [INFO] Secretos cargados: ${secretReport.summary.loaded}/${secretReport.summary.total} | Entorno: ${secretReport.summary.environment} | STRICT: ${secretReport.summary.strict}`);
for (const sede of getDegradedSedes()) {
  console.warn(`  [WARN] Sede ${sede.sedeId} encendida pero SIN credenciales: quedará inoperativa (el motor no se detiene).`);
}
if (failures === 0) console.log('  [PASS] Ningún secreto crítico ausente.');

// ------------------------------------------------------------------------------
// 3. SANITY CHECK PROTOCOLAR
// ------------------------------------------------------------------------------
console.log('\n[3/8] Pre-Flight Sanity Check protocolar');
const sanityOk = runPreFlightSanityCheck();
if (!sanityOk) {
  console.error('  [FAIL] El motor no superó el sanity check protocolar.');
  failures++;
}
const elapsed = Date.now() - startedAt;

// ------------------------------------------------------------------------------
// 4. VOCABULARIO CLÍNICO: cada padecimiento del manual debe ser aprendible
// ------------------------------------------------------------------------------
console.log('\n[4/8] Vocabulario clínico canónico (vTiger -> Cerebro)');
const VTIGER_LABELS_DEL_MANUAL = ['Artritis', 'Tetosterona', 'Diabetes', 'Hongos', 'Gastro', 'Gummies', 'Prostata', 'Colageno', 'Vision'];
const noReconocidos = VTIGER_LABELS_DEL_MANUAL.filter(l => normalizeTreatment(l) === null);
if (noReconocidos.length > 0) {
  console.error(`  [FAIL] Padecimientos de vTiger no reconocidos por el motor: ${noReconocidos.join(', ')}`);
  failures++;
} else {
  console.log(`  [PASS] Los ${VTIGER_LABELS_DEL_MANUAL.length} padecimientos oficiales resuelven a un nombre canónico.`);
}
const noAprendibles = CANONICAL_TREATMENTS.filter(t => !learningBrain.memory.treatments.includes(t));
if (noAprendibles.length > 0) {
  console.error(`  [FAIL] El cerebro no puede aprender: ${noAprendibles.join(', ')} (las ventas se descartarían en silencio)`);
  failures++;
} else {
  console.log(`  [PASS] El cerebro acepta los ${CANONICAL_TREATMENTS.length} tratamientos (incluye Hongos y Gummies).`);
}
if (normalizeTreatment('Tetosterona') !== 'Potencia') {
  console.error("  [FAIL] Regresión: 'Tetosterona' (vTiger) debe normalizarse a 'Potencia'.");
  failures++;
} else {
  console.log("  [PASS] Mapeo crítico verificado: vTiger 'Tetosterona' -> cerebro 'Potencia'.");
}

// ------------------------------------------------------------------------------
// 5. FILTRO DE ENTRADA Y ATRIBUCIÓN HONESTA (ticket del falso positivo OTP)
// ------------------------------------------------------------------------------
console.log('\n[5/8] Filtro de entrada y atribución honesta');

// 5.1 El mensaje del incidente debe descartarse sin tocar el CRM.
if (!detectSystemMessage('Your WhatsApp code: 825-319').isSystem) {
  console.error('  [FAIL] El filtro NO descarta el SMS con código OTP (incidente del radar de entrada).');
  failures++;
} else {
  console.log('  [PASS] Early drop activo: un SMS con OTP se descarta sin crear contacto ni oportunidad.');
}

// 5.2 Un lead real NO debe descartarse (anti falso positivo del propio filtro).
let leadsDescartados = 0;
for (const t of ['Hola me interesan las gomitas de colageno', 'MUESTRA GRATIS POTENCIA', 'cuanto cuesta?']) {
  if (detectSystemMessage(t).isSystem) leadsDescartados++;
}
if (leadsDescartados > 0) {
  console.error(`  [FAIL] El filtro descarta ${leadsDescartados} lead(s) real(es): perder un lead es peor que procesar ruido.`);
  failures++;
} else {
  console.log('  [PASS] El filtro no descarta leads reales (sin falsos positivos).');
}

// 5.3 El canal no se inventa.
if (resolveChannelFromEvent({ type: 'SMS' }) !== 'SMS' || resolveChannelFromEvent({}) !== 'DESCONOCIDO') {
  console.error('  [FAIL] El canal no deriva del transporte real (SMS debe ser SMS; sin evidencia, DESCONOCIDO).');
  failures++;
} else {
  console.log('  [PASS] Canal derivado del transporte: SMS != FB-MSGR y sin evidencia es DESCONOCIDO.');
}

// 5.4 Sin evidencia, el tratamiento queda en triage (no se atribuye producto).
if (normalizeTreatmentOrUnknown('') !== 'Desconocido') {
  console.error('  [FAIL] Un lead sin dolencia identificable no queda en triage.');
  failures++;
} else {
  console.log('  [PASS] Triage: sin dolencia identificable el estado es "Desconocido" (sin atribución falsa).');
}

// 5.5 Anti-contaminación del Cerebro (causa raíz del falso Potencia).
const vocabCheck = learningBrain?.memory?.vocabularyWeights || {};
if ('your' in vocabCheck || 'opportunity' in vocabCheck) {
  console.error('  [FAIL] El vocabulario del Cerebro contiene palabras funcionales/ruido: reaparecerá el falso "Potencia".');
  failures++;
} else {
  console.log('  [PASS] Vocabulario del Cerebro sin ruido: no aprende palabras funcionales en inglés.');
}

// ------------------------------------------------------------------------------
// 6. PROTOCOLO DE GOBERNANZA DE SEDES (SEDE-LOCK & SEDE-SHIELD)
// ------------------------------------------------------------------------------
console.log('\n[6/8] Protocolo de gobernanza de sedes (Sede-Lock & Sede-Shield)');

// 5.0 CANDADO DE SOLO LECTURA: LOA Engine NO escribe en vTiger.
const SENTENCIAS_PROHIBIDAS = [
  "DELETE FROM Contacts WHERE cf_3451 = 'PALACIOS'",
  "UPDATE Contacts SET cf_3392 = '0' WHERE cf_3451 = 'PALACIOS'",
  "INSERT INTO Contacts (lastname) VALUES ('X')"
];
let escriturasFiltradas = 0;
for (const sql of SENTENCIAS_PROHIBIDAS) {
  try { assertReadOnlyStatement(sql); } catch { escriturasFiltradas++; }
}
if (escriturasFiltradas !== SENTENCIAS_PROHIBIDAS.length) {
  console.error('  [FAIL] El candado de solo lectura NO bloquea escrituras sobre vTiger.');
  failures++;
} else {
  console.log('  [PASS] Solo lectura: UPDATE/DELETE/INSERT bloqueados antes de tocar la red.');
}
let metodoEscrituraBloqueado = false;
try { assertReadOnlyHttpMethod('DELETE'); } catch { metodoEscrituraBloqueado = true; }
if (!metodoEscrituraBloqueado) {
  console.error('  [FAIL] El candado no bloquea métodos HTTP de escritura (DELETE/PUT/PATCH).');
  failures++;
} else {
  console.log('  [PASS] Solo lectura: solo GET permitido (POST únicamente para el login).');
}
let operacionBloqueada = false;
try { assertAllowedOperation('update'); } catch { operacionBloqueada = true; }
if (!operacionBloqueada) {
  console.error('  [FAIL] El candado no bloquea operaciones de escritura de la API de vTiger.');
  failures++;
} else {
  console.log('  [PASS] Solo lectura: allow-list de operaciones (query, getchallenge, login).');
}

// 5.1 El gate de aislamiento debe bloquear consultas sin `cf_3451`.
if (assertTenantIsolation("SELECT * FROM Contacts WHERE phone = '3055551234'").safe !== false) {
  console.error('  [FAIL] El gate de Sede-Lock NO bloquea una consulta a Contacts sin cláusula de sede.');
  failures++;
} else {
  console.log('  [PASS] Sede-Lock activo: una consulta sin `cf_3451` es rechazada en el borde de la API.');
}
if (assertTenantIsolation("SELECT * FROM SalesOrder WHERE contact_id = '12x1'").safe !== false) {
  console.error('  [FAIL] El gate de Sede-Lock NO protege SalesOrder (vector de fuga de montos).');
  failures++;
} else {
  console.log('  [PASS] Sede-Lock protege SalesOrder (montos y fechas de compra).');
}

// 5.2 Sede-Shield: historial de OTRA sede debe quedar invisibilizado.
const verdictoAjeno = evaluateCommercialTruth(
  { id: 'probe', tags: [] },
  { id: '12xprobe', cf_3451: 'PALACIOS', spl_num_compras: '5', cf_3392: '999.00', cf_994: 'Vendido' },
  'BENAVIDES'
);
if (verdictoAjeno.isWon !== false || verdictoAjeno.totalSpent !== 0 || verdictoAjeno.salesCount !== 0 || verdictoAjeno.commercialStatus !== 'SIN VENTA') {
  console.error(`  [FAIL] Sede-Shield roto: el historial de otra sede se filtró (isWon=${verdictoAjeno.isWon}, monto=${verdictoAjeno.totalSpent}, compras=${verdictoAjeno.salesCount}).`);
  failures++;
} else {
  console.log('  [PASS] Sede-Shield: historial de otra sede invisibilizado (SIN VENTA, $0, 0 órdenes).');
}

// 5.3 El caso legítimo (misma sede) NO debe romperse.
const verdictoPropio = evaluateCommercialTruth(
  { id: 'probe', tags: [] },
  { id: '12xprobe', cf_3451: 'BENAVIDES', spl_num_compras: '2', cf_3392: '300.00' },
  'BENAVIDES'
);
if (verdictoPropio.isWon !== true || verdictoPropio.totalSpent !== 300) {
  console.error('  [FAIL] La lógica comercial legítima se rompió: una venta de la MISMA sede no se reconoce.');
  failures++;
} else {
  console.log('  [PASS] Venta legítima de la sede activa preservada (sin falsos SIN VENTA).');
}

// ------------------------------------------------------------------------------
// 6. SEGURIDAD: credenciales, sanitización
// ------------------------------------------------------------------------------
console.log('\n[7/8] Seguridad (auth centralizada y saneado)');
const vtigerStatus = getVtigerConfigStatus();
if (!vtigerStatus.configured) {
  // FAIL-SAFE: en Render esto es WARN (el motor arranca degradado), nunca exit 1.
  console.warn(`  [WARN] vTiger sin configurar. Faltan: ${vtigerStatus.missing.join(', ')}. El motor arrancará con vTiger deshabilitado (fail-safe).`);
} else {
  console.log(`  [PASS] vTiger configurado en modo GLOBAL_ADMIN (host: ${vtigerStatus.urlHost}).`);
}
console.log(`  [INFO] Access key reportado como: ${vtigerStatus.accessKey} (nunca en claro).`);

const inyeccion = sanitizeForVtigerQuery("x' OR '1'='1; DROP TABLE Contacts");
if (inyeccion.includes(';') || !inyeccion.includes("\\'")) {
  console.error('  [FAIL] El saneado de consultas vTiger no neutraliza la inyección.');
  failures++;
} else {
  console.log('  [PASS] Inyección SQL neutralizada en consultas vTiger (comillas, barras y terminadores).');
}

const payloadPrueba = sanitizeContactPayload({
  firstName: '<script>alert(1)</script>Juan',
  email: 'juan@mail.com',
  phone: '+1 (305) 555-1234',
  __proto__: { contaminado: true },
  campoInventado: 'x'.repeat(5000)
});
const protoLimpio = Object.prototype.contaminado === undefined;
if (!protoLimpio) {
  console.error('  [FAIL] Prototype pollution: el payload contaminó Object.prototype.');
  failures++;
} else if (payloadPrueba.firstName.includes('<') || 'campoInventado' in payloadPrueba) {
  console.error('  [FAIL] El saneado de payload no eliminó XSS o campos fuera de la allow-list.');
  failures++;
} else {
  console.log('  [PASS] Payload saneado: sin XSS, sin prototype pollution y sin campos fuera de la allow-list.');
}

if (escapeHtml('<img src=x onerror=alert(1)>').includes('<')) {
  console.error('  [FAIL] escapeHtml no neutraliza etiquetas HTML.');
  failures++;
} else {
  console.log('  [PASS] Salida escapada para UI/notas (XSS almacenado bloqueado).');
}

// ------------------------------------------------------------------------------
// 6. PRESUPUESTO DE ARRANQUE (ANTI CRASH-LOOP DE RENDER)
// ------------------------------------------------------------------------------
console.log('\n[8/8] Presupuesto de arranque');
if (elapsed > BUDGET_MS) {
  console.error(`  [FAIL] El gate tardó ${elapsed}ms (presupuesto ${BUDGET_MS}ms). Algo está haciendo I/O en el camino crítico.`);
  failures++;
} else {
  console.log(`  [PASS] Gate completado en ${elapsed}ms (presupuesto ${BUDGET_MS}ms).`);
}

const queueStatus = getQueueStatus();
console.log(`  [INFO] Colas: flag=${queueStatus.featureFlag} driver=${queueStatus.activeDriver} redis=${queueStatus.redisConfigured} degradado=${queueStatus.degraded}`);
if (queueStatus.featureFlag !== 'memory' && !queueStatus.redisConfigured) {
  console.warn('  [WARN] QUEUE_DRIVER distinto de "memory" sin REDIS_URL: el motor arrancará con la cola en memoria.');
}

console.log('\n==========================================================');
if (failures === 0) {
  console.log(` [RESULT] APTO PARA DEPLOY (${elapsed}ms) - listo para merge a main`);
  console.log('==========================================================');
  process.exit(0);
} else {
  console.error(` [RESULT] BLOQUEADO: ${failures} verificación(es) fallida(s)`);
  console.log('==========================================================');
  process.exit(1);
}
