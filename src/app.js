import express from 'express';
import fs from 'fs';
import path from 'path';
import { GHL_CONFIG, META_CONFIG, FB_PAGE_ID_MAP, PAGE_TAG_MAP, PALACIOS_USERS, SEDES_GATEWAY, getGhlHeaders, getActiveSedes } from './config/index.js';
import { ghlFetch, GHL_HEADERS, getRateLimiterStatus } from './utils/ghl_http_client.js';
import { processMasterContact } from './agents/master_processor.js';
import { runContinuousAutoAuditCycle, getHealMetrics } from './services/auto_auditor_healer.js';
import { testMetaConnection, excludeLeadFromMetaAds, scanMetaInboxForDuplicates } from './services/meta_api_service.js';
import { routeChatByContact, runChatRouterPoller, runInboxSedeCleaner } from './agents/chat_router_agent.js';
import { processMetaWebhook } from './agents/meta_webhook_agent.js';
import { runSupervisorAuditor, auditorStats } from './agents/auditor_agent.js';
import { setupAllPipelines } from './scripts/pipeline_manager.js';
import { runPreFlightSanityCheck } from './tests/test_audit_engine.js';
import { learningBrain } from './services/learning_brain.js';
import { syncVtigerGroundTruthToBrain, checkVTigerHealth } from './services/vtiger_api_service.js';
import { processVtigerRetryQueue, getVtigerQueueCount } from './services/vtiger_retry_queue.js';
import { runVTigerToGHLPoller } from './agents/vtiger_sync_agent.js';
import { tokenBucketQueue } from './services/token_bucket_queue.js';
import { runBackgroundCuratorCycle, getCuratorMetrics } from './services/background_curator.js';
import { runForwardCure, runBackwardCure, getBiCuratorMetrics } from './services/curador_bidireccional_service.js';
import { envInt } from './config/secrets.js';
import { sanitizeContactPayload, sanitizeObject, sanitizeString, sanitizePhone, sanitizeEmail, sanitizeId, detectInjectionPatterns } from './utils/sanitize.js';
import { recordAuditEvent, getAuditMetrics, readAuditEvents } from './services/audit_logger.js';
import { getVtigerConfigStatus, getVtigerGateMetrics } from './services/vtigerClient.js';
import { readSecret } from './config/secrets.js';
import { isCentralConfigured } from './services/dual_sync_service.js';
import { verificarCredencialEmpresa } from './services/dual_sync_service.js';
import { auditarDuplicadosEmpresa, depurarDuplicadosEmpresa, depurarSinTelefonoEmpresa } from './services/empresa_data_audit.js';

/**
 * Resultado de la prueba REAL de la credencial de la Cuenta Empresa.
 * El endpoint /api/health debe ser SIN I/O (para que Render nunca lo marque como
 * caido por una dependencia lenta), asi que la prueba corre en segundo plano y
 * aqui solo se expone el ultimo resultado conocido.
 */
let centralCredentialStatus = { verificado: false, detalle: 'aun no verificado' };

/**
 * [VERIFICACION REAL DE CREDENCIALES META, POR SEDE]
 *
 * El health reportaba `meta: {isConfigured}` calculado como Boolean(env), que solo
 * comprueba que la VARIABLE exista. Con los dos tokens vencidos (error 190) el panel
 * seguia diciendo "configurado" mientras la atribucion publicitaria se perdia en
 * silencio: sin token no hay campaña, ni conjunto de anuncios, ni nombre de anuncio,
 * y el canal caia a 'DESCONOCIDO'.
 *
 * Corre en segundo plano (el health debe seguir siendo SIN I/O) cada 30 min, porque
 * los tokens de Meta se invalidan solos y hay que detectarlo rapido.
 */
let metaCredentialsStatus = { verificado: false, detalle: 'aun no verificado' };

async function ejecutarVerificacionMeta() {
  try {
    const { verificarCredencialMeta } = await import('./services/meta_api_service.js');
    const sedes = getActiveSedes().map(s => s.sedeId);
    const porSede = {};
    for (const sede of sedes) {
      porSede[sede] = await verificarCredencialMeta(sede);
    }
    const invalidas = Object.entries(porSede).filter(([, v]) => v.valida === false).map(([k]) => k);
    metaCredentialsStatus = {
      verificado: true,
      ts: new Date().toISOString(),
      todasValidas: invalidas.length === 0,
      invalidas,
      porSede
    };
    if (invalidas.length > 0) {
      console.error(`[Health] [CREDENCIAL META] Tokens invalidos en: ${invalidas.join(', ')}. La atribucion publicitaria se perdera (canal DESCONOCIDO).`);
      for (const s of invalidas) {
        console.error(`[Health] [CREDENCIAL META] ${s}: ${porSede[s].detalle}`);
      }
    }
  } catch (err) {
    metaCredentialsStatus = { verificado: false, detalle: err.message };
  }
}

/** Lanza la verificacion de credenciales Meta en segundo plano. */
function startMetaCredentialCheck(intervaloMs = 30 * 60 * 1000) {
  ejecutarVerificacionMeta();
  const t = setInterval(ejecutarVerificacionMeta, intervaloMs);
  if (t.unref) t.unref();
  return t;
}

/** Lanza la verificacion de credencial en segundo plano (no bloquea el arranque). */
function startCentralCredentialCheck(intervaloMs = 15 * 60 * 1000) {
  const ejecutar = () => {
    verificarCredencialEmpresa()
      .then(r => {
        centralCredentialStatus = { ...r, verificado: true, ts: new Date().toISOString() };
        if (r.configurada && r.valida === false) {
          console.error(`[Health] [CREDENCIAL EMPRESA] ${r.detalle} (HTTP ${r.status})`);
        }
      })
      .catch(err => { centralCredentialStatus = { verificado: false, detalle: err.message }; });
  };
  ejecutar();
  const t = setInterval(ejecutar, intervaloMs);
  if (t.unref) t.unref();
  return t;
}
import { syncVtigerContactDual } from './services/dual_sync_service.js';
import { runVtigerSalesBridge } from './services/vtiger_sales_bridge.js';
import { runOrderHistoryBackfill, getBackfillStatus } from './services/vtiger_order_history_service.js';
import { runBuyersBackfill, getBuyersBackfillStatus, resetBuyersBackfill, contarContactosGhl, COMPRADORES_POR_SEDE, TOTAL_COMPRADORES } from './services/vtiger_buyers_backfill.js';
import { getActiveSedeAgents, getSedeAgent } from './agents/sede_agent.js';
import { reportSecrets } from './config/secrets.js';
import { getOperationalSedeIds, getDegradedSedes } from './config/sedes_gateway.js';
import { getQueue, getQueueStatus, JOBS, QUEUES } from './services/queue/durable_queue.js';
import { getBreakersStatus } from './utils/circuit_breaker.js';
import { hydrateAllStores, PERSISTENCE_DRIVER as STATE_DRIVER_CONFIGURADO } from './services/state/state_store.js';
import { hydrateCursorStates } from './services/curador_bidireccional_service.js';
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const { apiKey, locationId } = GHL_CONFIG;

const COUNTERS_FILE = path.join(process.cwd(), 'counters.json');
const STATS_FILE = path.join(process.cwd(), 'stats.json');

// Global Health & Logging State
global.apiCounters = {
  ghl: 0,
  meta: 0
};

try {
  if (fs.existsSync(COUNTERS_FILE)) {
    const data = JSON.parse(fs.readFileSync(COUNTERS_FILE, 'utf-8'));
    global.apiCounters.ghl = data.ghl || 0;
    global.apiCounters.meta = data.meta || 0;
  }
} catch (e) {
  console.error("Error cargando counters.json", e);
}

// Persistir cada 10 segundos
setInterval(() => {
  try {
    fs.writeFileSync(COUNTERS_FILE, JSON.stringify(global.apiCounters));
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
  } catch (e) {
    console.error("Error guardando estados en JSON", e);
  }
}, 10000);

global.liveLogs = [];
global.pushLiveLog = (msg) => {
  const time = new Date().toLocaleTimeString('es-PE', { hour12: false });
  global.liveLogs.unshift(`[${time}] ${msg}`);
  if (global.liveLogs.length > 6) global.liveLogs.pop();
};

const HEADERS_CONTACTS = GHL_HEADERS;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// fetchWithRetry ahora es un wrapper delgado sobre ghlFetch (centralizado en ghl_http_client.js)
async function fetchWithRetry(url, options, attempt = 1) {
  return ghlFetch(url, options, attempt, 'Radar');
}

let isFastSyncRunning = false;
let lastSyncTime = null;
let metaConnectionStatus = { 
  isConfigured: Boolean(
    process.env.META_ACCESS_TOKEN_PALACIOS || 
    process.env.META_ACCESS_TOKEN_BENAVIDES || 
    process.env.META_ACCESS_TOKEN_ROOSEVELT || 
    process.env.META_ACCESS_TOKEN_PIURA || 
    process.env.META_BACKUP_TOKENS
  ) 
};
let vtigerConnectionStatus = { status: 'PENDING', message: 'Checking...' };

let stats = {
  totalRuns: 0,
  contactsProcessed: 0,
  tagsInjected: 0,
  webhooksReceived: 0,
  metaWebhooksReceived: 0,
  // Pipeline Maestro Comercial
  opportunitiesCreated: 0,
  oppsPrecalificado: 0,
  oppsCalificado: 0,
  oppsRemarketing: 0,
  oppsGanado: 0,
  // Pipeline Auditoría Multi-Touch (4 Etapas Estrictas)
  leadsAudited: 0,
  leadsX1: 0,
  leadsX2: 0,
  leadsX3: 0,
  leadsX4Plus: 0,
  leadsDiscountTotal: 0,
  // Asignaciones por Sede
  palaciosAssigned: 0,
  benavidesAssigned: 0,
  rooseveltAssigned: 0,
  piuraAssigned: 0,
  // Meta Dev API Metrics
  metaExclusionsSent: 0,
  metaCapiEventsSent: 0,
  // vTiger Spider Buffer Metrics
  vtigerSynced: 0,
  vtigerQueue: 0,
  vtigerStatus: 'Desconectado'
};

// ==========================================
// 1. CARRIL ÚNICO PROTEGIDO: Asignación e Hidratación de Leads Frescos
// Procesa únicamente contactos con actividad reciente (últimos 30 min)
// Cadencia segura: 1 ciclo cada 20 segundos con pausa estricta de 500ms entre contactos.
// ==========================================

const processedContactTimestamps = new Map();

/**
 * [RUNTIME] Poda automática del mapa de contactos procesados.
 * Se registra desde src/server.js (registerBackgroundSchedulers), NO al importar
 * el módulo, para que los smoke tests puedan cargar la app sin side effects.
 */
export function startMemoryGuard() {
  return setInterval(() => {
    const cutoff = Date.now() - (48 * 60 * 60 * 1000);
    let pruned = 0;
    for (const [id, ts] of processedContactTimestamps) {
      if (ts < cutoff) {
        processedContactTimestamps.delete(id);
        pruned++;
      }
    }
    if (pruned > 0 || processedContactTimestamps.size > 100) {
      console.log(`[Memory Guard] [CLEANUP] Mapa podado: ${pruned} entradas eliminadas. Tamaño actual: ${processedContactTimestamps.size}`);
    }
  }, 10 * 60 * 1000);
}

async function runExpressAssignment() {
  if (isFastSyncRunning) return;
  isFastSyncRunning = true;

  try {
    const timeStr = new Date().toLocaleTimeString('es-PE', { hour12: false });
    const targetLocations = getActiveSedes().filter(s => !s.isPaused).map(s => ({
      id: s.ghl.locationId,
      headers: getGhlHeaders({ locationId: s.ghl.locationId }),
      name: s.name
    }));

    let countNew = 0;

    await Promise.all(targetLocations.map(async (loc) => {
      if (!loc.id) return;
      const url = `https://services.leadconnectorhq.com/contacts/?locationId=${loc.id}&limit=20&sortBy=date_updated`;
      const res = await fetchWithRetry(url, { headers: loc.headers });
      if (res.status !== 200) {
        console.warn(`[${timeStr}] [Worker 1] Status API (${loc.name}): ${res.status} - Verifica credenciales de subcuenta.`);
        return;
      }

      const data = await res.json();
      const contacts = data.contacts || [];

      // Capturar también actividad reciente en conversaciones (Facebook Messenger / DM)
      try {
        const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${loc.id}&limit=20`;
        const convRes = await fetchWithRetry(convUrl, { headers: { ...loc.headers, 'Version': '2021-04-15' } });
        if (convRes.status === 200) {
          const convData = await convRes.json();
          for (const cv of (convData.conversations || [])) {
            if (cv.contactId) {
              const existing = contacts.find(c => c.id === cv.contactId);
              if (!existing) {
                contacts.push({
                  id: cv.contactId,
                  dateUpdated: cv.lastMessageDate,
                  firstName: cv.contactName || 'Lead Chat',
                  isUnassigned: !cv.assignedTo
                });
              } else if (!cv.assignedTo) {
                existing.isUnassigned = true;
              }
            }
          }
        }
      } catch (cErr) {}

      for (const contact of contacts) {
        const updatedAt = new Date(contact.dateUpdated || contact.dateAdded).getTime();
        const lastProcessedUpdate = processedContactTimestamps.get(contact.id) || 0;
        
        // Si ya procesamos esta actualización exacta saltamos (previene loops). 
        // [MOD]: Hemos quitado el check de (!contact.isUnassigned) para que el radar procese leads nuevos obligatoriamente aunque alguien ya se los haya asignado manualmente en GHL.
        if (updatedAt <= lastProcessedUpdate) continue;

        const hoursAgo = (Date.now() - updatedAt) / (1000 * 60 * 60);
        // Ampliamos la ventana a 24 horas para que el servidor "recupere" los leads que llegaron mientras Render estaba dormido
        if (hoursAgo > 24) continue;

        countNew++;
        console.log(`[${timeStr}] [Worker 1] [PROCESSING] Lead fresco (${loc.name}): ${contact.firstName || ''} ${contact.lastName || ''} (${contact.id})...`);
        
        const result = await routeChatByContact(contact.id, true, false, { locationId: loc.id, headers: loc.headers });
        
        // Si GHL devolvió 500/502 o requiere reintento de indexación, NO guardamos en el mapa para que se reintente en el próximo ciclo
        if (result === 'RETRY' || result === 'RETRY_INDEXING') {
          console.log(`[${timeStr}] [Worker 1] [RETRY] Contacto ${contact.id} marcado para re-proceso en el siguiente ciclo (Status: ${result}).`);
        } else {
          // Guardamos el timestamp exacto de esta actualización para no volver a procesarla hasta que el lead vuelva a hacer algo
          processedContactTimestamps.set(contact.id, updatedAt);
          stats.contactsProcessed++;
        }
        
        // Rate-Limit Shield Aislado: 100ms entre contactos (optimizado para velocidad extrema)
        await sleep(100);
      }
    }));

    if (countNew === 0) {
      console.log(`[${timeStr}] [Worker 1] [RADAR-STANDBY] Radar en vivo activo. (Sin mensajes nuevos en los ultimos 30 min - Esperando trafico...)`);
    }

    lastSyncTime = new Date().toISOString();
    global.lastRadarActivity = Date.now();
    stats.totalRuns++;
  } catch (err) {
    console.error("[Express Assignment Error]:", err.message);
  } finally {
    isFastSyncRunning = false;
  }
}

// ==========================================
// [RUNTIME] Los siguientes ciclos de fondo se registran desde src/server.js
// (registerBackgroundSchedulers) para que el módulo sea importable en pruebas
// sin disparar tráfico contra GHL / vTiger:
//   - Radar de asignación        : cada 5 s
//   - Guardián de bandejas       : cada 60 s
//   - Sync inverso vTiger -> GHL : cada 180 s
//   - Cola de reintentos vTiger  : cada 60 s
// ==========================================

// NOTA: Pollers concurrentes desactivados para evitar solapamiento de llamadas a la API
// setInterval(runChatRouterPoller, 15000);
// setInterval(runInboxSedeCleaner, 45000);
// setInterval(runSupervisorAuditor, 60000);

// [GUARDIAN] GUARDIÁN CONTINUO DE BANDEJAS SIN ASIGNAR (MULTI-SEDE EN SIMULTÁNEO: PALACIOS & BENAVIDES)
// Barre cada 60 segundos en paralelo para garantizar que ningún lead quede "Sin asignar"
let isUnassignedGuardianRunning = false;
export async function runUnassignedConversationsGuardian() {
  if (isUnassignedGuardianRunning) return;
  isUnassignedGuardianRunning = true;
  try {
    const targetLocations = getActiveSedes().filter(s => !s.isPaused).map(s => ({
      id: s.ghl.locationId,
      headers: getGhlHeaders({ locationId: s.ghl.locationId }),
      name: s.name
    }));

    await Promise.all(targetLocations.map(async (loc) => {
      if (!loc.id) return;
      const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${loc.id}&limit=50`;
      const res = await fetchWithRetry(convUrl, { headers: { ...loc.headers, 'Version': '2021-04-15' } });
      if (res.status !== 200) return;

      const data = await res.json();
      const unassigned = (data.conversations || []).filter(c => !c.assignedTo && c.contactId);
      for (const conv of unassigned) {
        console.log(`[Unassigned Guardian] [LEAD-UNASSIGNED] Lead sin asignar detectado en ${loc.name}: ${conv.contactName || 'Lead'} (${conv.contactId}). Enrutando...`);
        await routeChatByContact(conv.contactId, true, false, { locationId: loc.id, headers: loc.headers });
        await sleep(600);
      }
    }));
  } catch (gErr) {
    console.error('[Unassigned Guardian Error]:', gErr.message);
  } finally {
    isUnassignedGuardianRunning = false;
  }
}


// ==========================================
// 2. GUARDIÁN CONTINUO DE AUTO-AUDITORÍA — DESACTIVADO (Ahorro de API)
// ==========================================
// setInterval(runContinuousAutoAuditCycle, 45000);
// setTimeout(runContinuousAutoAuditCycle, 5000);

// ==========================================
// 2.5. PATRULLERO META INBOX — DESACTIVADO (Ahorro de API)
// ==========================================
// setInterval(async () => {
//   if (!global.apiCounters) return;
//   await scanMetaInboxForDuplicates();
// }, 60000);
// setTimeout(async () => {
//   if (global.apiCounters) await scanMetaInboxForDuplicates();
// }, 8000);

// ==========================================
// 3. HTTP ENDPOINTS, DASHBOARD & WEBHOOKS
// ==========================================
app.get('/', (req, res) => res.redirect('/health'));

app.get('/api/health', (req, res) => {
  const queueStatus = getQueueStatus();
  res.status(200).json({
    status: 'OK',
    // Endpoint de liveness para Render: deliberadamente superficial y sin I/O
    // para que el health check nunca marque el deploy como fallido por una
    // dependencia externa lenta (Redis/PostgreSQL/vTiger).
    uptimeSeconds: Math.round(process.uptime()),
    sedes: Object.fromEntries(
      Object.entries(SEDES_GATEWAY).map(([id, s]) => [id.toLowerCase(), {
        locationId: s.ghl.locationId || null,
        active: Boolean(s.isActive),
        configured: Boolean(s.isConfigured),
        paused: Boolean(s.isPaused)
      }])
    ),
    vtiger: vtigerConnectionStatus,
    vtigerConfig: getVtigerConfigStatus(),
    // [COMPUERTA VTIGER] Estado del semaforo hacia vTiger: cuantas consultas estan
    // activas, cuantas en espera y la espera media. Sirve para ver si vTiger se esta
    // saturando antes de que aparezcan abortos en los logs.
    vtigerGate: getVtigerGateMetrics(),
    // [DIAGNOSTICO] Estado de la Cuenta Empresa. Expone SOLO presencia de
    // credenciales, nunca su valor. `apiKeyPresente: true` NO significa que el
    // token sirva (un PIT revocado esta presente y falla igual), por eso se
    // incluye `credencial`: el resultado de una PRUEBA REAL contra GHL.
    cuentaEmpresa: {
      configurada: isCentralConfigured(),
      locationIdPresente: Boolean(readSecret('GHL_LOCATION_ID_CENTRAL')),
      apiKeyPresente: Boolean(readSecret('GHL_API_KEY_CENTRAL')),
      rol: 'analitica macro (sin ruteo ni chats)',
      credencial: centralCredentialStatus
    },
    meta: {
      // Presencia de la variable (comprobacion barata, no implica validez).
      isConfigured: Boolean(metaConnectionStatus?.isConfigured),
      // [VEREDICTO REAL] Prueba contra la API de Meta por sede: validez del token,
      // paginas alcanzadas y permiso `pages_messaging`. Un token vencido deja la
      // atribucion publicitaria en 'DESCONOCIDO' sin ningun otro sintoma.
      credenciales: metaCredentialsStatus
    },
    infrastructure: {
      queue: queueStatus,
      breakers: getBreakersStatus(),
      audit: getAuditMetrics(),
      // [GUARDIAN DE CUOTA DIARIA] Consumo de GHL por subcuenta en la ventana de
      // 24 h. GHL permite 200,000/dia por location; el trabajo de fondo se frena
      // al llegar a GHL_DAILY_QUOTA_GUARD (por defecto 150,000, 75%) para no
      // quedarse sin cuota para la atencion en vivo.
      cuotaDiaria: tokenBucketQueue.getCuotaDiaria()
    },
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// AUDITORÍA: consulta del log estructurado de sincronización
// ==========================================
app.get('/api/audit/log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
  const type = String(req.query.type || '').replace(/[^A-Z_]/gi, '').slice(0, 40);
  res.json({
    success: true,
    metrics: getAuditMetrics(),
    events: readAuditEvents(limit, type)
  });
});

app.get('/health', (req, res) => {
  const healData = getHealMetrics();
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>GHL Master Engine & Radar</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
        <style>
          :root {
            --bg-base: #0f172a;
            --bg-card: #1e293b;
            --border-subtle: #334155;
            --text-primary: #f8fafc;
            --text-muted: #94a3b8;
            --accent-primary: #3b82f6;
            --accent-success: #10b981;
            --accent-warning: #f59e0b;
            --accent-danger: #ef4444;
            --accent-purple: #8b5cf6;
          }
          * { box-sizing: border-box; }
          body {
            font-family: 'Outfit', sans-serif;
            background-color: var(--bg-base);
            color: var(--text-primary);
            margin: 0;
            padding: 40px 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 100vh;
          }
          .container { max-width: 1280px; width: 100%; }
          .header {
            text-align: center;
            margin-bottom: 40px;
            padding-bottom: 20px;
          }
          .header h1 {
            font-size: 32px;
            font-weight: 700;
            margin: 0 0 12px 0;
            background: linear-gradient(135deg, #e2e8f0, #94a3b8);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: -0.5px;
          }
          .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: rgba(16, 185, 129, 0.1);
            color: var(--accent-success);
            border: 1px solid rgba(16, 185, 129, 0.2);
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: var(--accent-success);
            box-shadow: 0 0 10px rgba(16, 185, 129, 0.5);
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
            gap: 24px;
            margin-bottom: 40px;
          }
          .card {
            background-color: var(--bg-card);
            border: 1px solid var(--border-subtle);
            border-radius: 16px;
            padding: 24px;
            box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06);
            transition: transform 0.2s, box-shadow 0.2s;
          }
          .card:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05);
          }
          .card-title {
            font-size: 15px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--text-muted);
            margin-bottom: 20px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--border-subtle);
          }
          .metric-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 0;
            border-bottom: 1px solid rgba(51, 65, 85, 0.4);
            font-size: 14px;
          }
          .metric-row:last-child { border-bottom: none; }
          .metric-label { color: var(--text-muted); font-weight: 400; }
          .metric-value { font-weight: 600; font-size: 16px; color: var(--text-primary); font-variant-numeric: tabular-nums; }
          .sub-metric { padding-left: 16px; font-size: 13px; }
          .sub-metric .metric-label { color: #64748b; }
          .sub-metric .metric-value { font-size: 14px; }
          
          .val-green { color: var(--accent-success) !important; }
          .val-yellow { color: var(--accent-warning) !important; }
          .val-red { color: var(--accent-danger) !important; }
          .val-blue { color: var(--accent-primary) !important; }
          .val-purple { color: var(--accent-purple) !important; }
          
          .highlight-box {
            background: rgba(239, 68, 68, 0.05);
            border: 1px solid rgba(239, 68, 68, 0.2);
            border-radius: 12px;
            padding: 16px;
            margin-top: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .highlight-label { font-weight: 600; color: var(--accent-danger); font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
          .highlight-number { font-size: 24px; font-weight: 700; color: var(--accent-danger); font-variant-numeric: tabular-nums; }
          
          /* Consola Terminal */
          .terminal-box {
            background-color: #000;
            border: 1px solid var(--border-subtle);
            border-radius: 8px;
            padding: 12px;
            margin-top: 10px;
            height: 160px;
            overflow: hidden;
            font-family: 'Consolas', 'Courier New', monospace;
            font-size: 12px;
            color: #10b981;
            display: flex;
            flex-direction: column;
            justify-content: flex-end;
          }
          .terminal-line { margin: 2px 0; animation: fadeIn 0.3s ease-in; }
          @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

          .actions-row { display: flex; gap: 12px; margin-top: 20px; }
          .btn {
            flex: 1;
            background: transparent;
            border: 1px solid var(--border-subtle);
            color: var(--text-primary);
            padding: 12px 16px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            text-align: center;
            text-decoration: none;
            cursor: pointer;
            transition: all 0.2s;
          }
          .btn:hover { background: var(--border-subtle); border-color: var(--text-muted); }
          .btn-primary { background: var(--accent-primary); border-color: var(--accent-primary); color: white; }
          .btn-primary:hover { background: #2563eb; border-color: #2563eb; }
          
          .footer {
            text-align: center;
            color: var(--text-muted);
            font-size: 13px;
            margin-top: 20px;
            padding-top: 20px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>GHL Master Engine & Radar Multi-Touch</h1>
            <div class="status-badge">
              <div class="status-dot"></div>
              <span>Sistema Autónomo en Línea</span>
            </div>
          </div>

          <div class="grid">
            <!-- TABLERO 1: COMERCIAL / VENTAS -->
            <div class="card">
              <div class="card-title">Pipeline Comercial</div>
              <div class="metric-row">
                <span class="metric-label">Precalificado (Sin Teléfono)</span>
                <span class="metric-value val-yellow" id="val-oppsPrecalificado">${stats.oppsPrecalificado}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">Para Contactar (Con Teléfono)</span>
                <span class="metric-value val-blue" id="val-oppsCalificado">${stats.oppsCalificado}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">Remarketing</span>
                <span class="metric-value val-purple" id="val-oppsRemarketing">${stats.oppsRemarketing}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">Venta Cerrada (Ganado)</span>
                <span class="metric-value val-green" id="val-oppsGanado">${stats.oppsGanado}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">Total en Pipeline Comercial</span>
                <span class="metric-value" id="val-opportunitiesCreated">${stats.opportunitiesCreated}</span>
              </div>
              
              <div class="metric-row" style="margin-top: 10px; border-bottom: none; padding-bottom: 0;">
                <span class="metric-label">Total Asignaciones</span>
                <span class="metric-value">${stats.palaciosAssigned + stats.benavidesAssigned + stats.rooseveltAssigned + stats.piuraAssigned}</span>
              </div>
              <div class="metric-row sub-metric">
                <span class="metric-label">Palacios</span>
                <span class="metric-value" id="val-palaciosAssigned">${stats.palaciosAssigned}</span>
              </div>
              <div class="metric-row sub-metric">
                <span class="metric-label">Benavides</span>
                <span class="metric-value" id="val-benavidesAssigned">${stats.benavidesAssigned}</span>
              </div>
              <div class="metric-row sub-metric">
                <span class="metric-label">Roosevelt</span>
                <span class="metric-value" id="val-rooseveltAssigned">${stats.rooseveltAssigned}</span>
              </div>
              <div class="metric-row sub-metric">
                <span class="metric-label">Piura</span>
                <span class="metric-value" id="val-piuraAssigned">${stats.piuraAssigned}</span>
              </div>
            </div>

            <!-- TABLERO 2: AUDITORÍA MULTI-TOUCH -->
            <div class="card">
              <div class="card-title">Radar de Auditoría</div>
              <div class="metric-row">
                <span class="metric-label">1er Clic (Lead Nuevo / X1)</span>
                <span class="metric-value val-green" id="val-leadsX1">${stats.leadsX1}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">2do Clic (Reingreso / X2)</span>
                <span class="metric-value val-yellow" id="val-leadsX2">${stats.leadsX2}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">3er Clic (Reingreso / X3)</span>
                <span class="metric-value val-yellow" id="val-leadsX3">${stats.leadsX3}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">4to Clic+ (Saturación)</span>
                <span class="metric-value val-red" id="val-leadsX4Plus">${stats.leadsX4Plus}</span>
              </div>

              <div class="highlight-box">
                <span class="highlight-label">Total a Descontar a Agencia</span>
                <span class="highlight-number" id="val-leadsDiscountTotal">${stats.leadsDiscountTotal}</span>
              </div>
            </div>

            <!-- TABLERO 3: GUARDIÁN DE AUTO-CORRECCIÓN -->
            <div class="card">
              <div class="card-title">Self-Healer & Meta API</div>
              <div class="metric-row">
                <span class="metric-label">Estado del Guardián</span>
                <span class="metric-value val-green">Autónomo 24/7</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">Contactos Auto-Auditados</span>
                <span class="metric-value" id="val-healTotal">${healData.totalAudited}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">Discrepancias Subsanadas</span>
                <span class="metric-value val-blue" id="val-healFixed">${healData.discrepanciesFixed}</span>
              </div>
              <div class="metric-row" style="margin-top: 15px; border-bottom: none; padding-bottom: 0;">
                <span class="metric-label">Meta Developer API (MAPI)</span>
                <span class="metric-value val-green">Enlace Activo</span>
              </div>
              <div class="metric-row sub-metric">
                <span class="metric-label">Eventos de Conversión Enviados</span>
                <span class="metric-value" id="val-metaCapiEventsSent">${stats.metaCapiEventsSent}</span>
              </div>
              <div class="metric-row sub-metric">
                <span class="metric-label">Leads Excluidos de Pauta</span>
                <span class="metric-value" id="val-metaExclusionsSent">${stats.metaExclusionsSent}</span>
              </div>

              <div class="actions-row">
                <a href="/api/report/csv" class="btn" target="_blank">Reporte CSV</a>
                <button class="btn btn-primary" onclick="triggerFastSync()">Forzar Auditoría</button>
              </div>
            </div>

            <!-- TABLERO 4: CONEXIÓN VTIGER CRM -->
            <div class="card">
              <div class="card-title">Conexión vTiger CRM</div>
              <div class="metric-row">
                <span class="metric-label">Estado de Conexión</span>
                <span class="metric-value" id="val-vtigerConnectionStatus">Verificando...</span>
              </div>
              <div class="metric-row" style="font-size: 0.85em; color: var(--text-muted); border-bottom: none; padding-top: 5px;">
                <span id="val-vtigerConnectionMessage"></span>
              </div>
              <div class="metric-row">
                <span class="metric-label">Contactos Empujados a GHL</span>
                <span class="metric-value val-green" id="val-vtigerSynced">${stats.vtigerSynced}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">En Cola de Espera</span>
                <span class="metric-value val-yellow" id="val-vtigerQueue">${stats.vtigerQueue}</span>
              </div>
            </div>

            <!-- TABLERO 5: SALUD DEL SISTEMA & CONSUMO API -->
            <div class="card">
              <div class="card-title">Salud del Sistema & Consumo API</div>
              <div class="metric-row">
                <span class="metric-label">Llamadas a API GHL</span>
                <span class="metric-value val-blue" id="val-ghlApiCalls">0</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">Llamadas a API Meta</span>
                <span class="metric-value val-blue" id="val-metaApiCalls">0</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">Ciclos Completados (Poller)</span>
                <span class="metric-value val-purple" id="val-totalRuns">${stats.totalRuns}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">Uso de RAM</span>
                <span class="metric-value" id="val-memoryRss">0 MB</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">Tiempo Activo (Uptime)</span>
                <span class="metric-value" id="val-uptime">0m</span>
              </div>
            </div>

            <!-- TABLERO 6: MICROTAREAS EN VIVO -->
            <div class="card">
              <div class="card-title">Microtareas en Ejecución en Vivo</div>
              <div class="terminal-box" id="val-liveLogs">
                <div class="terminal-line">Iniciando monitor de tareas...</div>
              </div>
            </div>

          </div>

          <div class="footer">
            Operando 24/7 | Sincronización Automática
          </div>
        </div>

        <script>
          async function fetchLiveStats() {
            try {
              const res = await fetch('/api/stats');
              const data = await res.json();
              const fields = [
                'oppsPrecalificado', 'oppsCalificado', 'oppsRemarketing', 'oppsGanado', 'opportunitiesCreated', 
                'leadsX1', 'leadsX2', 'leadsX3', 'leadsX4Plus', 'leadsDiscountTotal', 
                'vtigerSynced', 'vtigerQueue', 'vtigerStatus',
                'palaciosAssigned', 'benavidesAssigned', 'rooseveltAssigned', 'piuraAssigned',
                'metaCapiEventsSent', 'metaExclusionsSent', 'totalRuns'
              ];
              fields.forEach(f => {
                const el = document.getElementById('val-' + f);
                if (el && el.innerText !== String(data.stats[f])) {
                  el.innerText = data.stats[f];
                }
              });
              const vtigerConnEl = document.getElementById('val-vtigerConnectionStatus');
              if (vtigerConnEl && data.vtigerConnectionStatus) {
                const isOk = data.vtigerConnectionStatus.status === 'OK';
                vtigerConnEl.innerText = isOk ? 'Conectado' : 'Desconectado';
                vtigerConnEl.className = 'metric-value ' + (isOk ? 'val-green' : 'val-red');
                
                const msgEl = document.getElementById('val-vtigerConnectionMessage');
                if (msgEl) {
                  msgEl.innerText = isOk ? 'Sincronización bidireccional activa' : data.vtigerConnectionStatus.message;
                }
              }

              if (data.systemHealth) {
                const memEl = document.getElementById('val-memoryRss');
                if (memEl) memEl.innerText = (data.systemHealth.memoryRss / 1024 / 1024).toFixed(1) + ' MB';
                
                const upEl = document.getElementById('val-uptime');
                if (upEl) {
                  const m = Math.floor(data.systemHealth.uptime / 60);
                  const h = Math.floor(m / 60);
                  upEl.innerText = h > 0 ? h + 'h ' + (m % 60) + 'm' : m + 'm';
                }

                const ghlApiEl = document.getElementById('val-ghlApiCalls');
                if (ghlApiEl) ghlApiEl.innerText = data.systemHealth.ghlApiCalls;
                
                const metaApiEl = document.getElementById('val-metaApiCalls');
                if (metaApiEl) metaApiEl.innerText = data.systemHealth.metaApiCalls;
              }
              if (data.liveLogs && Array.isArray(data.liveLogs)) {
                const logsEl = document.getElementById('val-liveLogs');
                if (logsEl) {
                  let html = '';
                  data.liveLogs.slice().reverse().forEach(log => {
                    html += '<div class="terminal-line">' + log + '</div>';
                  });
                  if (html !== logsEl.innerHTML) {
                     logsEl.innerHTML = html;
                  }
                }
              }
              if (data.healMetrics) {
                const hT = document.getElementById('val-healTotal');
                if (hT) hT.innerText = data.healMetrics.totalAudited;
                const hF = document.getElementById('val-healFixed');
                if (hF) hF.innerText = data.healMetrics.discrepanciesFixed;
              }
            } catch (err) {}
          }
          setInterval(fetchLiveStats, 2500);

          async function triggerFastSync() {
            alert('Ejecutando ciclo forzado de auto-auditoría y corrección...');
            await fetch('/api/audit/heal', { method: 'POST' });
          }
        </script>
      </body>
    </html>
  `);
});

app.get('/api/stats', (req, res) => {
  const systemHealth = {
    uptime: process.uptime(),
    memoryRss: process.memoryUsage().rss,
    ghlApiCalls: global.apiCounters.ghl,
    metaApiCalls: global.apiCounters.meta
  };
  res.json({ 
    stats, 
    lastSyncTime, 
    metaConnectionStatus, 
    vtigerConnectionStatus,
    healMetrics: getHealMetrics(),
    auditorStats,
    systemHealth,
    queue: getQueueStatus(),
    breakers: getBreakersStatus(),
    liveLogs: global.liveLogs
  });
});

app.post('/api/telemetry/vtiger', (req, res) => {
  const { synced, queue, status } = req.body;
  if (synced !== undefined) stats.vtigerSynced = synced;
  if (queue !== undefined) stats.vtigerQueue = queue;
  if (status !== undefined) stats.vtigerStatus = status;
  res.json({ success: true });
});

app.post('/api/audit/heal', async (req, res) => {
  runContinuousAutoAuditCycle();
  runExpressAssignment();
  res.json({ success: true, message: 'Ciclo de auto-auditoría y corrección disparado' });
});

app.get('/api/report/csv', (req, res) => {
  const files = fs.readdirSync(process.cwd()).filter(f => f.startsWith('reporte_descuentos_agencia_') && f.endsWith('.csv'));
  if (files.length === 0) {
    return res.status(404).send('No se ha generado un reporte CSV aún.');
  }
  files.sort().reverse();
  const latestFile = path.join(process.cwd(), files[0]);
  res.download(latestFile);
});

app.post('/webhook/ghl-contact', async (req, res) => {
  try {
    // ==========================================
    // [SANITIZACIÓN DE ENTRADA — OBLIGATORIA]
    // ==========================================
    // Este endpoint es público y su contenido termina escrito en el CRM.
    // Toda entrada pasa por allow-list + saneado por tipo ANTES de cualquier
    // log, consulta o escritura: bloquea prototype pollution, XSS almacenado,
    // payloads de agotamiento y manipulación de campos.
    const rawPayload = req.body || {};
    const taint = detectInjectionPatterns(rawPayload);
    if (taint.suspicious) {
      recordAuditEvent({
        type: 'WEBHOOK_TAINT_DETECTED',
        severity: 'warn',
        endpoint: '/webhook/ghl-contact',
        reasons: taint.reasons,
        sourceIp: req.ip
      });
    }

    const contactPayload = sanitizeContactPayload(rawPayload);
    // El locationId del nivel superior se conserva saneado (se usa para enrutar).
    contactPayload.locationId = contactPayload.locationId || sanitizeId(rawPayload.locationId || rawPayload.location_id);
    if (contactPayload.contact) {
      contactPayload.contact.locationId = contactPayload.contact.locationId || contactPayload.locationId;
    }

    // El log de auditoría guarda el payload YA SANEADO (nunca el crudo de red).
    const logPath = path.join(process.cwd(), 'scratch', 'webhook_logs.txt');
    try {
      if (fs.existsSync(logPath)) {
        const logStat = fs.statSync(logPath);
        if (logStat.size > 4 * 1024 * 1024) {
          const logContent = fs.readFileSync(logPath, 'utf8');
          const logLines = logContent.split('\n');
          fs.writeFileSync(logPath, logLines.slice(-500).join('\n'), 'utf8');
        }
      }
      fs.appendFileSync(logPath, JSON.stringify(contactPayload) + '\n');
    } catch (e) {
      // safe fallback
    }
    let contactData = contactPayload.contact || contactPayload;
    let effectiveLocId = contactData.locationId || contactPayload.locationId || SEDES_GATEWAY.PALACIOS.ghl.locationId;

    // [HERMETISMO ESTRICTO]: Enrutamiento forzoso a la subcuenta correcta según la sede del contacto
    const detectedSede = (
      contactData.sede || 
      contactData.targetSede || 
      (contactData.customFields || []).find(f => f.key === 'contact.vtiger_sede__tienda_compra' || f.id === 'W12pi3cD5ZbY8R2NqlwL' || f.id === '50pTZdtYYYcF1Wtz4j4s')?.field_value ||
      (contactData.tags || []).find(t => typeof t === 'string' && t.startsWith('sede-'))?.replace('sede-', '') ||
      ''
    ).toUpperCase().trim();

    if (detectedSede === 'BENAVIDES') {
      effectiveLocId = SEDES_GATEWAY.BENAVIDES.ghl.locationId;
    } else if (detectedSede === 'PALACIOS') {
      effectiveLocId = SEDES_GATEWAY.PALACIOS.ghl.locationId;
    }
    if (!contactData.id) {
      
      // FIX AGENTE 1: Si vTiger envía un lead sin teléfono ni correo, GHL lo rechazará (HTTP 400).
      // Le asignaremos un correo ficticio para que el lead se cree y la información sea visible.
      let safeEmail = contactData.email;
      if (!contactData.email && !contactData.phone) {
         const cleanName = (contactData.name || contactData.firstName || 'lead').toLowerCase().replace(/[^a-z0-9]/g, '');
         safeEmail = `${cleanName}-${Date.now()}@vtigermigrated.com`;
      }

      const upsertBody = {
        locationId: effectiveLocId,
        firstName: contactData.firstName,
        lastName: contactData.lastName,
        name: contactData.name,
        email: safeEmail,
        phone: contactData.phone,
        city: contactData.city,
        state: contactData.state,
        timezone: contactData.timezone,
        source: contactData.source,
        customFields: contactData.customFields,
        tags: contactData.tags
      };
      
      const upsertHeaders = getGhlHeaders({ locationId: effectiveLocId });
      const upsertRes = await fetchWithRetry('https://services.leadconnectorhq.com/contacts/upsert', {
        method: 'POST',
        headers: upsertHeaders,
        body: JSON.stringify(upsertBody)
      });
      
      if (upsertRes.status === 200 || upsertRes.status === 201) {
        const upsertJson = await upsertRes.json();
        contactData.id = upsertJson.contact.id;
      } else {
        const errText = await upsertRes.text();
        console.error("[Webhook] Error upserting vTiger contact:", errText);
        return res.status(400).send({ error: 'Failed to create contact in GHL', details: errText });
      }
    }

    if (!contactData || !contactData.id) {
      return res.status(400).send({ error: 'Missing contact data or ID' });
    }

    // AGENTE 1: FAST SYNC INMEDIATO (Push-based, fluido y sin delay)
    // Worker 1 / Worker 3: Ingesta Inmediata y Ruteo Inteligente.
    // [FEATURE FLAG] Con QUEUE_DRIVER=bullmq el ruteo viaja como job durable
    // (reintentos exponenciales + DLQ). Con memory, se mantiene el setImmediate
    // actual para no cambiar el comportamiento en producción.
    const queueStatus = getQueueStatus();
    if (queueStatus.enabled) {
      getQueue(QUEUES.WEBHOOKS)
        .enqueue(JOBS.GHL_CONTACT_WEBHOOK, { contactId: contactData.id, locationId: effectiveLocId })
        .catch(err => console.error('[Queue] No se pudo encolar el webhook GHL:', err.message));
    } else {
      setImmediate(async () => {
        try {
          const routeResult = await routeChatByContact(contactData.id, true, false, { locationId: effectiveLocId });
          if (routeResult === 'RETRY') {
            setTimeout(() => routeChatByContact(contactData.id, true, false, { locationId: effectiveLocId }), 1500);
          }
          if (global.pushLiveLog) global.pushLiveLog(`[WORKER] Worker 1 Webhook: Ruteado e hidratado ${contactData.id} (${effectiveLocId})`);
        } catch (err) {
          console.error("[Worker 1 Webhook Error]:", err.message);
        }
      });
    }

    stats.webhooksReceived++;
    res.status(200).send({ success: true, message: 'Webhook payload received and queued for immediate processing' });

  } catch (error) {
    console.error("[Webhook Error]:", error.message);
  }
});

// ==========================================
// AGENTE 3: ENRUTADOR DE CHATS Y ANTI-VIVAZOS
// ==========================================
app.post('/webhook/chat-router', async (req, res) => {
  try {
    const payload = req.body || {};
    let contactId = payload.contactId || payload.contact_id || payload.id || (payload.contact && payload.contact.id);
    const targetLoc = payload.locationId || payload.location_id || req.query?.locationId || req.query?.location_id;
    
    if (!contactId) {
      return res.status(400).send({ error: 'Falta contactId en el payload.' });
    }
    
    res.status(200).send({ success: true, message: 'Webhook recibido, enrutando...' });
    
    // [FEATURE FLAG] Cola durable cuando está habilitada; setImmediate en modo memoria.
    if (getQueueStatus().enabled) {
      getQueue(QUEUES.WEBHOOKS)
        .enqueue(JOBS.GHL_CONTACT_WEBHOOK, { contactId, locationId: targetLoc || undefined })
        .catch(err => console.error('[Queue] No se pudo encolar el chat-router:', err.message));
      return;
    }

    // Llamar al Agente 3 de forma asíncrona inmediata
    setImmediate(async () => {
      try {
        await routeChatByContact(contactId, true, false, targetLoc ? { locationId: targetLoc } : {});
      } catch (rErr) {
        console.error("[Chat Router Webhook Error]:", rErr.message);
      }
    });
  } catch (error) {
    console.error("[Agente 3 Webhook Error]:", error.message);
  }
});

// ==========================================
// AGENTE 4: META NATIVO WEBHOOK (Bypass GHL)
// ==========================================
app.get('/webhook/meta', (req, res) => {
  const verifyToken = META_CONFIG.webhookVerifyToken;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (!verifyToken) {
    // Fail-safe: sin token configurado se cierra la verificación en lugar de
    // aceptar cualquier valor (antes existía un token por defecto hardcodeado).
    console.error('[META] [FATAL-CONFIG] META_WEBHOOK_VERIFY_TOKEN no configurado. Verificación de webhook rechazada.');
    return res.sendStatus(403);
  }

  if (mode && token) {
    if (mode === 'subscribe' && token === verifyToken) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

app.post('/webhook/meta', async (req, res) => {
  try {
    const payload = req.body;
    // Responder rápido a Facebook para evitar timeouts
    res.status(200).send('EVENT_RECEIVED');
    
    // Procesar en segundo plano
    await processMetaWebhook(payload);
  } catch (error) {
    console.error("[Meta Webhook Receptor Error]:", error.message);
  }
});

// ==========================================
// VTIGER CRM: Webhook Receptor & Sincronización
// ==========================================
/**
 * [TICKET 1] Webhook receptor para eventos de vTiger (onContactCreate/Update,
 * onOrderCreate) enviados por un bridge del lado de vTiger o Make.
 *
 * vTiger NO emite webhooks por sí mismo: este endpoint existe para que un
 * disparador externo (trigger de BD, watcher o Make) entregue el registro en
 * vivo. Responde 200 de inmediato y procesa el upsert DUAL en segundo plano,
 * de modo que el emisor nunca sufre timeout.
 */
app.post('/webhook/vtiger-sync', async (req, res) => {
  try {
    const raw = req.body || {};

    // Lectura defensiva: el registro puede venir suelto o envuelto.
    const registro = raw.contact || raw.data?.contact || raw.data || raw.record || raw;

    // Respuesta inmediata: el emisor no espera al CRM.
    res.status(200).send({ success: true, message: 'Registro recibido, sincronización dual en curso.' });

    setImmediate(async () => {
      try {
        const taint = detectInjectionPatterns(registro);
        if (taint.suspicious) {
          recordAuditEvent({
            type: 'WEBHOOK_TAINT_DETECTED',
            severity: 'warn',
            endpoint: '/webhook/vtiger-sync',
            reasons: taint.reasons,
            sourceIp: req.ip
          });
        }

        const resultado = await syncVtigerContactDual(registro);

        if (resultado.skipped) {
          console.warn(`[vTiger Sync] [SKIP] Registro descartado: ${resultado.reason}`);
        } else if (resultado.ok) {
          console.log(`[vTiger Sync] [OK] ${registro.firstname || ''} ${registro.lastname || ''} -> sede ${resultado.sedeId} | macro: ${resultado.macro?.ok ? 'ok' : 'n/a'} | operativa: ${resultado.operativa?.ok ? (resultado.operativa.created ? 'creado' : 'actualizado') : 'falló'}`);
          if (global.pushLiveLog) {
            global.pushLiveLog(`[VTIGER-SYNC] ${registro.firstname || ''} ${registro.lastname || ''} sincronizado a ${resultado.sedeId}`);
          }
        }
      } catch (err) {
        console.error('[vTiger Sync Background Error]:', err.message);
        recordAuditEvent({ type: 'DUAL_SYNC_EXCEPTION', severity: 'error', endpoint: '/webhook/vtiger-sync', message: err.message });
      }
    });
  } catch (error) {
    console.error("[vTiger Sync Webhook Error]:", error.message);
    if (!res.headersSent) res.status(500).send({ success: false, error: 'Error interno' });
  }
});

/**
 * [TICKET 1] Disparo manual del puente de ventas vTiger -> GHL.
 * Útil para recuperar ventas históricas sin esperar al ciclo programado.
 * Query: ?horas=48&soloCompradores=true&limite=50
 */
app.post('/api/vtiger/sales-bridge', async (req, res) => {
  try {
    const horas = Math.min(Math.max(parseInt(req.query.horas || req.body?.horas || '24', 10) || 24, 1), 8760);
    const limite = Math.min(Math.max(parseInt(req.query.limite || req.body?.limite || '50', 10) || 50, 1), 200);
    const soloCompradores = String(req.query.soloCompradores ?? req.body?.soloCompradores ?? 'true') !== 'false';

    res.json({ success: true, message: `Puente de ventas iniciado (${horas} h, limite ${limite}/sede). Consulta los logs para el resultado.` });

    setImmediate(() => {
      runVtigerSalesBridge({ horasAtras: horas, soloCompradores, limitePorSede: limite })
        .catch(err => console.error('[Sales Bridge] Error en ciclo manual:', err.message));
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * [TICKET 1] Historial de compras vTiger -> GHL (detalle de órdenes).
 * Avanza UN lote del backfill reanudable. Llamar repetidamente hasta que
 * `completo: true`. El cursor persiste, así que no repite trabajo.
 * Query: ?lote=50&lotes=1 (contactos por lote y lotes por ejecución)
 */
app.post('/api/vtiger/order-history', async (req, res) => {
  try {
    const lote = Math.min(Math.max(parseInt(req.query.lote || req.body?.lote || '50', 10) || 50, 1), 150);
    const lotes = Math.min(Math.max(parseInt(req.query.lotes || req.body?.lotes || '1', 10) || 1, 1), 20);
    res.json({ success: true, message: `Backfill de historial iniciado (${lotes} lote(s) de ${lote}). Consulta /api/vtiger/order-history/status.` });
    setImmediate(() => {
      runOrderHistoryBackfill({ tamanoLote: lote, maxLotes: lotes })
        .catch(err => console.error('[Order Backfill] Error:', err.message));
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Estado del backfill de historial (progreso y totales acumulados). */
app.get('/api/vtiger/order-history/status', async (req, res) => {
  try {
    res.json({ success: true, estado: await getBackfillStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * [BACKFILL DE COMPRADORES] Avanza UN lote del recorrido completo de la cartera.
 * Es lo que cierra la brecha historica: el puente incremental solo mira lo
 * reciente y esta topado, asi que sin esto el resto de los compradores nunca se
 * alcanza. El cursor persiste: llamar repetidamente hasta `completo: true`.
 * Query: ?lote=50&lotes=1
 */
app.post('/api/vtiger/buyers-backfill', async (req, res) => {
  try {
    const lote = Math.min(Math.max(parseInt(req.query.lote || req.body?.lote || '50', 10) || 50, 1), 150);
    const lotes = Math.min(Math.max(parseInt(req.query.lotes || req.body?.lotes || '1', 10) || 1, 1), 20);
    res.json({ success: true, message: `Backfill de compradores iniciado (${lotes} lote(s) de ${lote}). Consulta /api/vtiger/buyers-backfill/status.` });
    setImmediate(() => {
      runBuyersBackfill({ tamanoLote: lote, maxLotes: lotes })
        .catch(err => console.error('[Buyers Backfill] Error:', err.message));
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Estado del backfill de compradores (progreso por sede y totales acumulados). */
app.get('/api/vtiger/buyers-backfill/status', async (req, res) => {
  try {
    res.json({ success: true, estado: await getBuyersBackfillStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * [TIEMPO REAL] Panel unificado de sincronizacion: lo IMPLEMENTADO vs lo PENDIENTE.
 *
 * Responde, en un solo endpoint, el estado de las 4 sedes (contra el conteo real
 * de compradores en vTiger), el ritmo medido, el ETA, y la Cuenta Empresa:
 *   GET /api/sync/estado
 *
 * Es la auditoria que pide el usuario: "cuanto va, cuanto falta, cuanto tarda".
 */
app.get('/api/sync/estado', async (req, res) => {
  try {
    const estado = await getBuyersBackfillStatus();

    // Configuracion de cada sede: subcuenta propia o solo espejo a Empresa.
    // [CONTEO REAL EN GHL] Se consulta el total de contactos de cada subcuenta: es
    // la unica prueba directa de que el sync esta escribiendo donde debe.
    const sedes = {};
    for (const [sede, cfg] of Object.entries(SEDES_GATEWAY || {})) {
      if (!COMPRADORES_POR_SEDE[sede]) continue; // solo las 4 sedes de vTiger
      const s = estado.porSede?.[sede] || {};
      let contactosEnGhl = null;
      if (cfg?.ghl?.locationId) {
        try { contactosEnGhl = await contarContactosGhl(cfg.ghl.locationId); } catch { contactosEnGhl = null; }
      }
      sedes[sede] = {
        compradoresTotal: COMPRADORES_POR_SEDE[sede],
        procesados: s.procesados ?? 0,
        pendientes: s.pendientes ?? COMPRADORES_POR_SEDE[sede],
        pct: s.pct ?? 0,
        contactosEnGhl,
        subcuenta: cfg?.ghl?.locationId ? 'CONFIGURADA' : 'PENDIENTE CREAR',
        espejoEmpresa: true // todas las sedes espejan a la Empresa (BI)
      };
    }

    // Cuenta Empresa: total de contactos en GHL (copia fiel de vTiger).
    let empresaContactos = null;
    try {
      const locEmpresa = readSecret('GHL_LOCATION_ID_CENTRAL');
      if (locEmpresa) empresaContactos = await contarContactosGhl(locEmpresa);
    } catch { empresaContactos = null; }

    res.json({
      success: true,
      generadoEn: new Date().toISOString(),
      resumen: {
        compradoresTotal: TOTAL_COMPRADORES,
        procesados: estado.procesadosTotal,
        pendientes: estado.pendientesTotal,
        pct: estado.pctTotal,
        ritmoContactosPorHora: estado.ritmo?.contactosPorHora || null,
        etaHoras: estado.ritmo?.etaHoras || null,
        etaDias: estado.ritmo?.etaDias || null,
        ultimaEjecucion: estado.ultimaEjecucion || null
      },
      sedes,
      empresa: {
        contactosTotales: empresaContactos,
        rol: 'copia fiel BI de las 4 sedes',
        subcuenta: 'CONFIGURADA'
      },
      notas: [
        'Procesados = offset del cursor (compradores recorridos en orden descendente).',
        'Ritmo/ETA = calculado del historial real guardado tras cada lote; nulo hasta el segundo lote.',
        'Roosevelt y Piura: sin subcuenta propia aun -> se espejan SOLO a la Empresa.'
      ]
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Reinicia el cursor del backfill para recorrer la cartera desde cero. */
app.post('/api/vtiger/buyers-backfill/reset', async (req, res) => {
  try {
    await resetBuyersBackfill();
    res.json({ success: true, message: 'Cursor reiniciado. El proximo ciclo recorre desde el inicio.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * [ESTRENO DE SUBCUENTAS] Clona los campos personalizados de una sede de
 * referencia (Palacios, que tiene los 27 resueltos) hacia las demas subcuentas.
 *
 * Es lo que permite estrenar Roosevelt y Piura: al crearlas en GHL nacen SIN los
 * campos, y el sync resuelve los campos POR NOMBRE. Sin este paso esas sedes solo
 * recibirian los campos nativos (direccion) y perderian compras/fechas/producto.
 *
 *   POST /api/sedes/clonar-campos                 (referencia = PALACIOS)
 *   POST /api/sedes/clonar-campos?referencia=X
 *
 * Es idempotente: los campos que ya existen NO se duplican.
 */
app.post('/api/sedes/clonar-campos', async (req, res) => {
  try {
    const referenciaId = String(req.query.referencia || 'PALACIOS').toUpperCase();
    const ref = SEDES_GATEWAY[referenciaId];
    if (!ref?.ghl?.apiKey || !ref?.ghl?.locationId) {
      return res.status(400).json({ success: false, error: `La sede de referencia ${referenciaId} no esta configurada.` });
    }
    const cabeceras = (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
      Version: '2021-07-28',
      Accept: 'application/json',
      'Content-Type': 'application/json'
    });
    const urlCampos = (locId) => `https://services.leadconnectorhq.com/locations/${locId}/customFields`;

    const rRef = await ghlFetch(urlCampos(ref.ghl.locationId), { headers: cabeceras(ref.ghl.apiKey) }, 1, 'ClonarCampos');
    if (rRef.status !== 200) {
      return res.status(502).json({ success: false, error: `No se pudieron leer los campos de ${referenciaId} (HTTP ${rRef.status}).` });
    }
    const camposRef = (await rRef.json()).customFields || [];
    if (camposRef.length === 0) {
      return res.status(502).json({ success: false, error: `${referenciaId} no tiene campos personalizados para clonar.` });
    }

    const resultado = {};
    for (const [sedeId, cfg] of Object.entries(SEDES_GATEWAY)) {
      if (sedeId === referenciaId) continue;
      if (!cfg?.ghl?.locationId || !cfg?.ghl?.apiKey) {
        resultado[sedeId] = { estado: 'SALTADA', motivo: 'sin credenciales en el entorno' };
        continue;
      }

      const rAct = await ghlFetch(urlCampos(cfg.ghl.locationId), { headers: cabeceras(cfg.ghl.apiKey) }, 1, 'ClonarCampos');
      const actuales = rAct.status === 200 ? ((await rAct.json()).customFields || []) : [];
      const yaExiste = new Set(actuales.map(f => String(f.name).trim().toLowerCase()));

      let creados = 0, existentes = 0, fallidos = 0;
      const nuevos = [];
      const errores = [];
      for (const campo of camposRef) {
        const clave = String(campo.name).trim().toLowerCase();
        if (yaExiste.has(clave)) { existentes++; continue; }
        const payload = { name: campo.name, dataType: campo.dataType };
        if (Array.isArray(campo.options) && campo.options.length > 0) payload.options = campo.options;
        try {
          const r = await ghlFetch(urlCampos(cfg.ghl.locationId), {
            method: 'POST', headers: cabeceras(cfg.ghl.apiKey), body: JSON.stringify(payload)
          }, 1, 'ClonarCampos');
          if (r.status === 200 || r.status === 201) { creados++; nuevos.push(campo.name); }
          else {
            fallidos++;
            // Se guarda el motivo real de GHL: sin esto, un fallo persistente es invisible.
            let motivo = `HTTP ${r.status}`;
            try { const d = await r.json(); motivo = d?.message || d?.error || JSON.stringify(d).slice(0, 160); } catch { /* sin cuerpo */ }
            errores.push({ nombre: campo.name, dataType: campo.dataType, motivo });
          }
        } catch (e) { fallidos++; errores.push({ nombre: campo.name, dataType: campo.dataType, motivo: e.message }); }
      }
      resultado[sedeId] = { estado: 'OK', existentes, creados, fallidos, nuevos, errores };
      recordAuditEvent({
        type: 'SEDE_CAMPOS_CLONADOS', severity: 'info', sede: sedeId,
        referencia: referenciaId, creados, existentes, fallidos
      });
    }
    res.json({ success: true, referencia: referenciaId, camposReferencia: camposRef.length, resultado });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/webhook/vtiger', async (req, res) => {
  try {
    // [SANITIZACIÓN OBLIGATORIA] Endpoint semi-público: el payload se sanea por
    // allow-list antes de tocar el cerebro o disparar una sincronización.
    const raw = req.body || {};
    const taint = detectInjectionPatterns(raw);
    if (taint.suspicious) {
      recordAuditEvent({
        type: 'WEBHOOK_TAINT_DETECTED',
        severity: 'warn',
        endpoint: '/webhook/vtiger',
        reasons: taint.reasons,
        sourceIp: req.ip
      });
    }

    const payload = sanitizeObject(raw, {
      allowKeys: [
        'id', 'contactid', 'contact_id', 'firstname', 'lastname', 'email', 'mobile', 'phone',
        'homephone', 'telefono', 'cf_2610', 'cf_3401', 'cf_3472', 'cf_3451', 'condicion',
        'treatment', 'campaign', 'sede', 'locationid', 'location_id', 'ad_id', 'cf_2850'
      ],
      maxDepth: 3
    });

    res.status(200).send({ success: true, message: 'vTiger webhook payload recibido' });

    const condition = sanitizeString(payload.cf_2610 || payload.condicion || payload.treatment, 60);
    if (condition) {
      learningBrain.learnFromVtigerSale({
        treatment: condition,
        chatText: sanitizeString(`${payload.firstname || ''} ${payload.lastname || ''} ${payload.cf_3472 || ''}`, 300),
        campaignName: sanitizeString(payload.cf_3472 || payload.campaign || '', 120)
      });
      stats.vtigerSynced = (stats.vtigerSynced || 0) + 1;
      stats.vtigerStatus = 'Conectado y Aprendiendo';
    }

    // Sincronización instantánea hacia GHL si el webhook trae datos de contacto (Prioridad Nivel 1)
    const phone = sanitizePhone(payload.mobile || payload.phone || payload.homephone || payload.telefono);
    const email = sanitizeEmail(payload.email);
    if (phone || email) {
      setImmediate(async () => {
        try {
          const { runVTigerToGHLPoller } = await import('./agents/vtiger_sync_agent.js');
          await runVTigerToGHLPoller(2);
        } catch (vSyncErr) {
          console.error("[vTiger Webhook Sync Error]:", vSyncErr.message);
        }
      });
    }
  } catch (err) {
    console.error("[vTiger Webhook Error]:", err.message);
  }
});

app.get('/api/vtiger/sync', async (req, res) => {
  try {
    const result = await syncVtigerGroundTruthToBrain(30);
    stats.vtigerSynced = (stats.vtigerSynced || 0) + (result.trainedCount || 0);
    stats.vtigerStatus = result.success ? '[ONLINE] Conectado y Aprendiendo' : '[ERROR] Error de Conexión';
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/brain/metrics', (req, res) => {
  res.json({
    learningBrain: learningBrain.getMetrics(),
    tokenBucket: tokenBucketQueue.getMetrics(),
    curator: getCuratorMetrics(),
    biCurator: getBiCuratorMetrics()
  });
});

app.get('/api/curator/status', (req, res) => {
  res.json({
    success: true,
    biCurator: getBiCuratorMetrics(),
    backgroundCurator: getCuratorMetrics()
  });
});

/**
 * DIAGNOSTICO DE LA CUENTA EMPRESA (la cuenta macro con ~400K contactos).
 *
 * PARA QUE SIRVE: saber que datos tiene realmente la Empresa para BI y postventa
 * (segmentar compradores, enviar SMS a quien compro) sin exponer credenciales y
 * usando el PIT VALIDO de Render. Un muestreo local no sirve porque el .env de
 * desarrollo puede tener un PIT revocado.
 *
 * Solo lectura. Muestrea N contactos (sin recorrer los 400K) y reporta cobertura
 * por campo y por etiqueta.
 *
 * @query muestra {number} contactos a leer (por defecto 300, tope 1000)
 */
app.get('/api/empresa/diagnostico', async (req, res) => {
  if (!isCentralConfigured()) {
    return res.status(503).json({ success: false, error: 'Cuenta Empresa no configurada' });
  }
  const muestra = Math.min(Math.max(parseInt(req.query.muestra || '300', 10) || 300, 20), 1000);
  const headers = {
    'Authorization': `Bearer ${readSecret('GHL_API_KEY_CENTRAL')}`,
    'Version': '2021-07-28',
    'Accept': 'application/json'
  };
  const loc = readSecret('GHL_LOCATION_ID_CENTRAL');

  try {
    // 1) Volumen total
    const rTot = await ghlFetch(`https://services.leadconnectorhq.com/contacts/?locationId=${loc}&limit=1`, { headers }, 1, 'Empresa Diag');
    let total = null;
    if (rTot.status === 200) total = (await rTot.json()).meta?.total ?? null;

    // 2) Campos disponibles, con foco en los que sirven para BI
    const rCampos = await ghlFetch(`https://services.leadconnectorhq.com/locations/${loc}/customFields`, { headers }, 1, 'Empresa Diag');
    const campos = rCampos.status === 200 ? ((await rCampos.json()).customFields || []) : [];
    const relevantes = campos
      .filter(c => /compra|total|fecha|sede|oficina|proveedor|tratamiento|etapa|sexo|origen|historial/i.test(c.name || ''))
      .map(c => ({ nombre: c.name, tipo: c.dataType, id: c.id }));

    // 3) Cobertura real sobre una muestra
    let leidos = 0, conCompras = 0, conFechas = 0, conSede = 0, conOrigen = 0;
    let conTagComprador = 0, conTagNoCompro = 0, conTelefono = 0, sinTelefono = 0;
    let url = `https://services.leadconnectorhq.com/contacts/?locationId=${loc}&limit=100`;
    while (leidos < muestra && url) {
      const r = await ghlFetch(url, { headers }, 1, 'Empresa Diag');
      if (r.status !== 200) break;
      const d = await r.json();
      const lista = d.contacts || [];
      if (!lista.length) break;
      for (const c of lista) {
        if (leidos >= muestra) break;
        leidos++;
        const cf = c.customFields || [];
        const leer = re => cf.find(f => re.test(String(f.id)) && String(f.value ?? '').trim() !== '');
        // Los IDs de campo se resuelven por nombre contra los campos descubiertos
        const idDe = nombre => campos.find(f => String(f.name).toLowerCase() === nombre.toLowerCase())?.id;
        const tiene = nombre => {
          const id = idDe(nombre);
          if (!id) return false;
          const v = cf.find(f => f.id === id)?.value;
          return v !== undefined && v !== null && String(v).trim() !== '';
        };
        if (tiene('Total Compras') || tiene('vTiger Total Compras')) conCompras++;
        if (tiene('Fecha Ultima Compra') || tiene('vTiger Fecha Última Compra') || tiene('vTiger Fecha Ultima Compra')) conFechas++;
        if (tiene('Sede Asignada') || tiene('vTiger Sede / Tienda Compra')) conSede++;
        if (tiene('Origen Lead') || tiene('vTiger Origen Lead')) conOrigen++;
        const tags = (c.tags || []).map(t => String(t).toLowerCase());
        if (tags.includes('compro') || tags.includes('convertido') || tags.includes('cliente-vtiger')) conTagComprador++;
        if (tags.includes('no-compro')) conTagNoCompro++;
        if (String(c.phone || '').trim()) conTelefono++; else sinTelefono++;
      }
      const next = d.meta?.startAfter;
      url = next ? `https://services.leadconnectorhq.com/contacts/?locationId=${loc}&limit=100&startAfter=${next}` : null;
    }

    const pct = n => leidos ? Math.round((n / leidos) * 100) : 0;
    res.json({
      success: true,
      cuenta: 'EMPRESA',
      rol: 'analitica macro (BI / postventa / customer service)',
      contactosTotales: total,
      camposTotales: campos.length,
      camposRelevantes: relevantes,
      muestra: {
        leidos,
        conTelefono: { n: conTelefono, pct: pct(conTelefono) },
        sinTelefono: { n: sinTelefono, pct: pct(sinTelefono) },
        conTotalCompras: { n: conCompras, pct: pct(conCompras) },
        conFechaUltimaCompra: { n: conFechas, pct: pct(conFechas) },
        conSedeAsignada: { n: conSede, pct: pct(conSede) },
        conOrigenLead: { n: conOrigen, pct: pct(conOrigen) },
        tagComprador: { n: conTagComprador, pct: pct(conTagComprador) },
        tagNoCompro: { n: conTagNoCompro, pct: pct(conTagNoCompro) }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * AUDITORÍA DE DUPLICADOS en la Cuenta Empresa (solo lectura).
 * Escanea N páginas (100 contactos cada una) y reporta teléfonos con 2+ contactos.
 * @query paginas {number} páginas a revisar (por defecto 5, tope 50)
 */
app.get('/api/empresa/auditoria', async (req, res) => {
  const paginas = parseInt(req.query.paginas || '5', 10);
  try {
    const r = await auditarDuplicadosEmpresa({ paginas });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DEPURACIÓN DE DUPLICADOS en la Cuenta Empresa.
 * Conserva el contacto más reciente de cada teléfono y elimina el resto.
 * MODO SECO por defecto (ejecutar=false): solo reporta. Para borrar, ejecutar=true.
 * @query paginas {number}
 * @query ejecutar {boolean}
 */
app.post('/api/empresa/depurar', async (req, res) => {
  const paginas = parseInt(req.query.paginas || '5', 10);
  const ejecutar = String(req.query.ejecutar || '').toLowerCase() === 'true';
  try {
    const r = await depurarDuplicadosEmpresa({ paginas, ejecutar });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DEPURACIÓN DE CONTACTOS SIN TELÉFONO en la Cuenta Empresa.
 * Etiqueta como 'basura-sin-telefono' (NO borra) para excluirlos de la medición.
 * MODO SECO por defecto. Para etiquetar, ejecutar=true.
 * @query paginas {number}
 * @query ejecutar {boolean}
 */
app.post('/api/empresa/depurar-sin-telefono', async (req, res) => {
  const paginas = parseInt(req.query.paginas || '5', 10);
  const ejecutar = String(req.query.ejecutar || '').toLowerCase() === 'true';
  try {
    const r = await depurarSinTelefonoEmpresa({ paginas, ejecutar });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DIAGNÓSTICO DE PERSISTENCIA.
 *
 * Confirma sobre QUÉ almacén está montado cada StateStore. Es la verificación
 * definitiva de que el progreso (cursores del backfill, curador, learning brain)
 * sobrevive a un redeploy:
 *   - driver 'postgres' -> durable (Render puede reiniciar sin perder progreso)
 *   - driver 'file'     -> archivo en disco EFÍMERO: se borra en cada redeploy
 *   - driver 'memory'   -> solo en RAM
 *
 * `configuredDriver` es lo que pide el entorno (PERSISTENCE_DRIVER); si dice
 * 'postgres' pero el driver real es 'file', hubo degradación (revisar
 * DATABASE_URL o `degradeReason`).
 */
app.get('/api/state/status', async (req, res) => {
  try {
    const stores = await hydrateAllStores();
    const durables = stores.filter(s => s?.driver === 'postgres').length;
    res.json({
      success: true,
      configuredDriver: STATE_DRIVER_CONFIGURADO,
      storesDurables: durables,
      storesTotales: stores.length,
      persistenciaDurable: durables > 0 && durables === stores.length,
      aviso: STATE_DRIVER_CONFIGURADO === 'postgres'
        ? 'Esperando driver postgres en todos los stores. Si alguno dice file, hubo degradacion.'
        : 'PERSISTENCE_DRIVER no es postgres: el progreso se pierde en cada redeploy.',
      stores
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/curator/run', async (req, res) => {
  const { sede = 'BENAVIDES', mode = 'forward', limit = 20 } = req.body || {};
  try {
    let result;
    if (mode === 'forward') {
      result = await runForwardCure(sede, { limit });
    } else if (mode === 'backward') {
      result = await runBackwardCure(sede, { limit });
    } else {
      const fwd = await runForwardCure(sede, { limit });
      const bwd = await runBackwardCure(sede, { limit });
      result = { forward: fwd, backward: bwd };
    }
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/audit/report', (req, res) => {
  let cleanupState = { msg: "Script de limpieza no ha corrido aún." };
  try {
    const STATE_FILE = path.join(process.cwd(), 'cleanup_state.json');
    if (fs.existsSync(STATE_FILE)) {
      cleanupState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch(e) {}
  
  res.json({
    status: 'Activo',
    radarInactivityMinutes: Math.floor((Date.now() - (global.lastRadarActivity || Date.now())) / 60000),
    massCleanupProgress: cleanupState,
    memoryPointers: {
      radarProcessedLeads: processedContactTimestamps.size,
      vtigerQueue: stats.vtigerQueue
    }
  });
});

// ==========================================
// 4. PROCESADORES DE COLA DURABLE (FEATURE FLAG)
// ==========================================
// Los webhooks y las tareas de sincronización se ejecutan en workers de cola,
// no en el manejador HTTP. Con QUEUE_DRIVER=memory el comportamiento es el
// actual (en proceso); con QUEUE_DRIVER=bullmq los jobs son durables,
// reintentables con backoff exponencial y aislables en una DLQ.
function registerQueueProcessors() {
  const webhooks = getQueue(QUEUES.WEBHOOKS);
  const sync = getQueue(QUEUES.SYNC);
  const curation = getQueue(QUEUES.CURATION);

  // Webhook GHL: ruteo + hidratación del contacto.
  webhooks.registerProcessor(JOBS.GHL_CONTACT_WEBHOOK, async (data) => {
    const { contactId, locationId, sede } = data || {};
    if (!contactId) throw new Error('Job sin contactId');
    const result = await routeChatByContact(contactId, true, false, { locationId, sede });
    if (result === 'RETRY' || result === 'RETRY_INDEXING') {
      // Forzar reintento durable (BullMQ aplica el backoff exponencial).
      throw new Error(`Ruteo diferido para ${contactId} (${result})`);
    }
    return result;
  }, { concurrency: envInt('QUEUE_WEBHOOK_CONCURRENCY', 8) });

  // Reintento de vTiger (Ground Truth): se reprocesa el contacto maestro.
  sync.registerProcessor(JOBS.VTIGER_RETRY, async (data) => {
    const { contactId } = data || {};
    if (!contactId) throw new Error('Job sin contactId');
    const res = await processMasterContact(contactId, { silent: true, isRetry: true });
    if (!res?.success) throw new Error(`Reintento vTiger sin éxito para ${contactId}`);
    return res;
  }, { concurrency: envInt('QUEUE_SYNC_CONCURRENCY', 4) });

  // Curación forward/backward: serializada por sede para evitar solapamientos.
  const runCuration = async (data, job) => {
    const { sede } = data || {};
    if (!sede) throw new Error('Job de curación sin sede');
    if (job?.name === JOBS.CURATION_BACKWARD) return runBackwardCure(sede, { limit: data.limit || 20 });
    return runForwardCure(sede, { limit: data.limit || 15 });
  };
  curation.registerProcessor(JOBS.CURATION_FORWARD, runCuration, { concurrency: 1 });
  curation.registerProcessor(JOBS.CURATION_BACKWARD, runCuration, { concurrency: 1 });

  console.log(`[QUEUE] Procesadores registrados en '${QUEUES.WEBHOOKS}', '${QUEUES.SYNC}', '${QUEUES.CURATION}'.`);
}

// ==========================================
// 5. PROGRAMADORES DE FONDO (SOLO RUNTIME)
// ==========================================
// Se invocan desde src/server.js DESPUÉS del listen. Importar src/app.js en un
// test NO dispara tráfico contra GHL ni vTiger: cero side effects al importar.
export function registerBackgroundSchedulers() {
  const timers = [];

  // Radar de asignación en vivo (Worker 1)
  timers.push(setInterval(runExpressAssignment, 5000));

  // Guardián de bandejas sin asignar (multi-sede)
  timers.push(setInterval(runUnassignedConversationsGuardian, 60000));

  // Demonio inverso: sincroniza cambios de vTiger -> GHL cada 3 minutos
  timers.push(setInterval(() => {
    runVTigerToGHLPoller(4).catch(err => console.error("Error en Reverse Sync:", err));
  }, 180000));

  // Cola de reintentos vTiger (1 vez por minuto)
  timers.push(setInterval(() => {
    stats.vtigerQueue = getVtigerQueueCount();
    processVtigerRetryQueue().catch(err => console.error("Error en vTiger Retry Queue:", err));
  }, 60000));

  // Poda del mapa de contactos procesados (anti memory-leak)
  timers.push(startMemoryGuard());

  // [TICKET 1] Puente de ventas vTiger -> GHL (upsert dual con protección de historial).
  // Cada 10 min busca ventas nuevas en vTiger POR SEDE y las publica en GHL,
  // creando el contacto si no existía. Cierra el hueco por el que una venta de
  // vTiger no aparecía nunca en GHL (el reverse sync sólo actualizaba existentes).
  //
  // [GUARDA DE SOLAPAMIENTO] Si un ciclo tarda más que su intervalo, el
  // `setInterval` dispara otro igual y ambos compiten por la MISMA cola global de
  // GHL: eso multiplica las llamadas y puede provocar un 429 evitable. La guarda
  // descarta el disparo si el anterior sigue vivo, en lugar de acumular ciclos.
  // ==========================================================================
  // [WATCHDOG REUTILIZABLE DE GUARDA]
  //
  // POR QUE EXISTE: los schedulers usan una guarda booleana para no solaparse
  // ("si el ciclo anterior sigue vivo, se omite este disparo"). El problema es que
  // si UNA llamada de red se cuelga (nunca responde), el ciclo no termina, el
  // `.finally()` que libera la guarda NO se ejecuta, y la guarda queda en `true`
  // PARA SIEMPRE: el scheduler se salta todos los disparos siguientes y el trabajo
  // MUERE EN SILENCIO.
  //
  // Caso real: el backfill de compradores estuvo ~30 HORAS sin ejecutarse porque un
  // contacto se colgo. El motor seguia "OK" y el trabajo en vivo fluia, asi que
  // nadie lo noto.
  //
  // Este wrapper pone un TOPE DURO a cada guarda: si el ciclo excede el maximo, se
  // considera trabado, se AUDITA y la guarda se libera. El trabajo se auto-recupera.
  // ==========================================================================
  const crearGuardaConWatchdog = (etiqueta, maxMs) => {
    const estado = { corriendo: false, iniciadoEn: 0 };
    const tipoEvento = `SCHEDULER_WATCHDOG_${etiqueta.toUpperCase().replace(/[^A-Z]/g, '_')}`;
    return {
      /** @returns {boolean} true si se puede arrancar el ciclo */
      tomar() {
        if (!estado.corriendo) {
          estado.corriendo = true;
          estado.iniciadoEn = Date.now();
          return true;
        }
        const transcurrido = Date.now() - estado.iniciadoEn;
        if (transcurrido > maxMs) {
          const min = Math.round(transcurrido / 60000);
          console.warn(`[${etiqueta}] [WATCHDOG] Ciclo trabado ${min} min (tope ${Math.round(maxMs / 60000)} min): se libera la guarda.`);
          recordAuditEvent({ type: tipoEvento, severity: 'warn', scheduler: etiqueta, transcurridoMin: min });
          estado.corriendo = true;
          estado.iniciadoEn = Date.now();
          return true;
        }
        console.warn(`[${etiqueta}] [SKIP] El ciclo anterior sigue en curso: se omite este disparo.`);
        return false;
      },
      liberar() { estado.corriendo = false; }
    };
  };

  // [WATCHDOG] Puente de ventas con guarda protegida. El ciclo normal procesa ~25
  // contactos por sede (~27 min con la concurrencia actual), asi que el tope se fija
  // en 45 min: mas del doble del ciclo normal, para NO disparar falsamente.
  const guardaSalesBridge = crearGuardaConWatchdog('Sales Bridge', 45 * 60 * 1000);
  timers.push(setInterval(() => {
    if (!guardaSalesBridge.tomar()) return;
    runVtigerSalesBridge({ horasAtras: 6, soloCompradores: true, limitePorSede: 25 })
      .catch(err => console.error('[Sales Bridge] Error en ciclo programado:', err.message))
      .finally(() => { guardaSalesBridge.liberar(); });
  }, 10 * 60 * 1000));

  // [TICKET 1] Backfill del DETALLE de órdenes vTiger -> GHL.
  // Avanza lotes cada 15 min hasta completar el historial de todas las sedes.
  // [WATCHDOG] Backfill de detalle de ordenes con guarda protegida. Ciclo normal
  // ~27 min (50 x 2 por sede); tope de 60 min = mas del doble, sin falsos positivos.
  const guardaOrderHistory = crearGuardaConWatchdog('Order Backfill', 60 * 60 * 1000);
  timers.push(setInterval(() => {
    if (!guardaOrderHistory.tomar()) return;
    getBackfillStatus()
      .then(estado => {
        if (estado.completo) return; // nada pendiente
        // [RITMO RECALIBRADO] Antes 25x2 cada 30 min = 100/hora. Ahora 50x2 cada
        // 15 min = 400/hora, para acompanar al backfill de compradores
        // sin saturar: el historial hace ~3 llamadas por contacto.
        return runOrderHistoryBackfill({ tamanoLote: 50, maxLotes: 2, pausaMs: 250 });
      })
      .catch(err => console.error('[Order Backfill] Error en ciclo programado:', err.message))
      .finally(() => { guardaOrderHistory.liberar(); });
  }, 15 * 60 * 1000));

  // [BACKFILL DE COMPRADORES] Cierra la brecha historica de la cartera.
  //
  // [PRIORIDAD: DATOS RECIENTES PRIMERO] El backfill recorre `ORDER BY id DESC`
  // (compradores mas recientes primero), de modo que al entrar a una sede se ven
  // las ventas de ayer y de esta semana de inmediato. El backlog viejo se rellena
  // despues.
  //
  // [ACELERACION NOCTURNA] En madrugada (1-6 AM hora Nueva York, horas muertas) el
  // lote sube de 50x2 a 120x4 por ciclo: ~5x mas rapido mientras no hay atencion
  // en vivo compitiendo por la cuota. De dia se mantiene conservador para no
  // estorbar a los asesores.
  //
  //   - Cuota diaria: 14,400 contactos/dia x 6 = 86,400 llamadas = 43% del limite
  //     de 200,000/dia por location. DEJA MARGEN para la atencion en vivo.
  //   - El Guardian de Cuota (token_bucket_queue) pausa el ciclo si la subcuenta
  //     se acerca a su techo diario.
  //
  // El cursor persiste en StateStore (Postgres): cada ciclo AVANZA, sobrevive a
  // redeploys.
  const esMadrugadaEst = () => {
    const hora = new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/New_York' });
    const h = parseInt(hora, 10);
    return h >= 1 && h < 6; // 1 AM - 6 AM (horas muertas)
  };
  let buyersBackfillCorriendo = false;
  let buyersBackfillIniciadoEn = 0;
  // [WATCHDOG DEL BACKFILL] Tope para un ciclo. Si un ciclo se queda trabado (una
  // llamada que nunca responde), la guarda quedaba en true PARA SIEMPRE y el
  // backfill dejaba de correr en silencio — paso real en produccion: 30 horas sin
  // avanzar aunque el motor seguia vivo.
  //
  // [POR QUE ES ADAPTATIVO Y NO FIJO] Un tope fijo era peligroso: el ciclo normal
  // dura ~50 min de dia y ~45 de madrugada (Palacios procesa el doble por su
  // prioridad), asi que un tope fijo de 45 min habria disparado FALSAMENTE en pleno
  // ciclo, liberando la guarda y arrancando DOS ciclos solapados. Ahora el tope se
  // CALCULA por ciclo a partir del lote y la concurrencia reales, con margen.
  const MARGEN_WATCHDOG = Math.min(Math.max(parseInt(process.env.BACKFILL_MARGEN_WATCHDOG || '2', 10) || 2, 1), 5);
  const SEG_POR_CONTACTO_BASE = Math.min(Math.max(parseInt(process.env.BACKFILL_SEG_POR_CONTACTO || '45', 10) || 45, 5), 300);
  const WATCHDOG_MINIMO_MS = 30 * 60 * 1000;
  let buyersBackfillTopeCicloMs = 90 * 60 * 1000;

  timers.push(setInterval(() => {
    if (buyersBackfillCorriendo) {
      const transcurrido = Date.now() - buyersBackfillIniciadoEn;
      if (transcurrido > buyersBackfillTopeCicloMs) {
        const min = Math.round(transcurrido / 60000);
        console.warn(`[Buyers Backfill] [WATCHDOG] Ciclo trabado ${min} min (tope ${Math.round(buyersBackfillTopeCicloMs / 60000)} min): se libera la guarda.`);
        recordAuditEvent({ type: 'BUYERS_BACKFILL_WATCHDOG', severity: 'warn', transcurridoMin: min, topeMin: Math.round(buyersBackfillTopeCicloMs / 60000) });
        buyersBackfillCorriendo = false;
      } else {
        console.warn('[Buyers Backfill] [SKIP] El ciclo anterior sigue en curso: se omite este disparo.');
        return;
      }
    }
    buyersBackfillCorriendo = true;
    buyersBackfillIniciadoEn = Date.now();

    // ======================================================================
    // [MULTISISTEMATICO, NO "FILA INDIA"]
    //
    // La aceleracion de madrugada ya NO agranda el lote (un lote gigante produce un
    // ciclo larguisimo que ademas entorpece el watchdog): ahora sube la
    // CONCURRENCIA. Mas APIs consultadas EN PARALELO = mas caudal, con ciclos de
    // duracion acotada y predecible.
    //
    // Dia       : lote 50 x 2, 3 contactos en paralelo
    // Madrugada : lote 60 x 3, 6 contactos en paralelo  (~2x caudal)
    // ======================================================================
    const madrugada = esMadrugadaEst();
    const tamano = madrugada ? 60 : 50;
    const lotes = madrugada ? 3 : 2;
    const pausa = madrugada ? 100 : 200;
    const concurrencia = madrugada ? 6 : 3;
    if (madrugada) console.log(`[Buyers Backfill] [MADRUGADA] Multisistematico: lote ${tamano} x ${lotes}, concurrencia ${concurrencia}.`);

    // Tope del watchdog calculado para ESTE ciclo. Palacios lleva el doble de lote
    // por su prioridad, asi que es el que marca la duracion del ciclo.
    const contactosPorSede = tamano * lotes * 2;
    const segPorContactoEfectivo = SEG_POR_CONTACTO_BASE / concurrencia;
    const minutosCiclo = Math.ceil((contactosPorSede * segPorContactoEfectivo) / 60);
    buyersBackfillTopeCicloMs = Math.max(minutosCiclo * MARGEN_WATCHDOG * 60 * 1000, WATCHDOG_MINIMO_MS);

    getBuyersBackfillStatus()
      .then(estado => {
        if (estado.completo) return; // cartera ya recorrida por completo
        return runBuyersBackfill({ tamanoLote: tamano, maxLotes: lotes, pausaMs: pausa, concurrencia });
      })
      .catch(err => console.error('[Buyers Backfill] Error en ciclo programado:', err.message))
      .finally(() => { buyersBackfillCorriendo = false; });
  }, 10 * 60 * 1000));

  // ==========================================================================
  // [DETECTOR DE ESTANCAMIENTO] Que el sistema AVISE, no que lo descubramos.
  //
  // El watchdog libera la guarda, pero si el trabajo se detiene por otra razon
  // (cuota, error persistente, cursor corrupto), el silencio continuaria. Este
  // chequeo compara `ultimaEjecucion` con la hora actual: si el backfill lleva
  // mas de 1 hora sin cerrar un lote, se registra BUYERS_BACKFILL_STALLED (visible
  // en /api/health y /api/audit/log).
  // ==========================================================================
  timers.push(setInterval(() => {
    getBuyersBackfillStatus()
      .then(estado => {
        if (estado.completo) return;
        const ultima = estado.ultimaEjecucion ? new Date(estado.ultimaEjecucion).getTime() : 0;
        if (ultima > 0 && Date.now() - ultima > 60 * 60 * 1000) {
          const min = Math.round((Date.now() - ultima) / 60000);
          console.error(`[Buyers Backfill] [STALLED] Sin cerrar un lote hace ${min} min.`);
          recordAuditEvent({ type: 'BUYERS_BACKFILL_STALLED', severity: 'error', minutosSinEjecutar: min, ultimaEjecucion: estado.ultimaEjecucion });
        }
      })
      .catch(() => { /* el detector nunca debe romper el arranque */ });
  }, 15 * 60 * 1000));

  console.log(`[SCHEDULERS] ${timers.length} ciclos de fondo activos (radar 5s, guardián 60s, reverse-sync 180s, retry 60s, memory-guard 600s, sales-bridge 600s, order-history 900s, buyers-backfill 600s, stall-detector 900s).`);
  return timers;
}


// ==========================================
// EXPORT: la malla HTTP no abre puertos por sí sola.
// El puerto lo abre src/server.js (runtime) o los smoke tests lo omiten.
// ==========================================
export { app, stats, processedContactTimestamps, runExpressAssignment, fetchWithRetry, registerQueueProcessors, startCentralCredentialCheck, startMetaCredentialCheck };
export default app;
