import fs from 'fs';
import path from 'path';
import { SEDES_GATEWAY, getGhlHeaders } from '../config/index.js';
import { routeChatByContact } from '../agents/chat_router_agent.js';
import { ghlFetch } from '../utils/ghl_http_client.js';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getCursorPath(sedeName) {
  return path.join(DATA_DIR, `cursor_curador_${sedeName.toLowerCase()}.json`);
}

export function loadCursorState(sedeName) {
  const filePath = getCursorPath(sedeName);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {}
  }
  return {
    nextPageUrl: null,
    totalScanned: 0,
    totalHealed: 0,
    totalCycles: 0,
    isCompleted: false,
    lastRunAt: null
  };
}

export function saveCursorState(sedeName, state) {
  try {
    fs.writeFileSync(getCursorPath(sedeName), JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {}
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let isForwardRunning = { BENAVIDES: false, PALACIOS: false };
let isBackwardRunning = { BENAVIDES: false, PALACIOS: false };

let globalMetrics = {
  forward: {
    BENAVIDES: { cycles: 0, scanned: 0, healed: 0, lastRunAt: null },
    PALACIOS: { cycles: 0, scanned: 0, healed: 0, lastRunAt: null }
  },
  backward: {
    BENAVIDES: { cycles: 0, scanned: 0, healed: 0, lastRunAt: null },
    PALACIOS: { cycles: 0, scanned: 0, healed: 0, lastRunAt: null }
  }
};

/**
 * MODO 1: "DEL AHORA EN ADELANTE" (Forward / En Vivo)
 * Escanea y cura los contactos y chats más recientes en tiempo real para la sede especificada.
 */
export async function runForwardCure(sedeName = 'BENAVIDES', options = {}) {
  const sedeUpper = sedeName.toUpperCase().trim();
  const sedeConfig = SEDES_GATEWAY[sedeUpper];
  if (!sedeConfig) throw new Error(`Sede no válida: ${sedeName}`);
  if (sedeConfig.isPaused) {
    return { status: 'paused', sede: sedeUpper, message: `Subcuenta [${sedeUpper}] pausada preventivamente por rate limit 429 activo en GHL.` };
  }

  if (isForwardRunning[sedeUpper]) {
    return { status: 'busy', message: `Forward cure ya en ejecución para ${sedeUpper}` };
  }

  isForwardRunning[sedeUpper] = true;
  const startTime = Date.now();
  const locId = sedeConfig.ghl.locationId;
  const headers = getGhlHeaders({ locationId: locId });
  const limit = options.limit || 25;

  let scanned = 0;
  let healed = 0;
  let errors = 0;

  try {
    const contactIdsToProcess = new Set();

    // 1. Obtener los contactos modificados más recientemente
    const contactsUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=${limit}&sortBy=date_updated&order=desc`;
    const cRes = await ghlFetch(contactsUrl, { headers }, 1, `Curador-${sedeUpper}`);
    if (cRes.status === 200) {
      const cData = await cRes.json();
      for (const c of (cData.contacts || [])) {
        if (c.id) contactIdsToProcess.add(c.id);
      }
    }

    // 2. Obtener las conversaciones más recientes (DMs / Chats frescos)
    try {
      const convUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${locId}&limit=${limit}`;
      const convRes = await ghlFetch(convUrl, { headers: { ...headers, 'Version': '2021-04-15' } }, 1, `Curador-${sedeUpper}`);
      if (convRes.status === 200) {
        const convData = await convRes.json();
        for (const cv of (convData.conversations || [])) {
          if (cv.contactId) contactIdsToProcess.add(cv.contactId);
        }
      }
    } catch (cvErr) {}

    scanned = contactIdsToProcess.size;

    // 3. Procesar y curar cada contacto fresco con Sede-Lock
    for (const contactId of contactIdsToProcess) {
      try {
        const result = await routeChatByContact(contactId, true, false, {
          locationId: locId,
          sede: sedeUpper
        });
        if (result === 'SUCCESS' || result === 'UNCHANGED' || result === 'RETRY') {
          healed++;
        }
      } catch (err) {
        errors++;
      }
      await sleep(250); // Throttle protector
    }

    // Actualizar métricas
    globalMetrics.forward[sedeUpper].cycles++;
    globalMetrics.forward[sedeUpper].scanned += scanned;
    globalMetrics.forward[sedeUpper].healed += healed;
    globalMetrics.forward[sedeUpper].lastRunAt = new Date().toISOString();

    return {
      success: true,
      sede: sedeUpper,
      mode: 'FORWARD',
      scanned,
      healed,
      errors,
      durationMs: Date.now() - startTime
    };
  } finally {
    isForwardRunning[sedeUpper] = false;
  }
}

/**
 * MODO 2: "DEL AHORA PARA ATRÁS" (Backward / Histórico Profundo)
 * Paginador cursor que recorre la base histórica hacia el pasado para la sede especificada,
 * curando y purgando anomalías sin saturar cuotas de la API.
 */
export async function runBackwardCure(sedeName = 'BENAVIDES', options = {}) {
  const sedeUpper = sedeName.toUpperCase().trim();
  const sedeConfig = SEDES_GATEWAY[sedeUpper];
  if (!sedeConfig) throw new Error(`Sede no válida: ${sedeName}`);
  if (sedeConfig.isPaused) {
    return { status: 'paused', sede: sedeUpper, message: `Subcuenta [${sedeUpper}] pausada preventivamente por rate limit 429 activo en GHL.` };
  }

  if (isBackwardRunning[sedeUpper]) {
    return { status: 'busy', message: `Backward cure ya en ejecución para ${sedeUpper}` };
  }

  isBackwardRunning[sedeUpper] = true;
  const startTime = Date.now();
  const locId = sedeConfig.ghl.locationId;
  const headers = getGhlHeaders({ locationId: locId });
  const batchLimit = options.limit || 20;

  let state = options.resetCursor ? {
    nextPageUrl: null,
    totalScanned: 0,
    totalHealed: 0,
    totalCycles: 0,
    isCompleted: false,
    lastRunAt: null
  } : loadCursorState(sedeUpper);

  if (state.isCompleted && !state.nextPageUrl) {
    state.isCompleted = false;
  }
  let url = state.nextPageUrl || `https://services.leadconnectorhq.com/contacts/?locationId=${locId}&limit=${batchLimit}&sortBy=date_added&order=desc`;

  let scanned = 0;
  let healed = 0;
  let errors = 0;

  try {
    const res = await ghlFetch(url, { headers }, 1, `Curador-${sedeUpper}`);
    if (res.status === 200) {
      const data = await res.json();
      const contacts = data.contacts || [];
      scanned = contacts.length;

      for (const c of contacts) {
        if (!c.id) continue;
        try {
          const result = await routeChatByContact(c.id, true, false, {
            locationId: locId,
            sede: sedeUpper
          });
          if (result === 'SUCCESS' || result === 'UNCHANGED' || result === 'RETRY') {
            healed++;
          }
        } catch (err) {
          errors++;
        }
        await sleep(350); // Throttling seguro para no exceder cuotas de GHL
      }

      // Actualizar cursor
      if (data.meta && data.meta.nextPageUrl) {
        state.nextPageUrl = data.meta.nextPageUrl;
        state.isCompleted = false;
      } else {
        // Se completó el barrido de toda la base
        state.nextPageUrl = null;
        state.isCompleted = true;
      }

      state.totalScanned += scanned;
      state.totalHealed += healed;
      state.totalCycles++;
      state.lastRunAt = new Date().toISOString();
      saveCursorState(sedeUpper, state);

      // Actualizar métricas en memoria
      globalMetrics.backward[sedeUpper].cycles++;
      globalMetrics.backward[sedeUpper].scanned += scanned;
      globalMetrics.backward[sedeUpper].healed += healed;
      globalMetrics.backward[sedeUpper].lastRunAt = state.lastRunAt;

      return {
        success: true,
        sede: sedeUpper,
        mode: 'BACKWARD',
        scanned,
        healed,
        errors,
        hasMore: Boolean(state.nextPageUrl),
        isCompleted: state.isCompleted,
        durationMs: Date.now() - startTime
      };
    } else {
      if (res && res.status === 429) {
        console.warn(`[Curador Bi-Direccional] [RATE-LIMIT] ${sedeUpper} Backward: subcuenta en pausa preventiva por rate limit (Status 429). Reanudara en el proximo turno.`);
        return { success: false, sede: sedeUpper, mode: 'BACKWARD', rateLimited: true };
      }
      throw new Error(`GHL API retornó status ${res ? res.status : 'desconocido'}`);
    }
  } catch (err) {
    console.error(`[Curador Bi-Direccional] [ERROR] en ${sedeUpper} Backward:`, err.message);
    return { success: false, sede: sedeUpper, error: err.message };
  } finally {
    isBackwardRunning[sedeUpper] = false;
  }
}

/**
 * Devuelve el estado actual de métricas y cursores de ambas sedes.
 */
export function getBiCuratorMetrics() {
  return {
    metrics: globalMetrics,
    state: {
      BENAVIDES: loadCursorState('BENAVIDES'),
      PALACIOS: loadCursorState('PALACIOS')
    },
    running: {
      forward: isForwardRunning,
      backward: isBackwardRunning
    }
  };
}
