/**
 * ==============================================================================
 * LOA ENGINE - SUITE DE POLÍTICA DE COLAS Y CIRCUIT BREAKER (OFFLINE)
 * ==============================================================================
 * Valida el CONTRATO de robustez sin requerir Redis ni red:
 *   1. Reintentos exponenciales dentro del driver de cola.
 *   2. Degradación a DLQ al agotar los intentos.
 *   3. Un job que falla NO tumba el proceso (ni el event loop).
 *   4. El circuit breaker abre tras fallos consecutivos y rechaza en caliente.
 *   5. Los 4xx de negocio NO abren el circuito (errorFilter).
 *
 * Ejecución:  node src/tests/test_queue_policy.js
 * (También forma parte de la suite offline ampliada; no toca GHL/vTiger/Meta.)
 * ==============================================================================
 */

import { getQueue, getQueueStatus } from '../services/queue/durable_queue.js';
import { withCircuitBreaker, safeCall, getBreakersStatus, resetBreaker } from '../utils/circuit_breaker.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${message}`);
    failed++;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runTests() {
  console.log('\n==========================================================');
  console.log(' [TEST] POLÍTICA DE COLAS DURABLES Y CIRCUIT BREAKER');
  console.log('==========================================================\n');

  const status = getQueueStatus();
  console.log(`[CONTEXTO] Driver: ${status.activeDriver} (flag: ${status.featureFlag}, redis: ${status.redisConfigured})\n`);

  // ---------------------------------------------------------------------------
  // TEST 1: Reintentos exponenciales hasta la DLQ
  // ---------------------------------------------------------------------------
  console.log('[TEST 1] Reintentos exponenciales y archivo en Dead Letter Queue');
  const q = getQueue('policy-test');

  let attempts = 0;
  let deadLettered = 0;
  const originalError = console.error;
  console.error = (msg, ...rest) => {
    if (String(msg).includes('[DLQ]')) deadLettered++;
  };

  q.registerProcessor('job-que-siempre-falla', async () => {
    attempts++;
    throw new Error('fallo simulado de endpoint externo');
  });

  await q.enqueue('job-que-siempre-falla', { payload: 'x' }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 20 }
  });

  // Espera total: 20 + 40 = 60ms de backoff + margen de ejecución
  await sleep(600);
  console.error = originalError;

  assert(attempts === 3, `El job se intentó exactamente 3 veces (recibido: ${attempts})`);
  assert(deadLettered === 1, `El job agotado se archivó en la DLQ 1 vez (recibido: ${deadLettered})`);

  // ---------------------------------------------------------------------------
  // TEST 2: Un job fallido no interrumpe el procesamiento de los siguientes
  // ---------------------------------------------------------------------------
  console.log('\n[TEST 2] Aislamiento de fallos: un job roto no bloquea la cola');
  let successRuns = 0;
  q.registerProcessor('job-sano', async () => { successRuns++; return 'ok'; });

  await q.enqueue('job-que-siempre-falla', {}, { attempts: 1, backoff: { type: 'exponential', delay: 10 } });
  await q.enqueue('job-sano', {});
  await q.enqueue('job-sano', {});
  await sleep(400);

  assert(successRuns === 2, `Los jobs sanos posteriores se procesaron igualmente (${successRuns}/2)`);

  // ---------------------------------------------------------------------------
  // TEST 3: Encolado masivo sin bloquear el event loop
  // ---------------------------------------------------------------------------
  console.log('\n[TEST 3] Encolado masivo: el event loop nunca se bloquea');
  const burstQueue = getQueue('burst-test');
  let handled = 0;
  burstQueue.registerProcessor('burst', async () => { handled++; });

  const t0 = Date.now();
  const promises = [];
  for (let i = 0; i < 500; i++) promises.push(burstQueue.enqueue('burst', { i }));
  await Promise.all(promises);
  const enqueueMs = Date.now() - t0;

  assert(enqueueMs < 2000, `500 encolados en ${enqueueMs}ms (sin bloqueo perceptible del event loop)`);
  await sleep(500);
  assert(handled > 0, `El worker drenó jobs del burst (procesados: ${handled}/500)`);

  // ---------------------------------------------------------------------------
  // TEST 4: El circuit breaker abre tras fallos consecutivos
  // ---------------------------------------------------------------------------
  console.log('\n[TEST 4] Circuit Breaker: apertura ante endpoint caído');
  resetBreaker('test:api-caida');
  const callCaida = withCircuitBreaker('test:api-caida', async () => {
    const err = new Error('502 Bad Gateway');
    err.status = 502;
    throw err;
  }, { errorThresholdPercentage: 1, volumeThreshold: 2, resetTimeout: 60000 });

  const results = await Promise.allSettled([
    callCaida(), callCaida(), callCaida(), callCaida()
  ]);
  const rejected = results.filter(r => r.status === 'rejected').length;
  let breakerState = getBreakersStatus()['test:api-caida'];

  assert(rejected === 4, `Todas las llamadas fallaron controladamente (${rejected}/4)`);
  assert(breakerState?.state === 'OPEN', `El circuito quedó ABIERTO (estado: ${breakerState?.state})`);

  // Una vez abierto, una llamada adicional debe ser RECHAZADA sin tocar la red.
  const rejectsBefore = breakerState?.stats?.rejects || 0;
  await Promise.allSettled([callCaida(), callCaida()]);
  breakerState = getBreakersStatus()['test:api-caida'];
  assert(
    breakerState?.stats?.rejects > rejectsBefore,
    `Con el circuito abierto las llamadas se rechazan en caliente (rejects: ${breakerState?.stats?.rejects})`
  );

  // ---------------------------------------------------------------------------
  // TEST 5: safeCall nunca propaga excepciones hacia el job
  // ---------------------------------------------------------------------------
  console.log('\n[TEST 5] safeCall: error contenido y reencolable');
  const callSegura = await safeCall('test:api-caida', async () => {
    const err = new Error('circuito abierto');
    err.status = 502;
    throw err;
  }, { errorThresholdPercentage: 1, volumeThreshold: 1, resetTimeout: 60000 });

  assert(callSegura.ok === false, 'safeCall devuelve ok:false en lugar de lanzar excepción');
  assert(typeof callSegura.error === 'string' && callSegura.error.length > 0, `El error se reporta como dato (${callSegura.error})`);

  // ---------------------------------------------------------------------------
  // TEST 6: Los 4xx de negocio NO deben abrir el circuito
  // ---------------------------------------------------------------------------
  console.log('\n[TEST 6] errorFilter: un 404 de dato no abre el circuito');
  resetBreaker('test:404-negocio');
  const call404 = withCircuitBreaker('test:404-negocio', async () => {
    const err = new Error('404 Not Found');
    err.status = 404;
    throw err;
  }, { errorThresholdPercentage: 1, volumeThreshold: 1, resetTimeout: 60000 });

  await Promise.allSettled([call404(), call404(), call404()]);
  const breaker404 = getBreakersStatus()['test:404-negocio'];
  assert(breaker404?.state !== 'OPEN', `El circuito permanece utilizable ante 404 (estado: ${breaker404?.state})`);

  // ---------------------------------------------------------------------------
  // TEST 7: [GUARDIAN DE CUOTA DIARIA] aislamiento por subcuenta y conteo
  // ---------------------------------------------------------------------------
  console.log('\n[TEST 7] Guardian de cuota diaria por subcuenta');
  const { tokenBucketQueue } = await import('../services/token_bucket_queue.js');

  // Cada subcuenta arranca con cupo de fondo y su propio contador aislado.
  assert(tokenBucketQueue.hayCupoDeFondo('PALACIOS') === true, 'Palacios arranca con cupo de fondo');
  assert(tokenBucketQueue.hayCupoDeFondo('BENAVIDES') === true, 'Benavides arranca con cupo de fondo');

  const antes = tokenBucketQueue.getCuotaDiaria();
  const palaciosAntes = antes.PALACIOS?.consumidas || 0;
  const benavidesAntes = antes.BENAVIDES?.consumidas || 0;

  // Encolar 3 tareas SOLO en Palacios.
  await Promise.all([
    tokenBucketQueue.enqueue(async () => 'a', 'LOW', 'PALACIOS'),
    tokenBucketQueue.enqueue(async () => 'b', 'LOW', 'PALACIOS'),
    tokenBucketQueue.enqueue(async () => 'c', 'LOW', 'PALACIOS')
  ]);
  await new Promise(r => setTimeout(r, 2500));

  const despues = tokenBucketQueue.getCuotaDiaria();
  const palaciosDespues = despues.PALACIOS?.consumidas || 0;
  const benavidesDespues = despues.BENAVIDES?.consumidas || 0;

  assert(palaciosDespues > palaciosAntes, `Palacios contabiliza su consumo (${palaciosAntes} -> ${palaciosDespues})`);
  assert(benavidesDespues === benavidesAntes, `Benavides NO se contamina con el consumo de Palacios (${benavidesAntes} -> ${benavidesDespues})`);
  assert(typeof despues.PALACIOS?.techo === 'number' && despues.PALACIOS.techo > 0, `El techo diario esta definido (${despues.PALACIOS?.techo})`);
  assert(despues.PALACIOS?.limiteGhl === 200000, 'Se declara el limite oficial de GHL (200,000/dia)');
  assert(despues.PALACIOS?.techo < despues.PALACIOS?.limiteGhl, 'El techo del guardian DEJA margen bajo el limite de GHL');

  console.log('\n==========================================================');
  console.log(` [METRICS] ${passed} pasadas, ${failed} fallidas`);
  console.log('==========================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('[FATAL] Suite de política de colas falló:', err);
  process.exit(1);
});
