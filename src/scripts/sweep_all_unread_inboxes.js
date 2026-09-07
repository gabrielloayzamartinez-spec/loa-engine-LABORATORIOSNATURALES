import { GHL_CONFIG, PALACIOS_USERS } from '../config/index.js';
import { routeChatByContact } from '../agents/chat_router_agent.js';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Accept': 'application/json'
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      await sleep(1500 * attempt);
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 5) {
      await sleep(1500);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

async function sweepAdvisorUnread(advisorKey, advisor) {
  console.log(`\n=============================================================`);
  console.log(`🧹 BARRIDO MASIVO: ${advisor.name} (ID: ${advisor.id})`);
  console.log(`=============================================================`);

  let processed = 0;
  let hasMore = true;
  let nextPageUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&assignedTo=${advisor.id}&status=unread&limit=50`;

  while (nextPageUrl && hasMore) {
    const res = await fetchWithRetry(nextPageUrl, { headers: HEADERS });
    if (res.status !== 200) {
      console.error(`[Error] Status ${res.status} obteniendo conversaciones`);
      break;
    }

    const data = await res.json();
    const convs = data.conversations || [];
    if (convs.length === 0) {
      console.log(`✅ No hay más conversaciones no leídas para ${advisor.name}.`);
      break;
    }

    console.log(`📦 Procesando lote de ${convs.length} conversaciones no leídas...`);

    // Procesar con concurrencia controlada de 4 para respetar rate-limits
    const CONCURRENCY = 4;
    for (let i = 0; i < convs.length; i += CONCURRENCY) {
      const batch = convs.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (c) => {
        if (!c.contactId) return;
        processed++;
        try {
          await routeChatByContact(c.contactId);
        } catch (err) {
          console.error(`Error procesando contacto ${c.contactId}:`, err.message);
        }
      }));
      await sleep(200);
    }

    // Como muchas conversaciones habrán sido REASIGNADAS a otra persona,
    // al volver a pedir la primera página el conjunto se habrá reducido naturalmente.
    // Volvemos a consultar la primera página de unread para ese asesor.
    await sleep(500);
    const checkRes = await fetchWithRetry(`https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&assignedTo=${advisor.id}&status=unread&limit=1`, { headers: HEADERS });
    if (checkRes.status === 200) {
      const checkData = await checkRes.json();
      const remaining = checkData.total || 0;
      console.log(`📊 Restantes no leídos en ${advisor.name}: ${remaining}`);
      if (remaining === 0) break;
      // Si ya procesamos más que el total inicial, pasamos al siguiente
      if (processed >= 400) break;
    } else {
      break;
    }
  }

  console.log(`🎉 Finalizado barrido de ${advisor.name}. Total auditados/corregidos: ${processed}`);
}

async function main() {
  console.log("🚀 INICIANDO BARRIDO GENERAL DE BANDEJAS NO LEÍDAS (TODAS LAS SEDES)");
  console.log("Objetivo: Depurar sedes cruzadas + Inyectar Ad IDs y Tratamientos en vivo.\n");

  // Orden de prioridad: Empezar por Palacios Ernesto que tiene la mayor carga
  const order = [
    "naturales bionatural", // Palacios Ernesto
    "redes benavides 1",    // Benavides 1
    "redes benavides 2",    // Benavides 2
    "redes roosevelt",      // Roosevelt
    "redes piura",          // Piura
    "bionatural ultra"      // Palacios Ultra
  ];

  for (const key of order) {
    const advisor = PALACIOS_USERS[key];
    if (advisor) {
      await sweepAdvisorUnread(key, advisor);
    }
  }

  console.log("\n=============================================================");
  console.log("🏁 ¡BARRIDO COMPLETO FINALIZADO EN TODAS LAS BANDEJAS!");
  console.log("=============================================================\n");
}

main().catch(err => console.error("Error fatal en barrido:", err));
