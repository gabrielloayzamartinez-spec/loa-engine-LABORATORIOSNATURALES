import { GHL_CONFIG, MASTER_PIPELINE_DEF } from './config.js';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getOrCreateMasterPipeline() {
  console.log("\n🔍 Verificando existencia del Pipeline Maestro en GoHighLevel...");
  
  // 1. Consultar pipelines existentes
  let existingPipelines = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`, {
        headers: HEADERS
      });
      const data = await res.json();
      existingPipelines = data.pipelines || [];
      break;
    } catch (e) {
      console.log(`⏳ Reintentando consulta de pipelines (${attempt}/3)...`);
      await sleep(1000);
    }
  }

  // Buscar si ya existe por nombre
  const found = existingPipelines.find(p => p.name.includes("Pipeline Maestro") || p.name === MASTER_PIPELINE_DEF.name);

  if (found) {
    console.log(`✅ Pipeline Maestro detectado: "${found.name}" (ID: ${found.id})`);
    return formatPipelineResult(found);
  }

  // 2. Si no existe, crearlo
  console.log(`🚀 Creando "${MASTER_PIPELINE_DEF.name}" con ${MASTER_PIPELINE_DEF.stages.length} etapas...`);
  
  try {
    const payload = {
      name: MASTER_PIPELINE_DEF.name,
      locationId: locationId,
      stages: MASTER_PIPELINE_DEF.stages
    };

    const createRes = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(payload)
    });

    const createData = await createRes.json();
    const createdPipeline = createData.pipeline || createData;

    console.log(`🎉 ¡PIPELINE MAESTRO CREADO CON ÉXITO! (ID: ${createdPipeline.id})`);
    return formatPipelineResult(createdPipeline);

  } catch (err) {
    console.error("❌ Error creando el Pipeline:", err.message);
    throw err;
  }
}

function formatPipelineResult(pipeline) {
  const stages = pipeline.stages || [];
  
  const precalificadoStage = stages.find(s => s.name.toLowerCase().includes("precalificado") || s.name.toLowerCase().includes("sin teléfono")) || stages[0];
  const calificadoStage = stages.find(s => s.name.toLowerCase().includes("calificado") || s.name.toLowerCase().includes("con teléfono")) || stages[1];

  console.log("\n📌 ETAPAS CLAVE CONFIGURADAS:");
  console.log(`  1. 💬 Precalificado (Sin Teléfono) -> Stage ID: ${precalificadoStage?.id} ("${precalificadoStage?.name}")`);
  console.log(`  2. 📞 Calificado   (Con Teléfono) -> Stage ID: ${calificadoStage?.id} ("${calificadoStage?.name}")`);

  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    stages: stages,
    stagePrecalificadoId: precalificadoStage?.id,
    stageCalificadoId: calificadoStage?.id
  };
}

if (process.argv[1].endsWith('pipeline_manager.js')) {
  getOrCreateMasterPipeline();
}
