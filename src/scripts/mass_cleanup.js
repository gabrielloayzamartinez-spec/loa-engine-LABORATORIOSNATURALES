import fs from 'fs';
import path from 'path';
import { GHL_CONFIG } from '../config/index.js';
import { processMasterContact } from '../agents/master_processor.js';

const { apiKey, locationId } = GHL_CONFIG;
const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Accept': 'application/json'
};

const STATE_FILE = path.join(process.cwd(), 'cleanup_state.json');

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
  return { nextCursor: null, totalScanned: 0, totalCleaned: 0 };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function runMassCleanup() {
  console.log("🧹 Iniciando Limpieza Masiva (Modo Pausado Seguro)...");
  
  let state = loadState();
  let keepRunning = true;

  while (keepRunning) {
    try {
      let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=50`;
      if (state.nextCursor) {
        url += `&startAfterId=${state.nextCursor}`;
        // En algunas versiones de la API, GHL usa next_page_url o last_id
      }

      console.log(`[Cleanup] Consultando 50 contactos... (Scanned: ${state.totalScanned})`);
      const res = await fetch(url, { headers: HEADERS });
      
      if (res.status === 429) {
        console.warn("[Cleanup] Rate limit GHL. Pausando 30 segundos...");
        await sleep(30000);
        continue;
      }
      
      if (!res.ok) {
        console.error(`[Cleanup] Error API GHL: ${res.status}`);
        break;
      }

      const data = await res.json();
      const contacts = data.contacts || [];

      if (contacts.length === 0) {
        console.log("🎉 Limpieza Masiva Terminada! No hay más contactos.");
        break;
      }

      for (const contact of contacts) {
        // Ejecutamos limpieza a fuego lento, 1 por 1, 1.5s entre cada uno
        console.log(`  Limpiando ${contact.firstName} ${contact.lastName} (${contact.id})...`);
        await processMasterContact(contact, { silent: true, historicalSweep: true });
        
        state.totalScanned++;
        state.totalCleaned++;
        state.lastProcessedId = contact.id;
        
        // Guardamos el estado cada iteración para ser resilientes
        saveState(state);
        await sleep(1500); // Protección anti-baneo
      }

      // Dependiendo de la estructura de respuesta de GHL, obtenemos la paginación
      if (data.meta && data.meta.nextPageUrl) {
        // Extraemos param next_page si es posible, o usamos el último ID
        state.nextCursor = contacts[contacts.length - 1].id;
      } else {
        console.log("No se devolvió meta paginación. Asumiendo fin del conjunto.");
        break;
      }

      saveState(state);
      
    } catch (err) {
      console.error("[Cleanup] Error fatal en el batch:", err.message);
      keepRunning = false;
    }
  }
}

// Permitir ejecución directa
if (import.meta.url === `file://${process.argv[1]}`) {
  runMassCleanup();
}
