import express from 'express';
import fs from 'fs';
import path from 'path';
import { GHL_CONFIG, META_CONFIG, FB_PAGE_ID_MAP, PAGE_TAG_MAP, PALACIOS_USERS } from './config/index.js';
import { processMasterContact } from './agents/master_processor.js';
import { runContinuousAutoAuditCycle, getHealMetrics } from './services/auto_auditor_healer.js';
import { testMetaConnection, excludeLeadFromMetaAds, scanMetaInboxForDuplicates } from './services/meta_api_service.js';
import { routeChatByContact, runChatRouterPoller, runInboxSedeCleaner } from './agents/chat_router_agent.js';
import { processMetaWebhook } from './agents/meta_webhook_agent.js';
import { runSupervisorAuditor, auditorStats } from './agents/auditor_agent.js';
import { setupAllPipelines } from './scripts/pipeline_manager.js';
import { runPreFlightSanityCheck } from './tests/test_audit_engine.js';
import { learningBrain } from './services/learning_brain.js';
import { syncVtigerGroundTruthToBrain } from './services/vtiger_api_service.js';
import { tokenBucketQueue } from './services/token_bucket_queue.js';
import { runBackgroundCuratorCycle, getCuratorMetrics } from './services/background_curator.js';
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

const HEADERS_CONTACTS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    global.apiCounters.ghl++;
    const res = await fetch(url, options);
    if (res.status === 429) {
      await sleep(1500 * attempt);
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < 5) {
      await sleep(1500);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw e;
  }
}

let isFastSyncRunning = false;
let lastSyncTime = null;
let metaConnectionStatus = { isConfigured: Boolean(META_CONFIG.accessToken) };

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

async function runExpressAssignment() {
  if (isFastSyncRunning) return;
  isFastSyncRunning = true;

  try {
    const timeStr = new Date().toLocaleTimeString('es-PE', { hour12: false });
    const url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=15&sortBy=date_updated`;
    const res = await fetchWithRetry(url, { headers: HEADERS_CONTACTS });
    if (res.status !== 200) {
      console.log(`[${timeStr}] [Worker 1] Status API: ${res.status}`);
      return;
    }

    const data = await res.json();
    const contacts = data.contacts || [];
    let countNew = 0;

    for (const contact of contacts) {
      const lastProcTime = processedContactTimestamps.get(contact.id) || 0;
      if (Date.now() - lastProcTime < 5 * 60 * 1000) continue; // 5 min debounce por contacto (evita re-procesamiento y ahorra API calls)

      const updatedAt = new Date(contact.dateUpdated || contact.dateAdded);
      const minutesAgo = (Date.now() - updatedAt.getTime()) / (1000 * 60);
      if (minutesAgo > 30) continue;

      countNew++;
      console.log(`[${timeStr}] [Worker 1] ⚡ Procesando lead fresco: ${contact.firstName || ''} ${contact.lastName || ''} (${contact.id})...`);
      // Disparar enrutamiento e hidratación completa (isLive = true)
      await routeChatByContact(contact.id, true);
      processedContactTimestamps.set(contact.id, Date.now());
      stats.contactsProcessed++;
      
      // Rate-Limit Shield: 500ms estrictos entre contactos
      await sleep(500);
    }

    if (countNew === 0) {
      console.log(`[${timeStr}] [Worker 1] 🟢 Radar en vivo activo. (Sin mensajes nuevos en los últimos 30 min - Esperando tráfico...)`);
    }

    lastSyncTime = new Date().toISOString();
    stats.totalRuns++;
  } catch (err) {
    console.error("[Express Assignment Error]:", err.message);
  } finally {
    isFastSyncRunning = false;
  }
}

// Único ciclo activo continuo: cada 20 segundos para webhooks
setInterval(runExpressAssignment, 20000);

// Demonio Inverso: Sincroniza cambios de vTiger -> GHL cada 3 minutos (180,000 ms)
import { runVTigerToGHLPoller } from './agents/vtiger_sync_agent.js';
setInterval(() => {
  runVTigerToGHLPoller(4).catch(err => console.error("Error en Reverse Sync:", err));
}, 180000);

// NOTA: Pollers concurrentes desactivados para evitar solapamiento de llamadas a la API
// setInterval(runChatRouterPoller, 15000);
// setInterval(runInboxSedeCleaner, 45000);
// setInterval(runSupervisorAuditor, 60000);
  try {
    const url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=20`;
    const res = await fetchWithRetry(url, { headers: HEADERS_CONTACTS });
    if (res.status === 200) {
      const data = await res.json();
      const contacts = data.contacts || [];
      for (const c of contacts) {
        await processMasterContact(c, { silent: true });
        await sleep(500);
      }
    }
  } catch (err) {
    console.error("[Background Audit Error]:", err.message);
  }
}, 90000);
*/

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

            <!-- TABLERO 4: EXTRACCIÓN VTIGER (SPIDER BUFFER) -->
            <div class="card">
              <div class="card-title">Extracción vTiger</div>
              <div class="metric-row">
                <span class="metric-label">Estado del Demonio (Python)</span>
                <span class="metric-value val-blue" id="val-vtigerStatus">${stats.vtigerStatus}</span>
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
    healMetrics: getHealMetrics(),
    auditorStats,
    systemHealth,
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

app.get('/', (req, res) => res.redirect('/health'));

app.post('/webhook/ghl-contact', async (req, res) => {
  try {
    const contactPayload = req.body;
    fs.appendFileSync(path.join(process.cwd(), 'scratch', 'webhook_logs.txt'), JSON.stringify(contactPayload) + '\n');
    let contactData = contactPayload.contact || contactPayload;

    // Si el payload no tiene ID de GHL, debemos crearlo/actualizarlo (Upsert) primero
    if (!contactData.id) {
      
      // FIX AGENTE 1: Si vTiger envía un lead sin teléfono ni correo, GHL lo rechazará (HTTP 400).
      // Le asignaremos un correo ficticio para que el lead se cree y la información sea visible.
      let safeEmail = contactData.email;
      if (!contactData.email && !contactData.phone) {
         const cleanName = (contactData.name || contactData.firstName || 'lead').toLowerCase().replace(/[^a-z0-9]/g, '');
         safeEmail = `${cleanName}-${Date.now()}@vtigermigrated.com`;
      }

      const upsertBody = {
        locationId: locationId,
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
      
      const upsertRes = await fetchWithRetry('https://services.leadconnectorhq.com/contacts/upsert', {
        method: 'POST',
        headers: HEADERS_CONTACTS,
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

    // AGENTE 1: FAST SYNC INMEDIATO (Push-based, sin saturar API)
    // Extraemos UTMs y Ad ID del payload del webhook para inyectarlos en los Custom Fields.
    // Worker 1 / Worker 3: Ingesta Inmediata y Ruteo Inteligente
    setTimeout(async () => {
      try {
        await routeChatByContact(contactData.id);
        if (global.pushLiveLog) global.pushLiveLog(`⚡ Worker 1 Webhook: Ruteado e hidratado ${contactData.id}`);
      } catch (err) {
        console.error("[Worker 1 Webhook Error]:", err.message);
      }
    }, 1000); // Pequeño delay de 1 seg para asegurar que GHL terminó de indexar

    stats.webhooksReceived++;
    res.status(200).send({ success: true, message: 'Webhook payload received and upserted successfully' });

  } catch (error) {
    console.error("[Webhook Error]:", error.message);
  }
});

// ==========================================
// AGENTE 3: ENRUTADOR DE CHATS Y ANTI-VIVAZOS
// ==========================================
app.post('/webhook/chat-router', async (req, res) => {
  try {
    const payload = req.body;
    let contactId = payload.contactId || (payload.contact && payload.contact.id);
    
    if (!contactId) {
      return res.status(400).send({ error: 'Falta contactId en el payload.' });
    }
    
    res.status(200).send({ success: true, message: 'Webhook recibido, enrutando...' });
    
    // Llamar al Agente 3 de forma asíncrona
    await routeChatByContact(contactId);
  } catch (error) {
    console.error("[Agente 3 Webhook Error]:", error.message);
  }
});

// ==========================================
// AGENTE 4: META NATIVO WEBHOOK (Bypass GHL)
// ==========================================
app.get('/webhook/meta', (req, res) => {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'ghl_meta_secure_token_2026';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

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
app.post('/webhook/vtiger', async (req, res) => {
  try {
    const payload = req.body || {};
    res.status(200).send({ success: true, message: 'vTiger webhook payload recibido' });

    const condition = payload.cf_2610 || payload.condicion || payload.treatment;
    if (condition) {
      learningBrain.learnFromVtigerSale({
        treatment: condition,
        chatText: `${payload.firstname || ''} ${payload.lastname || ''} ${payload.cf_3472 || ''}`,
        campaignName: payload.cf_3472 || payload.campaign || ''
      });
      stats.vtigerSynced = (stats.vtigerSynced || 0) + 1;
      stats.vtigerStatus = '🟢 Conectado y Aprendiendo';
    }
  } catch (err) {
    console.error("[vTiger Webhook Error]:", err.message);
  }
});

app.get('/api/vtiger/sync', async (req, res) => {
  try {
    const result = await syncVtigerGroundTruthToBrain(30);
    stats.vtigerSynced = (stats.vtigerSynced || 0) + (result.trainedCount || 0);
    stats.vtigerStatus = result.success ? '🟢 Conectado y Aprendiendo' : '⚠️ Error de Conexión';
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/brain/metrics', (req, res) => {
  res.json({
    learningBrain: learningBrain.getMetrics(),
    tokenBucket: tokenBucketQueue.getMetrics(),
    curator: getCuratorMetrics()
  });
});

const server = app.listen(PORT, '0.0.0.0', async () => {
  // Ejecución obligatoria de pre-flight check antes de admitir tráfico
  const isHealthy = runPreFlightSanityCheck();
  if (!isHealthy) {
    console.error('❌ ERROR FATAL: El motor no superó el Pre-Flight Sanity Check. Deteniendo para evitar datos corruptos.');
    process.exit(1);
  }

  console.log(`\n==========================================================`);
  console.log(`🎯 LOA ENGINE 2.0 (AUTOAPRENDIZAJE + VTIGER + RADAR 24/7)`);
  console.log(`📡 Puerto: ${PORT} | Dashboard: http://localhost:${PORT}/health`);
  console.log(`🛡️ Token Bucket Shield: 1.2s entre curaciones de fondo (0% saturación)`);
  console.log(`🧠 Learning Brain: Memoria activa y feedback loop conectado a vTiger`);
  console.log(`⚡ Radar en Vivo: Escaneando tráfico de hoy cada 20 segundos`);
  console.log(`🌐 Webhooks: /webhook/ghl-contact, /webhook/meta, /webhook/vtiger`);
  console.log(`==========================================================\n`);

  // Sincronización inicial suave de Ground Truth con vTiger CRM
  setTimeout(() => {
    syncVtigerGroundTruthToBrain(20).then(res => {
      if (res && res.success) stats.vtigerStatus = '🟢 Conectado y Aprendiendo';
    }).catch(e => console.log(`[Startup vTiger Sync]: ${e.message}`));
  }, 3000);

  // Demonio de Curación Asíncrona de Fondo (Cada 5 min, en lotes seguros de 20 contactos)
  setInterval(() => {
    runBackgroundCuratorCycle(20).catch(err => console.error('[Background Curator Error]:', err.message));
  }, 5 * 60 * 1000);

  // Calibración Periódica de vTiger (Cada 30 min)
  setInterval(() => {
    syncVtigerGroundTruthToBrain(25).catch(err => console.error('[Periodic vTiger Sync Error]:', err.message));
  }, 30 * 60 * 1000);

  runExpressAssignment();
});
