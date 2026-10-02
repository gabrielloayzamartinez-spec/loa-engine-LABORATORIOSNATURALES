#!/usr/bin/env node
/**
 * ==============================================================================
 * LOA ENGINE - RUNTIME (ENTRY POINT DE PRODUCCIÓN)
 * ==============================================================================
 * Responsabilidades EXCLUSIVAS de este archivo:
 *   1. Abrir el puerto HTTP (Render espera el puerto antes que nada).
 *   2. Auditar secretos y ejecutar el Pre-Flight Sanity Check acotado.
 *   3. Levantar infraestructura diferida (colas durables, estado persistente).
 *   4. Programar los ciclos de fondo (radar, curador, vTiger).
 *   5. Cerrar ordenadamente ante SIGTERM/SIGINT.
 *
 * La malla HTTP y la lógica de webhooks viven en src/app.js.
 * ==============================================================================
 */

// ------------------------------------------------------------------------------
// IMPORTS DEL RUNTIME (la malla HTTP vive en app.js; los side effects, aquí)
// ------------------------------------------------------------------------------
import { app, stats, runExpressAssignment, registerQueueProcessors, registerBackgroundSchedulers, startCentralCredentialCheck, startMetaCredentialCheck } from './app.js';
import { learningBrain } from './services/learning_brain.js';
import { reportSecrets } from './config/secrets.js';
import { getOperationalSedeIds, getDegradedSedes, getOperationalSedes, getActiveSedes } from './config/sedes_gateway.js';
import { getQueue, getQueueStatus, shutdownQueues, JOBS, QUEUES } from './services/queue/durable_queue.js';
import { hydrateAllStores, shutdownStateStores } from './services/state/state_store.js';
import { hydrateCursorStates, runForwardCure, runBackwardCure } from './services/curador_bidireccional_service.js';
import { hydrateVtigerRetryQueue } from './services/vtiger_retry_queue.js';
import { getVtigerConfigStatus } from './services/vtigerClient.js';
import { getActiveSedeAgents } from './agents/sede_agent.js';
import { checkVTigerHealth, syncVtigerGroundTruthToBrain } from './services/vtiger_api_service.js';
import { runPreFlightSanityCheck } from './tests/test_audit_engine.js';
import { envInt } from './config/secrets.js';

const PORT = process.env.PORT || 3000;
let vtigerConnectionStatus = { status: 'PENDING', message: 'Checking...' };

const server = app.listen(PORT, '0.0.0.0', async () => {
  // ==========================================
  // 0. AUDITORÍA DE SECRETOS (FAIL-SAFE, SIN RED)
  // ==========================================
  // Se ejecuta ANTES del sanity check: si falta un secreto no crítico se emite
  // WARN y el motor arranca igual (protección contra el crash-loop de Render).
  const secretReport = reportSecrets({ operationalSedes: getOperationalSedeIds() });

  // Sedes encendidas por diseño pero sin credenciales: se degradan, no se caen.
  for (const sede of getDegradedSedes()) {
    console.warn(`[WARN] [SEDE-DEGRADADA] ${sede.sedeId} está encendida pero sin PIT/Location ID cargados. Sus ciclos se omitirán hasta configurarla.`);
  }

  // ==========================================
  // 1. PRE-FLIGHT SANITY CHECK ACOTADO (< 5 s, sin I/O)
  // ==========================================
  // El gate es 100% síncrono y local: no toca GHL, vTiger, Redis ni PostgreSQL.
  // Si el gate tarda más que el presupuesto, se degrada en modo observación en
  // lugar de morir, para no alimentar un crash loop infinito.
  const preflightBudgetMs = parseInt(process.env.PREFLIGHT_MAX_MS || '5000', 10);
  const preflightStartedAt = Date.now();
  const isHealthy = runPreFlightSanityCheck();
  const preflightElapsed = Date.now() - preflightStartedAt;

  if (!isHealthy) {
    if (secretReport.summary.strict) {
      console.error('[INIT] [FATAL] Pre-Flight Sanity Check fallido en modo STRICT_CONFIG. Deteniendo arranque controlado.');
      process.exit(1);
    }
    console.error('[INIT] [DEGRADADO] El motor no superó el Pre-Flight Sanity Check. Se arranca en modo observación (sin curación ni ruteo activo) para evitar el crash loop de Render. Corrige la regla señalada en los logs y redeploya.');
  } else if (preflightElapsed > preflightBudgetMs) {
    console.warn(`[INIT] [WARN] Pre-Flight Sanity Check tardó ${preflightElapsed}ms (presupuesto ${preflightBudgetMs}ms). El gate debe ser síncrono: revisa dependencias de red en las reglas.`);
  }

  // ==========================================
  // 2. INFRAESTRUCTURA DURABLE (POST-LISTEN, NO BLOQUEANTE)
  // ==========================================
  // Render sólo necesita el puerto abierto. Todo lo que pueda colgarse
  // (Redis, PostgreSQL) se hidrata DESPUÉS, con fallback automático.
  const queueStatus = getQueueStatus();
  console.log(`[QUEUE] Driver solicitado: ${queueStatus.featureFlag} | Activo: ${queueStatus.activeDriver} | Redis configurado: ${queueStatus.redisConfigured}`);

  // 2.1 Procesadores de cola: los webhooks se drenan FUERA del event loop HTTP.
  registerQueueProcessors();

  // 2.2 Hidratación del estado persistente (cursores + learning_brain + cola vTiger).
  hydrateAllStores()
    .then(() => hydrateCursorStates(['PALACIOS', 'BENAVIDES']))
    .then(() => hydrateVtigerRetryQueue())
    .then(() => learningBrain.hydrate())
    .catch(err => console.warn(`[INIT] [STATE-WARN] Hidratación diferida con errores: ${err.message}. El motor continúa con estado en memoria.`));

  // 2.3 Validación de credenciales vTiger (fail-safe: WARN, nunca exit).
  const vtigerCfg = getVtigerConfigStatus();
  if (!vtigerCfg.configured) {
    console.warn(`[VTIGER] [WARN] Modo degradado: faltan ${vtigerCfg.missing.join(', ')}. Las consultas vTiger se omitirán y la cola de reintentos no consumirá intentos.`);
  } else {
    console.log(`[VTIGER] [CONFIG] Acceso GLOBAL_ADMIN verificado (host: ${vtigerCfg.urlHost}, key: ${vtigerCfg.accessKey}).`);
  }

  try {
    const vtigerStatus = await checkVTigerHealth();
    vtigerConnectionStatus = vtigerStatus;
    if (vtigerStatus.status === 'OK') {
      console.log('[VTIGER] [SUCCESS] Conexión con vTiger CRM verificada correctamente.');
    } else {
      console.warn('[VTIGER] [WARN] vTiger no disponible:', vtigerStatus.message, '- El motor opera con datos locales y reintentará.');
    }
  } catch (err) {
    vtigerConnectionStatus = { status: 'ERROR', message: err.message };
    console.warn('[VTIGER] [WARN] Verificación de vTiger fallida:', err.message, '- Arranque continúa (fail-safe).');
  }

  console.log(`\n==========================================================`);
  console.log(`[INIT] LOA ENGINE 2.0 (AUTOAPRENDIZAJE + VTIGER + RADAR 24/7)`);
  console.log(`[CONFIG] Puerto: ${PORT} | Dashboard: http://localhost:${PORT}/health`);
  console.log(`[SECURITY] Token Bucket Shield: 1.2s entre curaciones de fondo (0% saturación)`);
  console.log(`[AI] Learning Brain: Memoria activa y feedback loop conectado a vTiger`);
  console.log(`[RADAR] Radar en Vivo: Escaneando tráfico de hoy cada 20 segundos`);
  console.log(`[STATUS] Sedes Operativas: ${getOperationalSedes().filter(s => !s.isPaused).map(s => s.sedeId).join(', ') || 'NINGUNA'} | Pausadas (Rate Limit 429): ${getActiveSedes().filter(s => s.isPaused).map(s => s.sedeId).join(', ') || 'NINGUNA'}`);
  if (getDegradedSedes().length > 0) {
    console.log(`[STATUS] Sedes DEGRADADAS (sin credenciales): ${getDegradedSedes().map(s => s.sedeId).join(', ')}`);
  }
  console.log(`[QUEUE] Driver: ${queueStatus.activeDriver} (flag: ${queueStatus.featureFlag})${queueStatus.degraded ? ` | DEGRADADO: ${queueStatus.degradeReason}` : ''}`);
  console.log(`[ROUTES] Webhooks: /webhook/ghl-contact, /webhook/meta, /webhook/vtiger`);
  console.log(`==========================================================\n`);

  // Sincronización inicial suave de Ground Truth con vTiger CRM
  setTimeout(() => {
    syncVtigerGroundTruthToBrain(20).then(res => {
      if (res && res.success) stats.vtigerStatus = 'Conectado y Aprendiendo';
    }).catch(e => console.log(`[Startup vTiger Sync]: ${e.message}`));
  }, 3000);

  // [REEMPLAZADO]: El viejo background curator de base única ha sido reemplazado por el Curador Bi-Direccional Multi-Sede
  // setInterval(() => {
  //   runBackgroundCuratorCycle(20).catch(err => console.error('[Background Curator Error]:', err.message));
  // }, 5 * 60 * 1000);

  // CURADOR BI-DIRECCIONAL MULTI-SEDE (ORQUESTADO POR SEDE-AGENTS):
  // [FEATURE FLAG] Con colas durables los ciclos se encolan como jobs
  // (concurrencia 1 por sede, backoff exponencial y DLQ). En modo memoria se
  // ejecutan en proceso como hasta ahora.
  const dispatchCuration = (jobName, limite) => {
    const agents = getActiveSedeAgents().filter(a => !a.isPaused);
    if (getQueueStatus().enabled) {
      const q = getQueue(QUEUES.CURATION);
      for (const agent of agents) {
        q.enqueue(jobName, { sede: agent.sedeId, limit: limite })
          .catch(err => console.warn(`[Queue] Curación no encolada para ${agent.sedeId}: ${err.message}`));
      }
      return Promise.resolve();
    }
    return (async () => {
      for (const agent of agents) {
        try {
          if (jobName === JOBS.CURATION_BACKWARD) await agent.runBackward({ limit: limite });
          else await agent.runForward({ limit: limite });
        } catch (e) { /* un fallo de sede no debe detener a las demás */ }
      }
    })();
  };

  // 1. MODO 1: "Del Ahora en Adelante" (Forward / En Vivo) - Cada 25s
  setInterval(() => { dispatchCuration(JOBS.CURATION_FORWARD, 15).catch(() => {}); }, 25 * 1000);

  // 2. MODO 2: "Del Ahora para Atrás" (Backward / Histórico Profundo) - Turnos equitativos entre sedes activas
  let backwardTurn = 0;
  setInterval(() => {
    const agents = getActiveSedeAgents().filter(a => !a.isPaused);
    if (agents.length === 0) return;
    const targetAgent = agents[backwardTurn % agents.length];
    backwardTurn++;

    if (getQueueStatus().enabled) {
      getQueue(QUEUES.CURATION)
        .enqueue(JOBS.CURATION_BACKWARD, { sede: targetAgent.sedeId, limit: 20 })
        .catch(err => console.warn(`[Queue] Curación backward no encolada: ${err.message}`));
      return;
    }

    targetAgent.runBackward({ limit: 20 }).catch(() => {});
  }, 60 * 1000);

  // Calibración Periódica de vTiger (Cada 30 min)
  setInterval(() => {
    syncVtigerGroundTruthToBrain(25).catch(err => console.error('[Periodic vTiger Sync Error]:', err.message));
  }, 30 * 60 * 1000);

  runExpressAssignment();

  // Programadores de fondo (radar, guardián, sync inverso, retry, memory guard)
  registerBackgroundSchedulers();

  // Prueba REAL de la credencial de la Cuenta Empresa (en segundo plano, sin
  // bloquear el arranque). Expone el veredicto en /api/health: un PIT revocado
  // esta "presente" pero no autentica, y eso antes solo se descubria en los logs.
  startCentralCredentialCheck();

  // Prueba REAL de las credenciales de Meta por sede. Un token vencido (error 190)
  // deja la atribucion publicitaria en 'DESCONOCIDO' en silencio: sin token no se
  // puede traducir el Ad ID a campaña, conjunto de anuncios ni nombre de anuncio.
  startMetaCredentialCheck();
});

// ==========================================
// 5. APAGADO ORDENADO (SIGTERM / SIGINT de Render)
// ==========================================
// Render envía SIGTERM en cada redeploy. Sin este handler, los jobs en vuelo se
// pierden y los cursores/learning_brain pueden quedar desincronizados.
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[SHUTDOWN] Señal ${signal} recibida. Cerrando ordenadamente...`);

  const forceExit = setTimeout(() => {
    console.error('[SHUTDOWN] [TIMEOUT] Cierre excedido. Forzando salida para no bloquear el redeploy de Render.');
    process.exit(0);
  }, 10000);
  forceExit.unref();

  try {
    await Promise.allSettled([
      shutdownQueues(),
      shutdownStateStores(),
      learningBrain.flush()
    ]);
    console.log('[SHUTDOWN] Colas, estado y memoria persistidos correctamente.');
  } catch (err) {
    console.warn(`[SHUTDOWN] [WARN] Cierre parcial: ${err.message}`);
  }

  server.close(() => {
    clearTimeout(forceExit);
    console.log('[SHUTDOWN] Servidor HTTP cerrado.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Red de seguridad: un error no capturado se registra y NO tumba el motor.
process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] [UNHANDLED-REJECTION]', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[PROCESS] [UNCAUGHT-EXCEPTION]', err?.message, '\n', err?.stack);
});

// Watchdog: Alerta si el radar se duerme > 5 min
setInterval(() => {
  if (global.lastRadarActivity) {
    const inactiveTime = Date.now() - global.lastRadarActivity;
    if (inactiveTime > 5 * 60 * 1000) {
      console.error(`[WATCHDOG-ALERTA] El Radar de Asignacion lleva mas de 5 minutos sin reportar actividad (Inactivo por ${Math.round(inactiveTime/60000)} min). Verifica logs.`);
      // En un entorno de prod, aquí se puede enviar un HTTP POST a Slack/Discord o un Email
    }
  }
}, 60000);


export { server };
