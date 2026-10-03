/**
 * LOA ENGINE - SUITE DE AUDITORÍA Y DEPURACIÓN DE LA EMPRESA (offline)
 * Valida la lógica pura de normalización de teléfonos que usa la detección de
 * duplicados. La parte de red (escanear GHL) no se prueba offline.
 */
import { normalizarTelefonoAuditoria } from '../services/empresa_data_audit.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

console.log('\n==========================================================');
console.log(' [TEST] AUDITORIA / DEPURACION DE DUPLICADOS (EMPRESA)');
console.log('==========================================================\n');

assert(normalizarTelefonoAuditoria('+1 (305) 555-1234') === '3055551234', 'Formato NANP con país y símbolos → 10 dígitos');
assert(normalizarTelefonoAuditoria('3055551234') === '3055551234', '10 dígitos limpios se conservan');
assert(normalizarTelefonoAuditoria(' 555-1234') === null, 'Menos de 10 dígitos → null (no sirve para vincular)');
assert(normalizarTelefonoAuditoria('') === null, 'Vacío → null');
assert(normalizarTelefonoAuditoria(null) === null, 'null → null');
assert(normalizarTelefonoAuditoria('abc') === null, 'Sin dígitos → null');

console.log('\n==========================================================');
console.log(` [METRICS] ${passed} pasadas, ${failed} fallidas`);
console.log('==========================================================\n');
process.exit(failed > 0 ? 1 : 0);
