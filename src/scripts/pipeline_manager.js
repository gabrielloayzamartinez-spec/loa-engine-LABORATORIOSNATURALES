import { GHL_CONFIG, MASTER_PIPELINE_DEF, AUDIT_PIPELINE_DEF, UNIFIED_PIPELINE_DEF } from '../config/index.js';
import fs from 'fs';
import path from 'path';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

const PIPELINES_CACHE_FILE = path.join(process.cwd(), 'src', 'config', 'pipelines_cache.json');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      await sleep(2000 * attempt);
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < 5) {
      await sleep(2000);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw e;
  }
}

async function fetchPipelines() {
  const res = await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`, {
    headers: HEADERS
  });
  if (res.status === 200) {
    const data = await res.json();
    return data.pipelines || [];
  }
  return [];
}

export async function getOrCreateMasterPipeline(existingPipelines = null) {
  console.log("\n🔍 Verificando existencia del Pipeline Maestro (Ventas)...");
  const pipelines = existingPipelines || await fetchPipelines();
  const found = pipelines.find(p => p.name.includes("Pipeline Maestro") || p.name === MASTER_PIPELINE_DEF.name);

  if (found) {
    console.log(`✅ Pipeline Maestro detectado: "${found.name}" (ID: ${found.id})`);
    return formatMasterPipelineResult(found);
  }

  console.log(`🚀 Creando "${MASTER_PIPELINE_DEF.name}" con ${MASTER_PIPELINE_DEF.stages.length} etapas...`);
  try {
    const payload = {
      name: MASTER_PIPELINE_DEF.name,
      locationId: locationId,
      stages: MASTER_PIPELINE_DEF.stages
    };
    const createRes = await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/pipelines`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(payload)
    });
    const createData = await createRes.json();
    const created = createData.pipeline || createData;
    console.log(`🎉 ¡PIPELINE MAESTRO CREADO CON ÉXITO! (ID: ${created.id})`);
    return formatMasterPipelineResult(created);
  } catch (err) {
    console.error("❌ Error creando Pipeline Maestro:", err.message);
    throw err;
  }
}

export async function getOrCreateAuditPipeline(existingPipelines = null) {
  console.log("\n🔍 Verificando existencia del Pipeline de Auditoría Multi-Touch...");
  const pipelines = existingPipelines || await fetchPipelines();
  const found = pipelines.find(p => p.name.includes("Radar de Pauta") || p.name.includes("Auditoría Multi-Touch") || p.name === AUDIT_PIPELINE_DEF.name);

  if (found) {
    console.log(`✅ Pipeline de Auditoría detectado: "${found.name}" (ID: ${found.id})`);
    return formatAuditPipelineResult(found);
  }

  console.log(`🚀 Creando "${AUDIT_PIPELINE_DEF.name}" con ${AUDIT_PIPELINE_DEF.stages.length} etapas...`);
  try {
    const payload = {
      name: AUDIT_PIPELINE_DEF.name,
      locationId: locationId,
      stages: AUDIT_PIPELINE_DEF.stages
    };
    const createRes = await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/pipelines`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(payload)
    });
    const createData = await createRes.json();
    const created = createData.pipeline || createData;
    console.log(`🎉 ¡PIPELINE DE AUDITORÍA CREADO CON ÉXITO! (ID: ${created.id})`);
    return formatAuditPipelineResult(created);
  } catch (err) {
    console.error("❌ Error creando Pipeline de Auditoría:", err.message);
    throw err;
  }
}

function formatMasterPipelineResult(pipeline) {
  const stages = pipeline.stages || [];
  const precalificadoStage = stages.find(s => s.name.toLowerCase().includes("precalificado") || s.name.toLowerCase().includes("sin teléfono")) || stages[0];
  const calificadoStage = stages.find(s => s.name.toLowerCase().includes("calificado") && !s.name.toLowerCase().includes("precalificado")) || stages[1];

  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    stages: stages,
    stagePrecalificadoId: precalificadoStage?.id,
    stageCalificadoId: calificadoStage?.id
  };
}

function formatAuditPipelineResult(pipeline) {
  const stages = pipeline.stages || [];
  
  const stageIntake = stages.find(s => s.name.toLowerCase().includes("intake") || s.name.toLowerCase().includes("base completa")) || stages[0];
  const stageX1 = stages.find(s => s.name.includes("1er Clic") || s.name.includes("X1")) || stages[1];
  const stageX2 = stages.find(s => s.name.includes("2do Clic") || s.name.includes("X2")) || stages[2];
  const stageX3 = stages.find(s => s.name.includes("3er Clic") || s.name.includes("X3")) || stages[3];
  const stageX4 = stages.find(s => s.name.includes("4to Clic") || s.name.includes("X4")) || stages[4];

  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    stages: stages,
    stageIntakeId: stageIntake?.id,
    stageX1Id: stageX1?.id,
    stageX2Id: stageX2?.id,
    stageX3Id: stageX3?.id,
    stageX4Id: stageX4?.id
  };
}

export async function getOrCreateUnifiedPipeline(existingPipelines = null) {
  console.log("\n🔍 Verificando existencia del Pipeline Unificado...");
  const pipelines = existingPipelines || await fetchPipelines();
  
  const found = pipelines.find(p => p.name === UNIFIED_PIPELINE_DEF.name);
  if (found) {
    console.log(`✅ Pipeline Unificado detectado: "${found.name}" (ID: ${found.id})`);
    return formatUnifiedPipelineResult(found);
  }

  console.log(`🚀 Creando "${UNIFIED_PIPELINE_DEF.name}" con ${UNIFIED_PIPELINE_DEF.stages.length} etapas...`);
  try {
    const payload = {
      name: UNIFIED_PIPELINE_DEF.name,
      locationId: locationId,
      stages: UNIFIED_PIPELINE_DEF.stages
    };
    const createRes = await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/pipelines`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(payload)
    });
    const createData = await createRes.json();
    const created = createData.pipeline || createData;
    console.log(`🎉 ¡PIPELINE "${created.name}" CREADO CON ÉXITO! (ID: ${created.id})`);
    return formatUnifiedPipelineResult(created);
  } catch (err) {
    console.error(`❌ Error creando Pipeline Unificado:`, err.message);
    throw err;
  }
}

function formatUnifiedPipelineResult(pipeline) {
  const stages = pipeline.stages || [];
  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    stages: stages,
    stageProspectoInicialId: stages.find(s => s.name.includes("Prospecto Inicial"))?.id,
    stageContactoCapturadoId: stages.find(s => s.name.includes("Contacto Capturado"))?.id,
    stageSeguimientoId: stages.find(s => s.name.includes("Seguimiento"))?.id,
    stageGanadoId: stages.find(s => s.name.includes("Ganado"))?.id,
    stagePerdidoId: stages.find(s => s.name.includes("Perdido"))?.id
  };
}

export async function setupAllPipelines() {
  const allExisting = await fetchPipelines();
  const master = await getOrCreateMasterPipeline(allExisting);
  const audit = await getOrCreateAuditPipeline(allExisting);
  const unified = await getOrCreateUnifiedPipeline(allExisting);

  const cacheData = {
    master,
    audit,
    unified,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(PIPELINES_CACHE_FILE, JSON.stringify(cacheData, null, 2));
  console.log(`\n💾 Pipelines guardados y cacheados en: ${PIPELINES_CACHE_FILE}`);
  return cacheData;
}

if (process.argv[1] && process.argv[1].endsWith('pipeline_manager.js')) {
  setupAllPipelines();
}
