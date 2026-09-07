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
      if (attempt < 6) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 6) {
      await sleep(1000);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

async function forceResetAllToIntake() {
  console.log("\n============================================================");
  console.log("🚨 RESET TOTAL: MOVIENDO TODAS LAS OPORTUNIDADES A INTAKE");
  console.log(`📌 Pipeline ID: ${PIPELINE_ID}`);
  console.log(`📥 Etapa Destino: 📥 Intake / Base Completa (${INTAKE_STAGE_ID})`);
  console.log("============================================================\n");

  console.log("🔍 Escaneando oportunidades que NO estén en Intake...");
  const oppsToMove = [];
  let page = 1;
  let nextUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${PIPELINE_ID}&limit=100`;

  while (nextUrl) {
    const res = await fetchWithRetry(nextUrl, { headers: HEADERS });
    if (res.status !== 200) break;
    const data = await res.json();
    const opps = data.opportunities || [];

    for (const o of opps) {
      if (o.pipelineStageId !== INTAKE_STAGE_ID) {
        oppsToMove.push(o);
      }
    }
    process.stdout.write(`Oportunidades escaneadas: página ${page} (Encontradas fuera de Intake: ${oppsToMove.length})...\r`);
    nextUrl = data.meta?.nextPageUrl || null;
    page++;
  }

  console.log(`\n\n🎯 Oportunidades encontradas fuera de Intake: ${oppsToMove.length}`);

  if (oppsToMove.length === 0) {
    console.log("✅ ¡El 100% de las oportunidades ya están dentro de la columna de Intake!");
    return;
  }

  console.log(`\n🚀 Moviendo las ${oppsToMove.length} oportunidades a la columna de Intake en paralelo...`);
  const CONCURRENCY = 20;
  let movedCount = 0;
  const startTime = Date.now();

  for (let i = 0; i < oppsToMove.length; i += CONCURRENCY) {
    const batch = oppsToMove.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (o) => {
      try {
        await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${o.id}`, {
          method: 'PUT',
          headers: HEADERS,
          body: JSON.stringify({ pipelineStageId: INTAKE_STAGE_ID })
        });
      } catch (err) {}
      movedCount++;
    }));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const percent = ((movedCount / oppsToMove.length) * 100).toFixed(1);
    process.stdout.write(`[PROGRESO ${percent}%] ${movedCount}/${oppsToMove.length} movidas a Intake (${elapsed}s)\r`);
    await sleep(150);
  }

  console.log(`\n\n🎉 ¡COMPLETADO! Las ${movedCount} oportunidades fueron devueltas a la primera columna "📥 Intake / Base Completa".\n`);
}

forceResetAllToIntake();
