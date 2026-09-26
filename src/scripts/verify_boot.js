#!/usr/bin/env node
/**
 * ==============================================================================
 * LOA ENGINE - SMOKE TEST DE ARRANQUE (OFFLINE, SIN RED, SIN PUERTOS)
 * ==============================================================================
 * Verifica que el motor "compila la malla de rutas" sin ejecutar trabajo real:
 *   1. Todos los módulos del grafo de imports cargan sin errores (ESM estricto).
 *   2. Express registra los endpoints críticos (/health, /api/health, webhooks).
 *   3. La app queda en estado "no escuchando" (jamás abre el puerto 3000).
 *
 *   npm run verify:boot
 * ==============================================================================
 */

import { app } from '../app.js';

console.log('==========================================================');
console.log(' LOA ENGINE - SMOKE TEST DE ARRANQUE (offline)');
console.log('==========================================================\n');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
  } else {
    console.error(`  [FAIL] ${message}`);
    failures++;
  }
}

// 1. La app es una instancia de Express con router montado
check(typeof app === 'function' || typeof app?.handle === 'function', 'La aplicación Express se construyó correctamente');

// 2. Mesa de rutas registrada (Express 5 expone el router en app.router)
const stack = app?.router?.stack || app?._router?.stack || [];
const registered = new Set();
for (const layer of stack) {
  if (layer.route?.path) {
    const methods = Object.keys(layer.route.methods || {}).map(m => m.toUpperCase());
    for (const m of methods) registered.add(`${m} ${layer.route.path}`);
  }
}

console.log(`  [INFO] Rutas registradas: ${registered.size}`);

const CRITICAL_ROUTES = [
  'GET /health',
  'GET /api/health',
  'GET /api/stats',
  'POST /webhook/ghl-contact',
  'POST /webhook/meta',
  'GET /webhook/meta',
  'POST /webhook/vtiger',
  'POST /webhook/chat-router'
];

for (const route of CRITICAL_ROUTES) {
  check(registered.has(route), `Ruta registrada: ${route}`);
}

// 3. Sin duplicados en la mesa de rutas (regresiones de copy/paste)
const duplicates = [];
const seen = new Set();
for (const layer of stack) {
  if (!layer.route?.path) continue;
  for (const m of Object.keys(layer.route.methods || {})) {
    const key = `${m.toUpperCase()} ${layer.route.path}`;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
}
check(duplicates.length === 0, `Sin rutas duplicadas${duplicates.length ? ` (encontradas: ${duplicates.join(', ')})` : ''}`);

// 4. El proceso NO debe quedar escuchando (el smoke test no abre puertos)
check(!app.__isListening, 'La app no abrió ningún puerto (modo smoke test)');

console.log('\n==========================================================');
if (failures === 0) {
  console.log(' [RESULT] Malla de rutas íntegra. Boot validado sin red.');
  console.log('==========================================================');
  process.exit(0);
} else {
  console.error(` [RESULT] BOOT BLOQUEADO: ${failures} verificación(es) fallida(s)`);
  console.log('==========================================================');
  process.exit(1);
}
