import { routeChatByContact } from '../agents/chat_router_agent.js';
import { GHL_CONFIG } from '../config/index.js';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let rateLimitBlockedUntil = 0;

async function fetchWithRetry(url, options, attempt = 1) {
  const now = Date.now();
  if (now < rateLimitBlockedUntil) {
    const waitMs = rateLimitBlockedUntil - now;
    await sleep(waitMs);
  }

  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      console.warn(`[Fast Init Shield] ⚠️ GHL retornó 429. Pausando workers por 60s...`);
      rateLimitBlockedUntil = Date.now() + 60000;
      await sleep(60000);
      if (attempt < 4) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 4) {
      await sleep(2000 * attempt);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

async function runFastInit() {
  console.log("\n============================================================");
  console.log("🚀 INICIANDO ACELERADOR MASIVO A PRESIÓN (FAST INIT)");
  console.log("   • Carga máxima sostenida: 5 Peticiones por Segundo");
  console.log("   • Enrutador Autónomo activado por cada contacto");
  console.log("============================================================\n");

  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100`;
  const allContacts = [];

  console.log("📥 Fase 1: Descargando lista completa de contactos...");
  let pageCount = 0;

  while (url) {
    try {
      const res = await fetchWithRetry(url, { headers: HEADERS });
      if (res.status !== 200) {
        console.error("Error descargando contactos, HTTP", res.status);
        break;
      }
      const data = await res.json();
      const contacts = data.contacts || [];
      if (contacts.length === 0) break;

      allContacts.push(...contacts);
      pageCount++;
      process.stdout.write(`\rDescargados: ${allContacts.length} contactos (Página ${pageCount})...`);

      url = data.meta?.nextPageUrl || null;
      await sleep(100); // 10 páginas por segundo máximo
    } catch (e) {
      console.error("\nError obteniendo contactos:", e.message);
      break;
    }
  }

  console.log(`\n\n📊 Total de contactos a procesar: ${allContacts.length}\n`);
  
  if (allContacts.length === 0) return;

  console.log("⚙️ Fase 2: Inyectando presión de inicialización...");
  
  const startTime = Date.now();
  let processed = 0;

  // Trabajaremos con 5 workers en paralelo, y un retraso obligatorio
  // de 200ms por iteración para mantener la velocidad en ~5 res/sec
  const CONCURRENCY = 5;

  for (let i = 0; i < allContacts.length; i += CONCURRENCY) {
    const batch = allContacts.slice(i, i + CONCURRENCY);
    
    await Promise.all(batch.map(async (c) => {
      try {
        // Enrutamiento forzado como proceso "Background" (isLive = false)
        await routeChatByContact(c.id, false);
      } catch (err) {
        console.error(`Error en contacto ${c.id}:`, err.message);
      }
    }));

    processed += batch.length;
    const percent = ((processed / allContacts.length) * 100).toFixed(1);
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
    const remainingSec = ((elapsedSec / processed) * (allContacts.length - processed)).toFixed(0);

    process.stdout.write(`\r[Fast Init] Progreso: ${percent}% (${processed}/${allContacts.length}) | Transcurrido: ${elapsedSec}s | Restante: ~${remainingSec}s`);
    
    // El freno de mano de seguridad para no estallar la API:
    // 5 concurrentes / 1000ms = 5 req por segundo en ruteos.
    await sleep(1000); 
  }

  console.log(`\n\n✅ ACELERADOR MASIVO COMPLETADO. Tiempo total: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutos.`);
}

runFastInit().catch(console.error);
