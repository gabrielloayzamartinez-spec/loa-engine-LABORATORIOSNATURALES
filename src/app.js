import express from 'express';
import fs from 'fs';
import path from 'path';
import { GHL_CONFIG, META_CONFIG, FB_PAGE_ID_MAP, PAGE_TAG_MAP, PALACIOS_USERS, SEDES_GATEWAY, getGhlHeaders, getActiveSedes } from './config/index.js';
import { ghlFetch, GHL_HEADERS, getRateLimiterStatus, getConsumoPorServicio, getGhlRateState, hayCuotaRealDeFondo, factorDeRitmoDeFondo, getPresupuestoFondo, restaurarPresupuestoFondo, exportarPresupuestoFondo, getRepartoCuota } from './utils/ghl_http_client.js';
import { planDelDia, horaLima, franjaDeHora } from './config/quota_curve.js';
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
import { getVtigerConfigStatus, getVtigerGateMetrics, getVtigerCircuit } from './services/vtigerClient.js';
import { readSecret } from './config/secrets.js';
import { isCentralConfigured } from './services/dual_sync_service.js';
import { verificarCredencialEmpresa } from './services/dual_sync_service.js';
import { auditarDuplicadosEmpresa, depurarDuplicadosEmpresa, depurarSinTelefonoEmpresa } from './services/empresa_data_audit.js';
import { auditarRuteo, auditarRuteoTodasLasSedes } from './services/routing_audit.js';
import { guardianDePropietario } from './services/owner_guardian.js';
import { diagnosticarContacto } from './services/contact_diagnostic.js';
import { auditarPrimerNivel } from './services/first_level_audit.js';
import { auditarCamposComerciales } from './services/commercial_fields_audit.js';
import { refillComercial, getRefillStatus, resetRefill } from './services/commercial_refill.js';
import { getStateStore } from './services/state/state_store.js';
import { procedenciaLeads } from './services/lead_provenance.js';
import { corregirOrigenesUltra, iniciarCorreccionUltraFondo, estadoCorreccionUltra, diagnosticarUtmsUltra } from './services/ultra_origin_corrector.js';

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
    // [TODAS LAS SEDES CON CREDENCIALES, NO SOLO LAS "ACTIVAS"]
    // Antes se verificaba unicamente `getActiveSedes()`, es decir las marcadas
    // `isActive: true`. Roosevelt y Piura tienen `isActive: false` (aun no rutean
    // chats), asi que el health NUNCA revisaba sus tokens: quedaban fuera del
    // informe y parecia que faltaban credenciales aunque estuvieran cargadas.
    //
    // Ahora se verifica toda sede que tenga CUALQUIER credencial cargada, y se
    // informa ademas QUE variables estan presentes (sin exponer sus valores). Asi
    // el health responde de verdad: "¿se subieron las credenciales?".
    const sedes = Object.values(SEDES_GATEWAY)
      .filter(s => s?.meta?.accessToken || s?.ghl?.locationId || s?.ghl?.apiKey)
      .map(s => s.sedeId);
    const porSede = {};
    for (const sede of sedes) {
      const conf = SEDES_GATEWAY[sede] || {};
      porSede[sede] = {
        ...(await verificarCredencialMeta(sede)),
        variablesPresentes: {
          GHL_LOCATION_ID: Boolean(conf.ghl?.locationId),
          GHL_API_KEY: Boolean(conf.ghl?.apiKey),
          META_ACCESS_TOKEN: Boolean(conf.meta?.accessToken),
          META_APP_ID: Boolean(conf.meta?.appId)
        }
      };
    }
    const invalidas = Object.entries(porSede).filter(([, v]) => v.valida === false).map(([k]) => k);
    metaCredentialsStatus = {
      verificado: true,
      ts: new Date().toISOString(),
      todasValidas: invalidas.length === 0,
      invalidas,
      sedesVerificadas: sedes,
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
import { syncVtigerContactDual, resolveCustomFieldIds, CAMPOS_REQUERIDOS, clearFieldCache } from './services/dual_sync_service.js';
import { runVtigerSalesBridge } from './services/vtiger_sales_bridge.js';
import { runOrderHistoryBackfill, getBackfillStatus } from './services/vtiger_order_history_service.js';
import { runBuyersBackfill, getBuyersBackfillStatus, resetBuyersBackfill, resetBuyersBackfillSede, desatascarBackfill, contarContactosGhl, COMPRADORES_POR_SEDE, TOTAL_COMPRADORES } from './services/vtiger_buyers_backfill.js';
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

// ==============================================
// DASHBOARD VISUAL DE PROCEDENCIA (HTML autocontenido)
// ==============================================
const PROCE_PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Procedencia de Leads — LOA Engine</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1420;color:#e6e9ef;margin:0;padding:24px}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:#8b93a7;font-size:13px;margin-bottom:20px}
  .toolbar{display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap}
  select,input,button{background:#1a2130;color:#e6e9ef;border:1px solid #2b3348;border-radius:8px;padding:8px 12px;font-size:14px}
  button{background:#3b82f6;border-color:#3b82f6;cursor:pointer;font-weight:600}
  button:hover{background:#2563eb}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-bottom:20px}
  .card{background:#161c2b;border:1px solid #232c42;border-radius:12px;padding:14px}
  .card b{font-size:22px;display:block}
  .card span{color:#8b93a7;font-size:12px}
  table{width:100%;border-collapse:collapse;background:#161c2b;border-radius:12px;overflow:hidden}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #232c42;font-size:13px}
  th{background:#1a2130;color:#9aa3b5;font-weight:600;position:sticky;top:0}
  tr:hover{background:#1a2130}
  .pill{display:inline-block;background:#1f2b42;border-radius:999px;padding:2px 10px;font-size:11px;color:#a9c1ff}
  .conv{color:#34d399;font-weight:600}
  .low{color:#f87171}
  .muted{color:#8b93a7}
  .loading{color:#8b93a7;padding:20px}
</style>
</head>
<body>
<h1>📊 Procedencia de Leads</h1>
<div class="sub">De qué anuncio/campaña llegó cada lead — y cuántos ya compraron (vista tipo Meta Business Suite)</div>

<div class="toolbar">
  <select id="destino">
    <option value="EMPRESA" selected>Empresa (todas)</option>
    <option value="PALACIOS">Palacios</option>
    <option value="BENAVIDES">Benavides</option>
    <option value="ROOSEVELT">Roosevelt</option>
    <option value="PIURA">Piura</option>
  </select>
  <input id="paginas" type="number" value="50" min="1" max="300" title="Páginas de 100 contactos"/>
  <button onclick="cargar()">Consultar</button>
  <span class="muted" id="estado"></span>
</div>

<div class="cards" id="cards"></div>
<div id="tabla"></div>

<script>
async function cargar(){
  const destino = document.getElementById('destino').value;
  const paginas = document.getElementById('paginas').value;
  const estado = document.getElementById('estado');
  estado.textContent = 'cargando...';
  const t = document.getElementById('tabla');
  t.innerHTML = '<div class="loading">Escaneando contactos y agregando por anuncio…</div>';
  try {
    const r = await fetch('/api/procedencia/leads?destino=' + destino + '&paginas=' + paginas);
    const d = await r.json();
    if (!d.ok) { estado.textContent = 'error: ' + (d.reason || d.error || 'desconocido'); return; }
    estado.textContent = d.escaneados + ' contactos · ' + d.totalAnuncios + ' anuncios · ' + d.sinAnuncio + ' sin anuncio';
    document.getElementById('cards').innerHTML =
      '<div class="card"><b>'+d.escaneados+'</b><span>contactos escaneados</span></div>' +
      '<div class="card"><b>'+d.totalAnuncios+'</b><span>anuncios distintos</span></div>' +
      '<div class="card"><b>'+d.conAnuncio+'</b><span>con anuncio</span></div>' +
      '<div class="card"><b>'+d.sinAnuncio+'</b><span>sin anuncio</span></div>';
    if (!d.filas.length) { t.innerHTML = '<div class="loading">No se encontraron anuncios en este rango.</div>'; return; }
    let html = '<table><thead><tr><th>Anuncio / Campaña</th><th>Campaña</th><th>Leads</th><th>Compraron</th><th>Conversión</th><th>Sedes</th></tr></thead><tbody>';
    for (const f of d.filas) {
      const conv = f.tasaConversion;
      const cls = conv >= 10 ? 'conv' : (f.leads > 20 && conv < 5 ? 'low' : '');
      html += '<tr><td><b>'+esc(f.anuncio)+'</b><br><span class="muted">'+esc(f.adId||'')+'</span></td>' +
        '<td>'+esc(f.campana)+'</td>' +
        '<td>'+f.leads+'</td>' +
        '<td>'+f.compradores+'</td>' +
        '<td class="'+cls+'">'+conv+'%</td>' +
        '<td>'+f.sedes.map(s=>'<span class="pill">'+esc(s)+'</span>').join(' ')+'</td></tr>';
    }
    html += '</tbody></table>';
    t.innerHTML = html;
  } catch(e) {
    estado.textContent = 'error de red: ' + e.message;
  }
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
cargar();
</script>
</body>
</html>`;


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

// ==========================================================================
// [MEMORIA PERSISTENTE DEL RADAR — CORRECCIÓN DEL PICO DE CUOTA EN CADA DEPLOY]
//
// DEFECTO REAL (causa del agotamiento de la cuota de Palacios):
// `processedContactTimestamps` vivía SOLO en memoria. En cada reinicio (y hoy hubo
// muchos, uno por despliegue) el mapa arrancaba VACÍO, así que el radar creía que
// TODOS los contactos de la ventana de 24 h eran nuevos y los reprocesaba otra vez.
// Con 60 contactos por sede × 4 sedes × ~8 llamadas a GHL por contacto, cada
// despliegue disparaba un pico de MILES de llamadas en pocos minutos. Ese pico,
// repetido, consumió las 200,000 peticiones diarias de la subcuenta.
//
// AHORA el mapa se PERSISTE (se carga al arrancar y se guarda cada 10 minutos), así
// que un reinicio NO vuelve a procesar lo ya procesado. Además queda acotado a las
// últimas 48 h y a un máximo de entradas para no crecer sin límite.
// ==========================================================================
const radarMemoriaStore = getStateStore('radar_memoria');
const RADAR_MEMORIA_KEY = 'procesados_v1';
const RADAR_MEMORIA_MAX = 8000;

// [PRESUPUESTO DEL FONDO PERSISTENTE] El tope diario del trabajo de fondo también
// sobrevive a los reinicios: antes el contador vivía en memoria y cada despliegue
// regalaba cuota de nuevo (parte del mismo descontrol que agotó Palacios).
const PRESUPUESTO_KEY = 'presupuesto_fondo_v1';

/** Carga el presupuesto del fondo consumido hoy (se llama al arrancar). */
export async function cargarPresupuestoFondo() {
  try {
    const guardado = await radarMemoriaStore.get(PRESUPUESTO_KEY, null);
    if (guardado) {
      restaurarPresupuestoFondo(guardado);
      const r = getPresupuestoFondo();
      const resumen = Object.entries(r).map(([s, v]) => `${s}:${v.consumidas}`).join(' ');
      console.log(`[Tope Fondo] Presupuesto restaurado (${resumen}).`);
    }
  } catch (err) {
    console.warn(`[Tope Fondo] No se pudo restaurar: ${err.message}`);
  }
}

/** Persiste el presupuesto consumido (para que un reinicio no lo ponga en cero). */
async function persistirPresupuestoFondo() {
  try {
    await radarMemoriaStore.set(PRESUPUESTO_KEY, exportarPresupuestoFondo());
  } catch (err) {
    console.warn(`[Tope Fondo] No se pudo guardar: ${err.message}`);
  }
}

/** Carga la memoria del radar desde el almacén persistente (se llama al arrancar). */
export async function cargarMemoriaRadar() {
  try {
    const guardado = await radarMemoriaStore.get(RADAR_MEMORIA_KEY, null);
    if (guardado && typeof guardado === 'object') {
      const cutoff = Date.now() - (48 * 60 * 60 * 1000);
      let cargados = 0;
      for (const [id, ts] of Object.entries(guardado)) {
        if (Number(ts) >= cutoff) { processedContactTimestamps.set(id, Number(ts)); cargados++; }
      }
      console.log(`[Radar Memoria] Cargados ${cargados} contactos ya procesados: un reinicio NO los vuelve a procesar.`);
    }
  } catch (err) {
    console.warn(`[Radar Memoria] No se pudo cargar: ${err.message}`);
  }
}

/** Guarda la memoria del radar (acotada) para sobrevivir a los reinicios. */
async function persistirMemoriaRadar() {
  try {
    const cutoff = Date.now() - (48 * 60 * 60 * 1000);
    const entradas = [...processedContactTimestamps.entries()]
      .filter(([, ts]) => ts >= cutoff)
      .sort((a, b) => b[1] - a[1])          // las más recientes primero
      .slice(0, RADAR_MEMORIA_MAX);
    await radarMemoriaStore.set(RADAR_MEMORIA_KEY, Object.fromEntries(entradas));
  } catch (err) {
    console.warn(`[Radar Memoria] No se pudo guardar: ${err.message}`);
  }
}

/**
 * [RUNTIME] Poda automática del mapa de contactos procesados.
 * Se registra desde src/server.js (registerBackgroundSchedulers), NO al importar
 * el módulo, para que los smoke tests puedan cargar la app sin side effects.
 */
export function startMemoryGuard() {
  return setInterval(async () => {
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
    // Persistir para que el próximo reinicio NO reprocese (causa del pico de cuota).
    await persistirMemoriaRadar();
    // Persistir el tope del fondo: un reinicio no debe regalar cuota de nuevo.
    await persistirPresupuestoFondo();
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
    // [METRICA DE RETRASO] Se calcula durante el ciclo: la edad (en minutos) del
    // lead mas antiguo atendido. Detecta el sintoma "mensajes de las 10 AM recien
    // asignados por la tarde" ANTES de que se convierta en una queja.
    let retrasoMaxMin = 0;

    await Promise.all(targetLocations.map(async (loc) => {
      if (!loc.id) return;
      // [COBERTURA DEL RADAR] Antes eran 20 contactos por sede, procesados en
      // SERIE. Con vTiger a ~10 s por consulta, un ciclo tardaba ~10 min y la
      // guarda `isFastSyncRunning` bloqueaba los disparos de 5 s: el radar solo
      // alcanzaba ~120 contactos/hora. Si el trafico superaba eso, la cola CRECIA
      // y un lead de las 10 AM podia quedar sin asignar hasta la tarde.
      // Se sube a 60 (GHL admite hasta 100) para drenar el backlog de una pasada.
      const url = `https://services.leadconnectorhq.com/contacts/?locationId=${loc.id}&limit=60&sortBy=date_updated`;
      const res = await fetchWithRetry(url, { headers: loc.headers });
      if (res.status !== 200) {
        console.warn(`[${timeStr}] [Worker 1] Status API (${loc.name}): ${res.status} - Verifica credenciales de subcuenta.`);
        return;
      }

      const data = await res.json();
      const contacts = data.contacts || [];

      // [ORDEN DE ATENCION — DEFECTO CORREGIDO: EL MAS ANTIGUO PRIMERO]
      // GHL devuelve la lista por `date_updated` DESCENDENTE (el mas NUEVO
      // primero). Procesando en ese orden, cada mensaje nuevo ADELANTA a los
      // viejos y los leads de primera hora quedan STARVADOS: es exactamente el
      // sintoma reportado ("mensajes de las 10 AM recien asignados por la tarde").
      //
      // Ahora se ordena asi:
      //   1. SIN PROPIETARIO primero (nadie los esta atendiendo).
      //   2. Dentro de cada grupo, el MAS ANTIGUO primero (FIFO: ningun lead se
      //      queda atras, sin importar cuanto trafico siga entrando).
      contacts.sort((a, b) => {
        const ua = a.isUnassigned ? 0 : 1;
        const ub = b.isUnassigned ? 0 : 1;
        if (ua !== ub) return ua - ub;
        return new Date(a.dateUpdated || a.dateAdded).getTime() - new Date(b.dateUpdated || b.dateAdded).getTime();
      });

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

      // [PARALELISMO ADAPTATIVO DEL RADAR — ESTABILIDAD + LATENCIA MINIMA]
      // Procesar EN SERIE no daba abasto: con vTiger a ~10 s por consulta, 60
      // contactos tomaban ~30 min y la guarda bloqueaba los siguientes disparos
      // (~120 contactos/hora). Pero subir el paralelismo a 3 de forma FIJA tiene
      // un costo: el gate de vTiger tiene 3 slots COMPARTIDOS y el radar podria
      // acapararlos todos, dejando al 2do nivel sin avanzar.
      //
      // Solucion estable para ambos: el radar usa 3 slots SOLO cuando tiene
      // backlog real (el lead mas antiguo que atendio supera el umbral). Si esta
      // al dia, baja a 2 y le deja SIEMPRE un slot de vTiger al backfill. Asi el
      // primer nivel mantiene latencia minima cuando hace falta, sin matar de
      // hambre al segundo.
      const UMBRAL_BACKLOG_MIN = Math.min(Math.max(parseInt(process.env.RADAR_BACKLOG_MIN || '20', 10) || 20, 5), 240);
      const retrasoPrevio = Number(global.radarRetrasoMaxMin) || 0;
      const CONCURRENCIA_RADAR = retrasoPrevio > UMBRAL_BACKLOG_MIN
        ? Math.min(Math.max(parseInt(process.env.RADAR_CONCURRENCY || '3', 10) || 3, 1), 6)   // con backlog: drena rapido
        : Math.min(Math.max(parseInt(process.env.RADAR_CONCURRENCY_RELAX || '2', 10) || 2, 1), 6); // al dia: deja un slot al 2do nivel

      for (let i = 0; i < contacts.length; i += CONCURRENCIA_RADAR) {
        const grupo = contacts.slice(i, i + CONCURRENCIA_RADAR);
        await Promise.all(grupo.map(async (contact) => {
          const updatedAt = new Date(contact.dateUpdated || contact.dateAdded).getTime();
          const lastProcessedUpdate = processedContactTimestamps.get(contact.id) || 0;

          // Si ya procesamos esta actualización exacta saltamos (previene loops).
          // [MOD]: Hemos quitado el check de (!contact.isUnassigned) para que el radar procese leads nuevos obligatoriamente aunque alguien ya se los haya asignado manualmente en GHL.
          if (updatedAt <= lastProcessedUpdate) return;

          const hoursAgo = (Date.now() - updatedAt) / (1000 * 60 * 60);
          // Ampliamos la ventana a 24 horas para que el servidor "recupere" los leads que llegaron mientras Render estaba dormido
          if (hoursAgo > 24) return;

          countNew++;
          const edadMin = Math.round((Date.now() - updatedAt) / 60000);
          if (edadMin > retrasoMaxMin) retrasoMaxMin = edadMin;
          console.log(`[${timeStr}] [Worker 1] [PROCESSING] Lead fresco (${loc.name}, hace ${edadMin} min): ${contact.firstName || ''} ${contact.lastName || ''} (${contact.id})...`);

          try {
            const result = await routeChatByContact(contact.id, true, false, { locationId: loc.id, headers: loc.headers });

            // Si GHL devolvió 500/502 o requiere reintento de indexación, NO guardamos en el mapa para que se reintente en el próximo ciclo
            if (result === 'RETRY' || result === 'RETRY_INDEXING') {
              console.log(`[${timeStr}] [Worker 1] [RETRY] Contacto ${contact.id} marcado para re-proceso en el siguiente ciclo (Status: ${result}).`);
            } else {
              // Guardamos el timestamp exacto de esta actualización para no volver a procesarla hasta que el lead vuelva a hacer algo
              processedContactTimestamps.set(contact.id, updatedAt);
              stats.contactsProcessed++;
            }
          } catch (oneErr) {
            // Un contacto problemático NUNCA debe abortar el lote: se reintentará
            // en el próximo ciclo porque no se registró su timestamp.
            console.warn(`[${timeStr}] [Worker 1] [WARN] Fallo al procesar ${contact.id}: ${oneErr.message}`);
          }
        }));

        // Rate-Limit Shield Aislado: 100ms entre grupos (optimizado para velocidad extrema)
        await sleep(100);
      }
    }));

    if (countNew === 0) {
      console.log(`[${timeStr}] [Worker 1] [RADAR-STANDBY] Radar en vivo activo. (Sin mensajes nuevos en los ultimos 30 min - Esperando trafico...)`);
    }

    lastSyncTime = new Date().toISOString();
    global.lastRadarActivity = Date.now();
    // [METRICA DE RETRASO] Edad del lead mas antiguo que se atendio en este ciclo.
    // Si sube, el radar no da abasto y hay que verlo ANTES de que un lead espere
    // horas por su propietario (sintoma reportado: mensajes de las 10 AM asignados
    // por la tarde). Se expone en /api/health como radar.retrasoMaxMin.
    global.radarRetrasoMaxMin = retrasoMaxMin;
    global.radarUltimoCicloContactos = countNew;
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
    // [RADAR — SALUD DEL PRIMER NIVEL] El retraso del radar es la metrica que
    // detecta un lead esperando por su propietario. Si `retrasoMaxMin` crece
    // (p. ej. > 60), el radar no da abasto con el trafico entrante.
    radar: {
      ultimaActividadTs: global.lastRadarActivity ? new Date(global.lastRadarActivity).toISOString() : null,
      inactividadMin: global.lastRadarActivity ? Math.floor((Date.now() - global.lastRadarActivity) / 60000) : null,
      retrasoMaxMin: global.radarRetrasoMaxMin ?? null,
      contactosUltimoCiclo: global.radarUltimoCicloContactos ?? null
    },
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
    // [CIRCUIT BREAKER vTiger] CLOSED=funcionando, OPEN=pausado (vTiger caido),
    // HALF_OPEN=probando si volvio. El sistema se pausa y reanuda SOLO.
    vtigerCircuit: getVtigerCircuit(),
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
      // 24 h. GHL permite 200,000/dia por location. Dos umbrales:
      //   · GHL_DAILY_QUOTA_GUARD  (150,000, 75%) -> frena el fondo ligero
      //   · GHL_DAILY_QUOTA_PESADO (120,000, 80% del techo) -> frena el trabajo
      //     PESADO (backfill) para preservar la cuota de la atencion en vivo.
      cuotaDiaria: tokenBucketQueue.getCuotaDiaria(),
      // [OBSERVABILIDAD] Ranking de llamadas a GHL por servicio. Antes era
      // imposible saber quien gastaba la cuota: se aceleraron ritmos a ciegas y
      // aparecieron los 429. Con esto se ve de un vistazo antes de tocar nada.
      consumoGhlPorServicio: getConsumoPorServicio(),
      // [CUOTA REAL DE GHL] Leida de los headers autoritativos que GHL devuelve en
      // CADA respuesta (X-RateLimit-Daily-Remaining / X-RateLimit-Remaining). Es la
      // fuente de verdad: nuestro contador propio era una subestimacion porque no
      // veia las llamadas que se saltaban el freno.
      //
      // IMPORTANTE: la cuota diaria de GHL es una VENTANA MÓVIL de 24 h (no hay
      // reset a medianoche); se libera de forma progresiva. Por eso el fondo no se
      // detiene de golpe: se ESPACIA por tramos según `factorRitmoFondo`
      // (1 · 0.5 · 0.25 · 0 = solo trabajo en vivo).
      cuotaRealGhl: Object.fromEntries(
        Object.entries(getGhlRateState()).map(([sede, st]) => [
          sede,
          { ...st, factorRitmoFondo: factorDeRitmoDeFondo(sede) }
        ])
      ),
      // [TOPE DURO DEL FONDO] Presupuesto diario del trabajo de fondo por subcuenta.
      // El resto de la cuota queda RESERVADO a la atención en vivo y el fondo no
      // puede tocarlo, pase lo que pase.
      presupuestoFondo: getPresupuestoFondo(),
      // [REPARTO INTELIGENTE EN 24 HORAS] Qué porcentaje del presupuesto del fondo
      // ya está liberado a esta hora, cuánto puede usar AHORA y en qué franja está.
      // El nivel 1 no se reparte: siempre pasa.
      repartoCuota: {
        hora: horaLima(),
        franja: franjaDeHora(horaLima()),
        porSede: Object.fromEntries(
          ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA', 'EMPRESA'].map(s => [s, getRepartoCuota(s)])
        ),
        planDelDia: planDelDia(120000)
      }
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
    // [SEDES OPCIONAL] Por defecto recorre TODAS las sedes. Con ?sedes=PALACIOS se
    // dedica a una sola (util para forzar el avance de la sede prioritaria sin
    // repartir el ancho de banda entre 4 y sin disparar 4 lotes en paralelo).
    const sedesPedidas = String(req.query.sedes || req.body?.sedes || '')
      .toUpperCase().split(',').map(s => s.trim())
      .filter(s => ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'].includes(s));
    const sedes = sedesPedidas.length ? sedesPedidas : undefined;
    res.json({ success: true, message: `Backfill de compradores iniciado (${lotes} lote(s) de ${lote}${sedes ? ` en ${sedes.join(', ')}` : ''}). Consulta /api/vtiger/buyers-backfill/status.` });
    setImmediate(() => {
      runBuyersBackfill({ tamanoLote: lote, maxLotes: lotes, ...(sedes ? { sedes } : {}) })
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
 * [RESET SELECTIVO] Reinicia el cursor SOLO de las sedes indicadas.
 *
 * Necesario al estrenar una subcuenta: hasta que existieron las credenciales de
 * Roosevelt y Piura, el backfill avanzo su cursor pero solo espejo esos contactos
 * a la Empresa — la subcuenta nueva nacio vacia y el cursor ya habia pasado de
 * largo (por eso tenian 70 y 67 contactos con el cursor en 906 y 602).
 *
 * Reiniciar solo esas sedes evita repetir el trabajo ya hecho en Palacios.
 *
 *   POST /api/vtiger/buyers-backfill/reset-sede?sedes=ROOSEVELT,PIURA
 */
app.post('/api/vtiger/buyers-backfill/reset-sede', async (req, res) => {
  try {
    const pedidas = String(req.query.sedes || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (pedidas.length === 0) {
      return res.status(400).json({ success: false, error: 'Indica ?sedes=ROOSEVELT,PIURA' });
    }
    const reiniciadas = await resetBuyersBackfillSede(pedidas);
    res.json({
      success: true,
      reiniciadas,
      message: `Cursor reiniciado para: ${reiniciadas.join(', ') || '(ninguna)'}. El proximo ciclo las recorre desde los compradores mas recientes.`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * [DESATASCAR BACKFILL] Baja el flag `completo` mal puesto (falso positivo por un
 * lote vacio transitorio de vTiger) SIN reiniciar el cursor. El backfill retoma
 * donde quedo.
 *   POST /api/vtiger/buyers-backfill/desatascar?sedes=PALACIOS
 */
app.post('/api/vtiger/buyers-backfill/desatascar', async (req, res) => {
  try {
    const pedidas = String(req.query.sedes || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (pedidas.length === 0) {
      return res.status(400).json({ success: false, error: 'Indica ?sedes=PALACIOS' });
    }
    const desatascadas = await desatascarBackfill(pedidas);
    res.json({
      success: true,
      desatascadas,
      message: `Flag completo corregido para: ${desatascadas.join(', ') || '(ninguna)'}. El proximo ciclo retoma desde el cursor actual.`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * [REPRENDER EL CARRO] Un solo boton para cuando vTiger se cae por minutos y vuelve:
 *   1. Desatasca cualquier flag "completo" falso.
 *   2. Fuerza UN ciclo inmediato de backfill (sin esperar al scheduler de 10 min).
 *   3. Devuelve el resultado del ciclo y el offset actual de Palacios.
 *
 *   POST /api/vtiger/buyers-backfill/reanudar?sede=PALACIOS
 *   POST /api/vtiger/buyers-backfill/reanudar?sede=TODAS
 */
app.post('/api/vtiger/buyers-backfill/reanudar', async (req, res) => {
  try {
    const sede = String(req.query.sede || '').toUpperCase();
    const objetivo = (sede === '' || sede === 'TODAS' || sede === 'ALL')
      ? ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA']
      : sede.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    // 1) Desatascar flags falsos (un lote vacio transitorio no debe bloquear).
    const desatascadas = await desatascarBackfill(objetivo);
    // 2) Forzar un ciclo inmediato.
    const ciclo = await runBuyersBackfill({ sedes: objetivo, maxLotes: 1 });
    // 3) Estado actual de Palacios.
    const estado = await getBuyersBackfillStatus();
    res.json({
      success: true,
      desatascadas,
      ciclo: {
        contactos: ciclo?.contactos || 0,
        creados: ciclo?.creados || 0,
        actualizados: ciclo?.actualizados || 0,
        descartados: ciclo?.descartados || 0,
        fallidos: ciclo?.fallidos || 0,
        ms: ciclo?.ms || 0
      },
      palacios: { offset: estado.porSede?.PALACIOS?.offset, completo: estado.porSede?.PALACIOS?.completo },
      message: 'Ciclo forzado ejecutado. Revisa "palacios.offset" para confirmar el avance.'
    });
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

// Tipos de campo que GHL NO deja crear sin opciones ("options should not be empty").
const TIPOS_CON_OPCIONES = new Set(['RADIO', 'SINGLE_OPTIONS', 'MULTIPLE_OPTIONS', 'CHECKBOX']);

// Fallback SOLO para campos que el motor realmente usa y cuyo original no tiene
// opciones cargadas. vTiger guarda el sexo como Hombre/Mujer/TERCER (cf_2821 en el
// contacto y cf_862 en la orden), asi que esas son las opciones validas.
const OPCIONES_FALLBACK = {
  sexo: ['Hombre', 'Mujer', 'TERCER']
};

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

      let creados = 0, existentes = 0, fallidos = 0, omitidos = 0;
      const nuevos = [];
      const errores = [];
      const omitidosNombres = [];
      for (const campo of camposRef) {
        const clave = String(campo.name).trim().toLowerCase();
        if (yaExiste.has(clave)) { existentes++; continue; }

        // [CAMPOS QUE GHL EXIGE CON OPCIONES] Los tipos de lista no se pueden crear
        // sin opciones: GHL responde "options should not be empty". En Palacios hay
        // dos asi: 'Sexo' (campo REAL del motor, su original no tiene opciones
        // cargadas) y 'Radio 1c19' (campo basura ajeno al motor).
        //
        //   - Si es un campo del motor -> se crea con las opciones reales de vTiger.
        //   - Si no lo es -> se OMITE (no se cuenta como fallo; no se usa).
        let opciones = Array.isArray(campo.options) ? campo.options.filter(o => String(o ?? '').trim() !== '') : [];
        if (TIPOS_CON_OPCIONES.has(campo.dataType) && opciones.length === 0) {
          const fallback = OPCIONES_FALLBACK[clave];
          if (fallback) opciones = fallback;
          else { omitidos++; omitidosNombres.push(campo.name); continue; }
        }

        const payload = { name: campo.name, dataType: campo.dataType };
        if (opciones.length > 0) payload.options = opciones;
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
      resultado[sedeId] = { estado: 'OK', existentes, creados, fallidos, omitidos, nuevos, omitidosNombres, errores };
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

/**
 * CREA LOS CAMPOS CLAROS DE ATRIBUCIÓN (Nombre del Anuncio / Campaña Meta / Conjunto)
 * en las subcuentas. Los UTM nativos de GHL están BLOQUEADOS (no se renombran), así
 * que estos campos paralelos (TEXT, editables) reciben el mismo dato y se muestran
 * con un nombre claro en la tarjeta de contacto.
 *
 *   POST /api/sedes/crear-campos-atribucion?sede=PALACIOS
 *   POST /api/sedes/crear-campos-atribucion?sede=TODAS
 */
const CAMPOS_ATRIBUCION = [
  { name: 'Nombre del Anuncio', dataType: 'TEXT' },
  { name: 'Campaña Meta', dataType: 'TEXT' },
  { name: 'Conjunto de Anuncios', dataType: 'TEXT' }
];
app.post('/api/sedes/crear-campos-atribucion', async (req, res) => {
  try {
    const sede = String(req.query.sede || 'PALACIOS').toUpperCase();
    const sedesDestino = (sede === 'TODAS' || sede === 'ALL')
      ? ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA', 'EMPRESA']
      : [sede];
    const resultado = {};
    for (const sId of sedesDestino) {
      let loc, key;
      if (sId === 'EMPRESA' || sId === 'CENTRAL') {
        loc = readSecret('GHL_LOCATION_ID_CENTRAL');
        key = readSecret('GHL_API_KEY_CENTRAL');
      } else {
        const cfg = SEDES_GATEWAY[sId];
        loc = cfg?.ghl?.locationId;
        key = cfg?.ghl?.apiKey;
      }
      if (!loc || !key) { resultado[sId] = { estado: 'SIN_CREDENCIALES' }; continue; }
      const cabeceras = { Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };
      const urlCampos = `https://services.leadconnectorhq.com/locations/${loc}/customFields`;
      const rEx = await ghlFetch(urlCampos, { headers: cabeceras }, 1, 'AtribucionCampos');
      const existentes = new Set();
      if (rEx.status === 200) {
        const d = await rEx.json();
        (d.customFields || []).forEach(c => existentes.add(String(c.name).trim().toLowerCase()));
      }
      const creados = [];
      const yaExisten = [];
      for (const campo of CAMPOS_ATRIBUCION) {
        if (existentes.has(campo.name.toLowerCase())) { yaExisten.push(campo.name); continue; }
        const r = await ghlFetch(urlCampos, {
          method: 'POST', headers: cabeceras, body: JSON.stringify(campo)
        }, 1, 'AtribucionCampos');
        if (r.status === 200 || r.status === 201) creados.push(campo.name);
      }
      resultado[sId] = { estado: 'OK', creados, yaExisten };
    }
    res.json({ success: true, campos: CAMPOS_ATRIBUCION.map(c => c.name), resultado });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Normaliza un nombre de campo igual que el motor (sin acentos, sin puntuacion). */
const normalizarCampo = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/^contact\./, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * [COBERTURA DE CAMPOS POR DESTINO] Informa y completa los campos LOGICOS que le
 * faltan a una cuenta, usando la sede de referencia como modelo.
 *
 * Resuelve la necesidad real del negocio: la Cuenta Empresa debe tener los datos
 * COMPLETOS (es el centro de medicion), mientras que una sede solo necesita lo
 * comercial. Aqui se ve exactamente que falta en cada destino y se crea sin
 * duplicar: el match es por ALIAS (como el motor), no por nombre exacto, asi que
 * un campo que ya resuelve por su variante "vTiger ..." NO se duplica.
 *
 *   POST /api/sedes/completar-campos?destino=EMPRESA            (solo informa)
 *   POST /api/sedes/completar-campos?destino=EMPRESA&ejecutar=true
 */
app.post('/api/sedes/completar-campos', async (req, res) => {
  try {
    const destino = String(req.query.destino || 'EMPRESA').toUpperCase();
    const referenciaId = String(req.query.referencia || 'PALACIOS').toUpperCase();
    const ejecutar = String(req.query.ejecutar || '').toLowerCase() === 'true';

    // Credenciales del destino: la Empresa NO vive en SEDES_GATEWAY.
    let destinoLoc = null, destinoKey = null;
    if (destino === 'EMPRESA') {
      destinoLoc = readSecret('GHL_LOCATION_ID_CENTRAL');
      destinoKey = readSecret('GHL_API_KEY_CENTRAL');
    } else {
      const cfg = SEDES_GATEWAY[destino];
      destinoLoc = cfg?.ghl?.locationId;
      destinoKey = cfg?.ghl?.apiKey;
    }
    if (!destinoLoc || !destinoKey) {
      return res.status(400).json({ success: false, error: `Destino ${destino} sin credenciales.` });
    }

    const ref = SEDES_GATEWAY[referenciaId];
    if (!ref?.ghl?.apiKey || !ref?.ghl?.locationId) {
      return res.status(400).json({ success: false, error: `Referencia ${referenciaId} sin credenciales.` });
    }
    const cab = (k) => ({ Authorization: `Bearer ${k}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' });
    const urlCampos = (loc) => `https://services.leadconnectorhq.com/locations/${loc}/customFields`;

    // Campos de la referencia y mapa RESUELTO del destino (mismo criterio del motor).
    const rRef = await ghlFetch(urlCampos(ref.ghl.locationId), { headers: cab(ref.ghl.apiKey) }, 1, 'CompletarCampos');
    const camposRef = rRef.status === 200 ? ((await rRef.json()).customFields || []) : [];
    const mapaDestino = await resolveCustomFieldIds(destinoLoc, cab(destinoKey));
    const resueltos = new Set(Object.keys(mapaDestino || {}).filter(k => k !== '__cacheadoEn'));

    const faltantes = [];
    const creados = [];
    const sinModelo = [];
    for (const [logico, alias] of Object.entries(CAMPOS_REQUERIDOS)) {
      if (resueltos.has(logico)) continue;
      faltantes.push(logico);
      // Se busca en la referencia el campo que corresponde a este logico.
      const modelo = camposRef.find(c => {
        const n = normalizarCampo(c.name);
        return alias.some(a => normalizarCampo(a) === n);
      });
      if (!modelo) { sinModelo.push(logico); continue; }
      if (!ejecutar) continue;

      const opciones = Array.isArray(modelo.options) ? modelo.options.filter(o => String(o ?? '').trim() !== '') : [];
      const payload = { name: modelo.name, dataType: modelo.dataType };
      if (opciones.length > 0) payload.options = opciones;
      else if (TIPOS_CON_OPCIONES.has(modelo.dataType)) {
        const fb = OPCIONES_FALLBACK[normalizarCampo(modelo.name)];
        if (!fb) continue;
        payload.options = fb;
      }
      try {
        const r = await ghlFetch(urlCampos(destinoLoc), { method: 'POST', headers: cab(destinoKey), body: JSON.stringify(payload) }, 1, 'CompletarCampos');
        if (r.status === 200 || r.status === 201) creados.push(modelo.name);
      } catch { /* se reporta por diferencia */ }
    }

    if (creados.length > 0) {
      clearFieldCache();
      recordAuditEvent({ type: 'CAMPOS_COMPLETADOS', severity: 'info', destino, referencia: referenciaId, creados: creados.length, nombres: creados });
    }

    res.json({
      success: true,
      destino,
      referencia: referenciaId,
      ejecutado: ejecutar,
      resueltosAntes: resueltos.size,
      requeridos: Object.keys(CAMPOS_REQUERIDOS).length,
      faltantes,
      sinModeloEnReferencia: sinModelo,
      creados,
      coberturaFinal: resueltos.size + creados.length
    });
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
      const meta = d.meta || {};
      if (meta.nextPageUrl) {
        url = meta.nextPageUrl;
      } else {
        const next = meta.startAfterId ?? meta.startAfter ?? (lista[lista.length - 1]?.id);
        url = next ? `https://services.leadconnectorhq.com/contacts/?locationId=${loc}&limit=100&startAfterId=${next}` : null;
      }
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
  const paginas = parseInt(req.query.paginas || '50', 10);
  const ejecutar = String(req.query.ejecutar || '').toLowerCase() === 'true';
  const borrar = String(req.query.borrar || '').toLowerCase() === 'true';
  if (borrar && ejecutar) {
    return res.status(400).json({ ok: false, error: 'Usa O ejecutar (etiquetar) O borrar (eliminar), no ambos.' });
  }
  try {
    const r = await depurarSinTelefonoEmpresa({ paginas, ejecutar, borrar });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * [TRABAJO DEL DÍA] Medianoche del día en hora Lima (UTC-5, sin horario de verano).
 * Devuelve el timestamp (ms UTC) de las 00:00 de HOY en Lima = 05:00 UTC.
 */
function inicioDiaLima() {
  const ahora = new Date();
  const lima = new Date(ahora.getTime() - (5 * 60 * 60 * 1000));
  return Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate()) + (5 * 60 * 60 * 1000);
}

/**
 * [TRABAJO DEL DÍA] Reprocesa las conversaciones desde `desdeMs` (default: medianoche
 * de hoy en Lima). Aplica los fixes (atribución más reciente, ruteo por página) a los
 * leads que HABLARON hoy, para que el dealer trabaje SIEMPRE con el dato más reciente.
 * Cubre el día completo: de 12 AM a la próxima 12 AM (hora Lima).
 */
/**
 * [TRABAJO DEL DÍA — SINCRONIZACIÓN COMPLETA DEL DÍA]
 * Reprocesa TODOS los contactos con actividad desde `desdeMs` (medianoche Lima),
 * para que los IDs y NOMBRES de campaña / conjunto de anuncios / anuncio, el
 * origen y la "Ultima Interaccion" queden SIEMPRE con el dato del DÍA (hay
 * reingresos constantes por anuncios distintos).
 *
 * DEFECTO CORREGIDO: antes se leía UNA sola página de 100 conversaciones
 * (`conversations/search?limit=100`). En una sede ocupada como Palacios el día
 * supera esa cifra, así que los contactos que no entraban en esa página NUNCA se
 * actualizaban: su "Ultima Interaccion" quedaba en el día anterior aunque
 * hubieran escrito hoy.
 *
 * AHORA:
 *   1. Se recorren los CONTACTOS ordenados por `date_updated` descendente,
 *      paginando con `meta.nextPageUrl` (el cursor fiable de GHL).
 *   2. Se corta en cuanto aparece un contacto MÁS ANTIGUO que la ventana: como el
 *      orden es descendente, el resto ya no pertenece al día.
 *   3. Se recuerda qué versión (`dateUpdated`) de cada contacto ya se procesó, así
 *      el ciclo de 10 min NO repite trabajo innecesario ni satura vTiger.
 */
const procesadosDelDia = new Map(); // contactId -> dateUpdated ya procesado
let diaProcesadosClave = null;

async function reprocesarConversacionesDesde(desdeMs) {
  const targetLocations = getActiveSedes().filter(s => !s.isPaused).map(s => ({
    id: s.ghl.locationId,
    headers: getGhlHeaders({ locationId: s.ghl.locationId }),
    name: s.name
  }));

  // Al cambiar de día (clave = fecha Lima), se limpia la memoria de procesados.
  const claveDia = new Date(desdeMs).toISOString().slice(0, 10);
  if (diaProcesadosClave !== claveDia) {
    procesadosDelDia.clear();
    diaProcesadosClave = claveDia;
  }

  const resultado = [];
  let totalContactos = 0;
  let totalProcesados = 0;

  for (const loc of targetLocations) {
    if (!loc.id) continue;
    try {
      let url = `https://services.leadconnectorhq.com/contacts/?locationId=${loc.id}&limit=100&sortBy=date_updated`;
      let paginas = 0;
      let procesados = 0;
      let delDia = 0;
      let finDeVentana = false;

      // Tope de seguridad: 15 páginas = 1,500 contactos con actividad por sede.
      while (url && paginas < 15 && !finDeVentana) {
        paginas++;
        const res = await fetchWithRetry(url, { headers: loc.headers });
        if (res.status !== 200) break;
        const d = await res.json();
        const contactos = d.contacts || [];
        if (contactos.length === 0) break;

        for (const c of contactos) {
          const t = new Date(c.dateUpdated || c.dateAdded).getTime();
          // Orden descendente: al primer contacto fuera de la ventana, el resto
          // tampoco es del día.
          if (!t || t < desdeMs) { finDeVentana = true; break; }

          delDia++;
          // Ya se procesó EXACTAMENTE esta versión del contacto: no se repite.
          if ((procesadosDelDia.get(c.id) || 0) >= t) continue;

          try {
            const r = await routeChatByContact(c.id, true, false, { locationId: loc.id, headers: loc.headers });
            if (r !== 'RETRY' && r !== 'RETRY_INDEXING') {
              procesados++;
              procesadosDelDia.set(c.id, t);
            }
          } catch { /* un contacto no aborta el lote */ }
          await sleep(120);
        }

        url = finDeVentana ? null : (d?.meta?.nextPageUrl || null);
      }

      totalContactos += delDia;
      totalProcesados += procesados;
      resultado.push({ sede: loc.name, contactosDelDia: delDia, procesados, paginas });
    } catch (e) {
      resultado.push({ sede: loc.name, error: e.message });
    }
  }

  return { totalConversaciones: totalContactos, totalContactos, totalProcesados, resultado };
}

/**
 * [TRABAJO DEL DÍA] Endpoint manual. Por defecto cubre desde medianoche de hoy (Lima)
 * hasta ahora. `?horas=N` lo convierte en ventana rodante de N horas si se prefiere.
 *   POST /api/leads/reprocesar-24h          (día completo en hora Lima)
 *   POST /api/leads/reprocesar-24h?horas=6  (solo últimas 6 horas)
 */
app.post('/api/leads/reprocesar-24h', async (req, res) => {
  try {
    const horas = parseInt(req.query.horas || '', 10);
    const desde = (horas > 0) ? Date.now() - horas * 3600 * 1000 : inicioDiaLima();
    const r = await reprocesarConversacionesDesde(desde);
    res.json({
      success: true,
      desde: new Date(desde).toISOString(),
      desdeLima: new Date(desde - 5 * 3600 * 1000).toISOString().slice(11, 16) + ' Lima',
      ...r
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * [CORRECTOR DE ORIGENES — ULTRA] Re-resuelve el origen de los contactos de la
 * fanpage "BioNatural - Ultra" con los accesos nuevos de Meta.
 *
 * POR QUE: Ultra no estaba vinculada al System User, asi que el Ad ID de sus
 * anuncios no se podia traducir a campana/conjunto/anuncio. Sus contactos
 * (historicos y recientes) quedaron con el origen erroneo o vacio.
 *
 * SEGURIDAD: DRY-RUN por defecto. Solo escribe si `ejecutar=true`.
 *
 *   TANDA CHICA (sincrono, respuesta inmediata):
 *     POST /api/ultra/corregir-origenes?sede=PALACIOS&paginas=10                       (simula)
 *     POST /api/ultra/corregir-origenes?sede=PALACIOS&paginas=10&limite=50&ejecutar=true
 *
 *   CARTERA COMPLETA (segundo plano, no bloquea el request):
 *     POST /api/ultra/corregir-origenes?sede=PALACIOS&paginas=200&fondo=true
 *     GET  /api/ultra/corregir-origenes/estado
 */
app.post('/api/ultra/corregir-origenes', async (req, res) => {
  try {
    const sede = String(req.query.sede || 'PALACIOS').toUpperCase();
    const paginas = parseInt(req.query.paginas || '10', 10);
    const ejecutar = String(req.query.ejecutar || '').toLowerCase() === 'true';
    const fondo = String(req.query.fondo || '').toLowerCase() === 'true';
    const limite = parseInt(req.query.limite || '50', 10);

    // [MODO FONDO] Un barrido completo (miles de contactos) no cabe en un request
    // HTTP: se lanza en segundo plano y el avance se consulta en /estado.
    if (fondo) {
      const r = iniciarCorreccionUltraFondo({ sede, paginas });
      return res.json(r);
    }

    const r = await corregirOrigenesUltra({ sede, paginas, ejecutar, limite });
    res.json(r);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** [ESTADO] Avance del barrido de Ultra en segundo plano. */
app.get('/api/ultra/corregir-origenes/estado', (req, res) => {
  res.json(estadoCorreccionUltra());
});

/**
 * [DIAGNOSTICO DE UTMs — ULTRA] Muestra, SOLO LECTURA, qué origen se puede
 * extraer de un contacto de Ultra: el referral del mensaje (ad_id, la vía real
 * de Messenger) y/o la atribucion de GHL (utmSource/Medium/Campaign/Content/Term).
 *
 *   GET /api/ultra/diagnostico-utms?sede=PALACIOS&paginas=20&muestra=5
 */
app.get('/api/ultra/diagnostico-utms', async (req, res) => {
  try {
    const sede = String(req.query.sede || 'PALACIOS').toUpperCase();
    const paginas = parseInt(req.query.paginas || '20', 10);
    const muestra = parseInt(req.query.muestra || '5', 10);
    const r = await diagnosticarUtmsUltra({ sede, paginas, muestra });
    res.json(r);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * [EL OJO DEL DEALER] Audita que el propietario asignado corresponda a la fanpage
 * por la que escribio el lead.
 *
 * Regla de negocio:
 *   "BioNatural - Ultra"    ->  SIEMPRE CLICK2RING
 *   "Naturales BioNatural"  ->  SIEMPRE ERNESTO
 *
 * El router deja el slug de la fanpage como etiqueta, asi que esta auditoria es
 * INDEPENDIENTE del router: compara etiqueta vs propietario real y reporta los
 * desajustes. Solo lectura.
 *
 *   GET /api/routing/auditoria?sede=PALACIOS&paginas=50
 */
app.get('/api/routing/auditoria', async (req, res) => {
  try {
    const sede = String(req.query.sede || 'PALACIOS').toUpperCase();
    const paginas = parseInt(req.query.paginas || '50', 10);
    // sede=TODAS audita las 4 subcuentas en un solo llamado.
    const r = (sede === 'TODAS' || sede === 'ALL')
      ? await auditarRuteoTodasLasSedes({ paginas })
      : await auditarRuteo({ sede, paginas });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * [RE-LLENADO COMERCIAL — SEGUNDA PASADA CORRECTIVA]
 * El historial comercial (nº de compras, Fecha Última Compra, monto, Sexo) solo
 * viajaba cuando el contacto NO existía en GHL. Como el lead ENTRA primero y
 * DESPUÉS aparece como comprador en vTiger, esos compradores quedaron congelados
 * como "No Comprador" sin fecha ni monto. El defecto ya está corregido, pero el
 * cursor del backfill SOLO AVANZA: los que quedaron atrás no se reprocesan nunca.
 * Estos endpoints hacen la SEGUNDA PASADA para rellenarlos.
 *
 *   POST /api/auditoria/refill-comercial?sede=PALACIOS&lote=50&lotes=2[&ejecutar=true]
 *   GET  /api/auditoria/refill-status
 *   POST /api/auditoria/refill-reset?sede=PALACIOS   (reinicia el cursor)
 */
app.post('/api/auditoria/refill-comercial', async (req, res) => {
  try {
    const sede = String(req.query.sede || 'PALACIOS').toUpperCase();
    const lote = parseInt(req.query.lote || '50', 10);
    const lotes = parseInt(req.query.lotes || '1', 10);
    const ejecutar = String(req.query.ejecutar || 'false').toLowerCase() === 'true';
    const r = await refillComercial({ sede, lote, lotes, ejecutar });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/auditoria/refill-status', async (req, res) => {
  try {
    res.json({ ok: true, estado: await getRefillStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/auditoria/refill-reset', async (req, res) => {
  try {
    const sede = req.query.sede ? String(req.query.sede).toUpperCase() : null;
    res.json(await resetRefill(sede));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * [AUDITORÍA DE CAMPOS COMERCIALES — vTiger ↔ GHL]
 * Responde la pregunta correcta ante un campo vacío en GHL:
 * "¿está vacío TAMBIÉN en vTiger?".
 *   · vTiger vacío  -> el dato no existe en el origen (no es fallo del motor).
 *   · vTiger lleno y GHL vacío -> HUECO NUESTRO, accionable.
 *
 * SOLO LECTURA.
 *   GET /api/auditoria/campos-comerciales?sede=PALACIOS&muestra=40
 */
app.get('/api/auditoria/campos-comerciales', async (req, res) => {
  try {
    const sede = String(req.query.sede || 'PALACIOS').toUpperCase();
    const muestra = parseInt(req.query.muestra || '40', 10);
    const r = await auditarCamposComerciales({ sede, muestra });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * [AUDITORÍA DE PRIMER NIVEL — DE ESQUINA A ESQUINA]
 * Verifica contacto por contacto las 7 dimensiones del primer nivel y devuelve
 * la cobertura de cada una + los huecos concretos + un veredicto de salud.
 *
 *   1. Propietario   2. Regla de página   3. Ad ID   4. Campaña/Anuncio
 *   5. UTM           6. Ultima Interaccion   7. Dato del día
 *
 * SOLO LECTURA.
 *   GET /api/auditoria/primer-nivel?sede=PALACIOS&paginas=10[&soloRecientes=false]
 */
app.get('/api/auditoria/primer-nivel', async (req, res) => {
  try {
    const sede = String(req.query.sede || 'PALACIOS').toUpperCase();
    const paginas = parseInt(req.query.paginas || '10', 10);
    const soloRecientes = String(req.query.soloRecientes || 'true').toLowerCase() !== 'false';
    const r = await auditarPrimerNivel({ sede, paginas, soloRecientes });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * [DIAGNÓSTICO DE ATRIBUCIÓN DE UN CONTACTO]
 * Responde "¿por qué este lead de pauta quedó como orgánico?". Muestra TODAS las
 * fuentes que consulta el motor (campos del contacto, atribución de GHL y el
 * referral de los mensajes) y dice de dónde DEBERÍA haber salido el Ad ID.
 *
 * SOLO LECTURA.
 *   GET /api/contacto/diagnostico?contactId=<id>&sede=PALACIOS[&crudos=true]
 */
app.get('/api/contacto/diagnostico', async (req, res) => {
  try {
    const contactId = String(req.query.contactId || '').trim();
    const sede = String(req.query.sede || 'PALACIOS').toUpperCase();
    const crudos = String(req.query.crudos || '').toLowerCase() === 'true';
    if (!contactId) return res.status(400).json({ ok: false, reason: 'falta ?contactId=' });
    const r = await diagnosticarContacto({ contactId, sede, crudos });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * [GUARDIÁN DE PROPIETARIO] Corrige los contactos que TIENEN etiqueta de fanpage
 * pero quedaron SIN propietario. El auditor AVISA de la anomalía; este la CORRIGE
 * aplicando la regla estricta de cada página (p.ej. Palacios:
 * "Naturales BioNatural" -> REDES 1 ERNESTO; "BioNatural - Ultra" y
 * "Laboratorios Naturales BIO" -> REDES 2 CLICK2RING).
 *
 * DRY-RUN por defecto: solo escribe con `ejecutar=true`.
 *   POST /api/routing/guardian-propietario?sede=PALACIOS&paginas=10            (simula)
 *   POST /api/routing/guardian-propietario?sede=PALACIOS&paginas=10&ejecutar=true
 */
app.post('/api/routing/guardian-propietario', async (req, res) => {
  try {
    const sede = String(req.query.sede || 'PALACIOS').toUpperCase();
    const paginas = parseInt(req.query.paginas || '10', 10);
    const ejecutar = String(req.query.ejecutar || '').toLowerCase() === 'true';
    const r = await guardianDePropietario({ sede, paginas, ejecutar });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PROCEDENCIA DE LEADS (JSON) — agregador por anuncio/campaña.
 * GET /api/procedencia/leads?destino=EMPRESA&paginas=50
 */
app.get('/api/procedencia/leads', async (req, res) => {
  try {
    const destino = String(req.query.destino || 'EMPRESA').toUpperCase();
    const paginas = parseInt(req.query.paginas || '30', 10);
    res.json(await procedenciaLeads({ destino, paginas }));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * LISTA DE CAMPOS PERSONALIZADOS DE UNA SUBACCOUNT (para auditar la tarjeta de contacto).
 * Muestra nombre, tipo y key de cada campo para detectar campos bloqueados/nativos,
 * duplicados o basura. Solo lectura.
 *   GET /api/sedes/campos?sede=PALACIOS
 */
app.get('/api/sedes/campos', async (req, res) => {
  try {
    const sede = String(req.query.sede || 'PALACIOS').toUpperCase();
    let loc, key;
    if (sede === 'EMPRESA' || sede === 'CENTRAL') {
      loc = readSecret('GHL_LOCATION_ID_CENTRAL');
      key = readSecret('GHL_API_KEY_CENTRAL');
    } else {
      const cfg = SEDES_GATEWAY[sede];
      loc = cfg?.ghl?.locationId;
      key = cfg?.ghl?.apiKey;
    }
    if (!loc || !key) return res.status(400).json({ ok: false, error: `Sede ${sede} sin credenciales` });
    const headers = { Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json' };
    const r = await ghlFetch(`https://services.leadconnectorhq.com/locations/${loc}/customFields`, { headers }, 1, 'ListarCampos');
    if (r.status !== 200) return res.status(r.status).json({ ok: false, error: `GHL HTTP ${r.status}` });
    const d = await r.json();
    const campos = (d.customFields || []).map(c => ({
      nombre: c.name || '(sin nombre)',
      tipo: c.dataType || c.fieldType || c.type || '',
      key: c.fieldKey || '',
      id: c.id || '',
      placeholder: c.placeholder || ''
    })).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
    res.json({ ok: true, sede, total: campos.length, campos });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DASHBOARD VISUAL DE PROCEDENCIA — la vista "tipo Meta Business Suite".
 * GET /procedencia
 */
app.get('/procedencia', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(PROCE_PAGE);
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

  // [TRABAJO DEL DÍA] Cada 10 min reprocesa las conversaciones desde medianoche (Lima)
  // hasta ahora, para que los UTMs/IDs/orígenes del día estén SIEMPRE actualizados.
  // Cubre de 12 AM a la próxima 12 AM (hora Lima), sin tocar la base histórica.
  timers.push(setInterval(() => {
    reprocesarConversacionesDesde(inicioDiaLima())
      .then(r => {
        if (r.totalConversaciones > 0) {
          console.log(`[TRABAJO-DIA] Reprocesadas ${r.totalConversaciones} conversaciones de hoy (${r.totalProcesados} contactos actualizados).`);
        }
      })
      .catch(err => console.error("Error en reprocesar-dia:", err));
  }, 10 * 60 * 1000));

  // Guardián de bandejas sin asignar (multi-sede)
  timers.push(setInterval(runUnassignedConversationsGuardian, 60000));

  // [GUARDIÁN DE PROPIETARIO — CORRIGE LOS HUÉRFANOS]
  // El router solo asigna cuando el lead escribe. Un contacto migrado o sin chat
  // reciente podia quedar SIN dueño aunque su etiqueta de fanpage fuera correcta
  // (defecto reportado: 71 contactos de "Naturales BioNatural" sin propietario).
  // Este guardián recorre las sedes y asigna el dueño que dicta la REGLA ESTRICTA,
  // tocando únicamente contactos con fanpage CONOCIDA y sin propietario: nunca
  // reasigna a alguien que ya tiene dueño (cero robos de cartera).
  timers.push(setInterval(() => {
    const guardianSede = (sedeId) => guardianDePropietario({ sede: sedeId, paginas: 5, ejecutar: true })
      .then(r => {
        if (r.corregidos > 0) {
          console.log(`[Guardián Propietario] ${sedeId}: ${r.corregidos} contactos huerfanos asignados a su dueño (revisados ${r.escaneados}).`);
        }
      })
      .catch(err => console.warn(`[Guardián Propietario] ${sedeId}: ${err.message}`));
    // Una sede por disparo, rotando, para no concentrar la carga en una sola.
    const activas = getActiveSedes().filter(s => !s.isPaused).map(s => s.sedeId);
    activas.forEach((s, i) => setTimeout(() => guardianSede(s), i * 8000));
  }, 30 * 60 * 1000));

  // Demonio inverso: sincroniza cambios de vTiger -> GHL cada 3 minutos
  timers.push(setInterval(() => {
    runVTigerToGHLPoller(4).catch(err => console.error("Error en Reverse Sync:", err));
  }, 180000));

  // [RE-LLENADO COMERCIAL — SEGUNDA PASADA CORRECTIVA]
  // El historial comercial solo viajaba cuando el contacto NO existia en GHL, asi
  // que los compradores que entraron primero como LEAD quedaron congelados como
  // "No Comprador", sin Fecha Ultima Compra ni monto. El defecto ya esta corregido,
  // pero el cursor del backfill solo AVANZA: esos contactos no se reprocesan solos.
  // Esta pasada los RELLENA. Va en lotes pequeños cada 20 minutos y el propio
  // servicio se detiene si la cuota real no da margen para la atencion en vivo.
  timers.push(setInterval(() => {
    const sedesActivas = getActiveSedes().filter(s => !s.isPaused).map(s => s.sedeId);
    if (sedesActivas.length === 0) return;
    // Prioridad Palacios (la regla de negocio), luego el resto.
    const orden = ['PALACIOS', 'BENAVIDES', 'ROOSEVELT', 'PIURA'].filter(s => sedesActivas.includes(s));
    const sedeDelTurno = orden[0] || sedesActivas[0];
    refillComercial({ sede: sedeDelTurno, lote: 40, lotes: 1, ejecutar: true })
      .then(r => {
        if (r?.rellenados > 0) {
          console.log(`[Re-llenado Comercial] ${sedeDelTurno}: ${r.rellenados} compradores rellenados (cursor ${r.cursor?.offset}).`);
        }
      })
      .catch(err => console.warn(`[Re-llenado Comercial] ${sedeDelTurno}: ${err.message}`));
  }, 20 * 60 * 1000));

  // Cola de reintentos vTiger (1 vez por minuto)
  timers.push(setInterval(() => {
    stats.vtigerQueue = getVtigerQueueCount();
    processVtigerRetryQueue().catch(err => console.error("Error en vTiger Retry Queue:", err));
  }, 60000));

  // Poda del mapa de contactos procesados (anti memory-leak)
  timers.push(startMemoryGuard());

  // [MEMORIA DEL RADAR] Cargar ANTES de que el radar haga su primer ciclo. Sin
  // esto, un reinicio reprocesa toda la ventana de 24 h y dispara un pico de
  // miles de llamadas (fue la causa del agotamiento de la cuota de Palacios).
  cargarMemoriaRadar().catch(err => console.warn(`[Radar Memoria] ${err.message}`));
  // [TOPE DEL FONDO] Restaurar lo ya consumido hoy por el trabajo de fondo.
  cargarPresupuestoFondo().catch(err => console.warn(`[Tope Fondo] ${err.message}`));

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
  // [PERFIL HORARIO DEL BACKFILL — CUIDA VTIGER EN LAS MAÑANAS]
  // vTiger es un servidor COMPARTIDO con los asesores y su uso se concentra en la
  // MAÑANA. El backfill debe ser MAS CONSERVADOR justo en esas horas para no
  // competir con la atencion en vivo (que es la prioridad), y aprovechar la
  // madrugada y la noche —cuando casi nadie lo usa— para avanzar mas rapido.
  //
  //   MADRUGADA (01-06)  -> agresivo    : lote 60 x 3, 6 en paralelo, pausa 100ms
  //   PICO MAÑANA (06-13)-> conservador : lote 25 x 2, 2 en paralelo, pausa 400ms
  //   TARDE (13-20)      -> medio       : lote 40 x 2, 3 en paralelo, pausa 250ms
  //   NOCHE (20-01)      -> medio-alto  : lote 50 x 2, 4 en paralelo, pausa 150ms
  //
  // Se usa America/Lima (la zona del negocio) y NO una zona con horario de verano:
  // antes se calculaba con America/New_York, que cambia de offset y desplazaba la
  // ventana de madrugada en varios meses del año.
  const perfilDelDia = () => {
    const h = parseInt(
      new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/Lima' }),
      10
    );
    if (h >= 1 && h < 6) return { nombre: 'MADRUGADA', tamano: 60, lotes: 3, pausa: 100, concurrencia: 6 };
    if (h >= 6 && h < 13) return { nombre: 'PICO-MANANA', tamano: 25, lotes: 2, pausa: 400, concurrencia: 2 };
    if (h >= 13 && h < 20) return { nombre: 'TARDE', tamano: 40, lotes: 2, pausa: 250, concurrencia: 3 };
    return { nombre: 'NOCHE', tamano: 50, lotes: 2, pausa: 150, concurrencia: 4 };
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
    // [PERFIL DEL DIA] Cada franja horaria tiene su propio ritmo. La MAÑANA es la
    // mas conservadora porque es cuando los asesores usan mas vTiger: el backfill
    // cede para no competir con la atencion en vivo.
    const perfil = perfilDelDia();
    const tamano = perfil.tamano;
    const lotes = perfil.lotes;
    const pausa = perfil.pausa;
    const concurrencia = perfil.concurrencia;
    console.log(`[Buyers Backfill] [PERFIL ${perfil.nombre}] lote ${tamano} x ${lotes}, concurrencia ${concurrencia}, pausa ${pausa}ms.`);

    // Tope del watchdog calculado para ESTE ciclo. Palacios lleva el doble de lote
    // por su prioridad, asi que es el que marca la duracion del ciclo.
    const contactosPorSede = tamano * lotes * 2;
    const segPorContactoEfectivo = SEG_POR_CONTACTO_BASE / concurrencia;
    const minutosCiclo = Math.ceil((contactosPorSede * segPorContactoEfectivo) / 60);
    buyersBackfillTopeCicloMs = Math.max(minutosCiclo * MARGEN_WATCHDOG * 60 * 1000, WATCHDOG_MINIMO_MS);

    getBuyersBackfillStatus()
      .then(estado => {
        if (estado.completo) return; // cartera ya recorrida por completo

        // ======================================================================
        // [PRIORIDAD ABSOLUTA PALACIOS]
        // El negocio pide terminar PALACIOS primero con TODO el ancho de banda y
        // luego ir agregando las demas. Hasta que Palacios no complete su cartera,
        // el ciclo se dedica ENTERO a Palacios: las otras sedes quedan en pausa
        // (su cursor se conserva, no se pierde nada).
        //
        // Ventaja real: el gate de vTiger (3 concurrentes) y la cola de GHL dejan
        // de repartirse entre 4 sedes y se concentran en Palacios. Con una sola
        // sede, la concurrencia del backfill se DOBLA (tope 8), lo que acorta su
        // tiempo a la mitad o menos.
        // ======================================================================
        const palaciosCompleto = estado.porSede?.PALACIOS?.completo === true;

        // [CUOTA REAL — NO DESPERDICIAR EL CICLO]
        // DEFECTO CORREGIDO: cuando Palacios agotaba su cuota diaria de GHL, el
        // ciclo se pausaba ENTERO y el 2do nivel quedaba detenido horas, aunque
        // BENAVIDES / ROOSEVELT / PIURA tuvieran cupo disponible. Ahora se consulta
        // la cuota REAL (headers de GHL) y, si Palacios no puede trabajar, el ciclo
        // AVANZA con las demas sedes. La prioridad se mantiene intacta: en cuanto
        // Palacios recupera cupo, vuelve a ser el unico destino del ciclo.
        const palaciosConCupo = tokenBucketQueue.hayCupoPesado('PALACIOS') && hayCuotaRealDeFondo('PALACIOS');
        const otrasSedes = ['BENAVIDES', 'ROOSEVELT', 'PIURA'];
        const sedesDelCiclo = palaciosCompleto
          ? otrasSedes                             // Palacios ya termino su cartera
          : (palaciosConCupo ? ['PALACIOS'] : otrasSedes); // Palacios primero; si no tiene cupo, las demas
        const usandoFallback = !palaciosCompleto && !palaciosConCupo;
        const concurrenciaFinal = (!palaciosCompleto && palaciosConCupo)
          ? Math.min(concurrencia * 2, 8)
          : concurrencia;

        if (palaciosConCupo && !palaciosCompleto) {
          console.log(`[Buyers Backfill] [PALACIOS-PRIORITARIO] Ciclo dedicado a Palacios (concurrencia ${concurrenciaFinal}).`);
        } else if (usandoFallback) {
          console.log(`[Buyers Backfill] [CUOTA-REAL] Palacios sin cupo en GHL: el ciclo avanza con ${otrasSedes.join(', ')} en lugar de quedarse detenido.`);
          recordAuditEvent({
            type: 'BUYERS_BACKFILL_FALLBACK_SEDES',
            severity: 'info',
            sedes: otrasSedes,
            reason: 'Palacios sin cuota real disponible en GHL: se aprovecha el ciclo con las demas sedes'
          });
        }

        return runBuyersBackfill({ tamanoLote: tamano, maxLotes: lotes, pausaMs: pausa, concurrencia: concurrenciaFinal, sedes: sedesDelCiclo });
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
