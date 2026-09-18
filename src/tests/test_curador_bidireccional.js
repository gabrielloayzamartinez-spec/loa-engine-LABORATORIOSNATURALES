import { getBiCuratorMetrics, loadCursorState, saveCursorState, runForwardCure, runBackwardCure } from '../services/curador_bidireccional_service.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n==========================================================');
  console.log('🧪 SUITE DE PRUEBAS: Curador Bi-Direccional Multi-Sede');
  console.log('==========================================================\n');

  // Test 1: Estructura de métricas
  console.log('[TEST 1] Verificación de estructura de métricas de getBiCuratorMetrics');
  const metrics = getBiCuratorMetrics();
  assert(metrics !== null && typeof metrics === 'object', 'Retorna un objeto de métricas');
  assert(metrics.metrics && metrics.metrics.forward && metrics.metrics.backward, 'Contiene ramas forward y backward');
  assert(metrics.metrics.forward.BENAVIDES && metrics.metrics.forward.PALACIOS, 'Contiene métricas forward para Benavides y Palacios');
  assert(metrics.metrics.backward.BENAVIDES && metrics.metrics.backward.PALACIOS, 'Contiene métricas backward para Benavides y Palacios');
  assert(metrics.state && metrics.state.BENAVIDES && metrics.state.PALACIOS, 'Contiene estado de cursor para ambas sedes');
  assert(metrics.running && metrics.running.forward && metrics.running.backward, 'Contiene indicadores de ejecución en vivo');

  // Test 2: Persistencia del Cursor State
  console.log('\n[TEST 2] Persistencia y lectura de cursor de curación');
  const testState = {
    nextPageUrl: 'https://test.cursor/page2',
    totalScanned: 100,
    totalHealed: 25,
    totalCycles: 5,
    isCompleted: false,
    lastRunAt: new Date().toISOString()
  };
  saveCursorState('TEST_SEDE', testState);
  const loadedState = loadCursorState('TEST_SEDE');
  assert(loadedState.nextPageUrl === 'https://test.cursor/page2', 'nextPageUrl persistido y recuperado correctamente');
  assert(loadedState.totalScanned === 100, 'totalScanned persistido correctamente');
  assert(loadedState.totalHealed === 25, 'totalHealed persistido correctamente');

  // Test 3: Validación de Sedes
  console.log('\n[TEST 3] Rechazo defensivo de sedes inexistentes');
  try {
    await runForwardCure('SEDE_FALSA');
    assert(false, 'runForwardCure debería rechazar sede inexistente');
  } catch (err) {
    assert(err.message.includes('Sede no válida'), 'runForwardCure lanza error para sede inexistente');
  }

  try {
    await runBackwardCure('SEDE_FALSA');
    assert(false, 'runBackwardCure debería rechazar sede inexistente');
  } catch (err) {
    assert(err.message.includes('Sede no válida'), 'runBackwardCure lanza error para sede inexistente');
  }

  console.log('\n==========================================================');
  console.log(`📊 RESULTADOS: ${passed} pasadas, ${failed} fallidas`);
  console.log('==========================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Error fatal en suite de pruebas del curador:', err);
  process.exit(1);
});
