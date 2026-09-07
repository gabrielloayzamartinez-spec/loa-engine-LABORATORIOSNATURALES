import { GHL_CONFIG } from '../config/index.js';

const { apiKey, locationId } = GHL_CONFIG;
const PIPELINE_ID = 'UuLt1X7copaVFO50wIfU';
const INTAKE_STAGE_ID = 'd53708d8-3f95-486c-9f2f-a1425ce67874';

const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      await sleep(1000 * attempt);
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 5) {
      await sleep(1000);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

async function moveAllRadarOpportunitiesToIntake() {
  console.log("\n============================================================");
  console.log("🚀 TRASLADO MASIVO DE OPORTUNIDADES HACIA LA COLUMNA DE INTAKE");
  console.log(`📌 Pipeline ID: ${PIPELINE_ID}`);
  console.log(`📥 Etapa Destino: 📥 Intake / Base Completa (${INTAKE_STAGE_ID})`);
  console.log("============================================================\n");

  console.log("📥 Obteniendo todas las oportunidades del Radar...");
  const allOpps = [];
  let page = 1;
  let nextUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${PIPELINE_ID}&limit=100`;

  while (nextUrl) {
    const res = await fetchWithRetry(nextUrl, { headers: HEADERS });
    if (res.status !== 200) {
      console.error(`Error buscando oportunidades (Página ${page}): Status ${res.status}`);
      break;
    }
    const data = await res.json();
    const opps = data.opportunities || [];
    allOpps.push(...opps);
    process.stdout.write(`Oportunidades encontradas: ${allOpps.length} (Página ${page})...\r`);
    
    nextUrl = data.meta?.nextPageUrl || null;
    page++;
  }

  console.log(`\n\n📊 Total de oportunidades en el Radar: ${allOpps.length}`);
  const oppsToMove = allOpps.filter(o => o.pipelineStageId !== INTAKE_STAGE_ID);
  console.log(`🔄 Oportunidades por mover a la primera columna (Intake): ${oppsToMove.length}\n`);

  if (oppsToMove.length === 0) {
    console.log("✅ Todas las oportunidades ya están en la columna de Intake.");
    return;
  }

  const BATCH_SIZE = 15;
  let movedCount = 0;
  const startTime = Date.now();

  for (let i = 0; i < oppsToMove.length; i += BATCH_SIZE) {
    const batch = oppsToMove.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (o) => {
      try {
        await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${o.id}`, {
          method: 'PUT',
          headers: HEADERS,
          body: JSON.stringify({
            pipelineStageId: INTAKE_STAGE_ID
          })
        });
        movedCount++;
      } catch (err) {}
    }));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const percent = ((movedCount / oppsToMove.length) * 100).toFixed(1);
    process.stdout.write(`[PROGRESO ${percent}%] ${movedCount}/${oppsToMove.length} movidas a Intake (${elapsed}s)\r`);
    await sleep(200);
  }

  console.log(`\n\n🎉 ¡TRASLADO COMPLETO! ${movedCount} oportunidades movidas a la primera columna "📥 Intake / Base Completa".\n`);
}

moveAllRadarOpportunitiesToIntake();
