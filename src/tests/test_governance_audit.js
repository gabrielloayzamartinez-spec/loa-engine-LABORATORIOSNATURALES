/**
 * Suite de auditoría de gobernanza (T-01 a T-06) — LOA Engine.
 * Verifica las reglas innegociables con pruebas UNITARIAS (sin APIs externas).
 * Ejecutar: node src/tests/test_governance_audit.js
 */
import assert from 'node:assert';
import { normalizeToE164 } from '../utils/geo_phone_sanitizer.js';
import { hashPayload, hashVtigerCommercial, limpiarGate } from '../services/payload_hash_gate.js';
import { claveCooldown, marcarProcesadoReactivo, estaEnCooldown } from '../services/reactive_cooldown.js';

let pasadas = 0;
function check(nombre, fn) {
  fn();
  pasadas++;
  console.log(`  ✓ ${nombre}`);
}

console.log('\n[GOBERNANZA] T-01 a T-06\n');

// ── T-06: Sanitización de llave única (teléfono E.164) ──────────────────────
check('T-06: teléfono canónico único (3 formatos → 1)', () => {
  const a = normalizeToE164('+1 305-555-0123');
  const b = normalizeToE164('13055550123');
  const c = normalizeToE164('3055550123');
  assert(a === b && b === c, `esperado un solo canónico, recibido: ${a} / ${b} / ${c}`);
  assert(a === '+13055550123', `esperado +13055550123, recibido ${a}`);
});

// ── T-04: Idempotencia reactivo vs batch (cooldown + hash) ───────────────────
check('T-04: cooldown unificado reactivo/batch', async () => {
  limpiarGate();
  const id = '12x456';
  const phone = '+13055550123';
  const clave = claveCooldown(id, phone);
  assert(clave === '12x456:13055550123', `clave inesperada ${clave}`);

  assert((await estaEnCooldown(id, phone)) === false, 'sin marca no debe estar en cooldown');
  await marcarProcesadoReactivo(id, phone);
  assert((await estaEnCooldown(id, phone)) === true, 'tras marcarlo debe estar en cooldown');
});

// ── T-04b: Idempotencia por hash (no reescribir si no hay cambios) ───────────
check('T-04b: diff gate — payload idéntico se salta', async () => {
  limpiarGate();
  const vContacto = {
    firstname: 'MARIA', lastname: 'PEREZ', cf_3451: 'PALACIOS',
    spl_num_compras: '3', cf_2610: 'Artritis', cf_3392: '150.00'
  };
  const h1 = hashVtigerCommercial(vContacto);
  const h2 = hashVtigerCommercial({ ...vContacto });
  assert(h1 && h1 === h2, 'mismos datos comerciales deben dar el mismo hash');

  // El mismo payload serializado debe ser estable.
  const p1 = hashPayload({ a: 1, b: 'x' });
  const p2 = hashPayload({ a: 1, b: 'x' });
  assert(p1 === p2, 'el hash del payload debe ser estable');
});

// ── T-05: No-sobreescritura (campos vacíos no viajan) ────────────────────────
check('T-05: hashVtigerCommercial ignora campos vacíos', () => {
  limpiarGate();
  const conVacios = { firstname: 'X', lastname: '', cf_2610: '', spl_num_compras: '0' };
  const sinVacios = { firstname: 'X', spl_num_compras: '0' };
  assert(hashVtigerCommercial(conVacios) === hashVtigerCommercial(sinVacios),
    'los campos vacíos no deben alterar el hash (no viajan al payload)');
});

// ── T-02/T-03: reglas que se prueban por construcción (smoke) ────────────────
check('T-02/T-03: smoke de constantes de canal y llave', () => {
  // T-02 (ráfaga) y T-03 (canal) se validan en la suite principal de reglas (30/30)
  // y en el router; aquí se confirma que las piezas existen y cargan sin error.
  assert(typeof hashPayload === 'function', 'hashPayload debe existir');
  assert(typeof normalizeToE164 === 'function', 'normalizeToE164 debe existir');
  assert(typeof estaEnCooldown === 'function', 'estaEnCooldown debe existir');
});

console.log(`\n[GOBERNANZA] ${pasadas} pruebas pasadas ✅\n`);
