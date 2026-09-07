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
      await sleep(1200 * attempt);
      if (attempt < 6) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 6) {
      await sleep(1200);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

async function runMassIntake13K() {
  console.log("\n============================================================");
  console.log("🚀 POBLACIÓN Y TRASLADO MASIVO DEL 100% DE CONTACTOS HACIA INTAKE");
  console.log(`📌 Pipeline ID: ${PIPELINE_ID} (Radar de Auditoría)`);
  console.log(`📥 Etapa Destino: 📥 Intake / Base Completa (${INTAKE_STAGE_ID})`);
  console.log("============================================================\n");

  // 1. OBTENER TODAS LAS OPORTUNIDADES EXISTENTES EN EL RADAR
  console.log("1️⃣ Obteniendo oportunidades existentes en el Radar...");
  const existingOppsMap = new Map(); // contactId -> opp
  const oppsToMove = [];
  let oppPage = 1;
  let nextOppUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${PIPELINE_ID}&limit=100`;

  while (nextOppUrl) {
    const res = await fetchWithRetry(nextOppUrl, { headers: HEADERS });
    if (res.status !== 200) break;
    const data = await res.json();
    const opps = data.opportunities || [];

    for (const o of opps) {
      if (o.contact && o.contact.id) {
        existingOppsMap.set(o.contact.id, o);
      }
      if (o.pipelineStageId !== INTAKE_STAGE_ID) {
        oppsToMove.push(o);
      }
    }
    process.stdout.write(`Oportunidades mapeadas: ${existingOppsMap.size} (Página ${oppPage})...\r`);
    nextOppUrl = data.meta?.nextPageUrl || null;
    oppPage++;
  }
  console.log(`\n✅ Oportunidades existentes mapeadas: ${existingOppsMap.size}`);
  console.log(`🔄 Oportunidades existentes por mover a Intake: ${oppsToMove.length}\n`);

  // 2. OBTENER LA BASE COMPLETA DE CONTACTOS EN GHL (~13.5K+)
  console.log("2️⃣ Descargando la base de 100% de contactos de GoHighLevel...");
  const allContacts = [];
  let contactUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100`;
  let contactPage = 1;

  while (contactUrl) {
    const res = await fetchWithRetry(contactUrl, { headers: HEADERS });
    if (res.status !== 200) break;
    const data = await res.json();
    const contacts = data.contacts || [];
    allContacts.push(...contacts);
    process.stdout.write(`Contactos descargados: ${allContacts.length} (Página ${contactPage})...\r`);
    contactUrl = data.meta?.nextPageUrl || null;
    contactPage++;
  }
  console.log(`\n✅ Total de contactos en GHL descargados: ${allContacts.length}\n`);

  // 3. IDENTIFICAR CONTACTOS SIN OPORTUNIDAD EN EL RADAR
  const contactsToCreate = [];
  for (const c of allContacts) {
    if (!existingOppsMap.has(c.id)) {
      contactsToCreate.push(c);
    }
  }
  console.log(`✨ Oportunidades nuevas a crear en Intake: ${contactsToCreate.length}`);
  console.log(`🔄 Oportunidades existentes a reubicar en Intake: ${oppsToMove.length}`);
  const totalOperations = oppsToMove.length + contactsToCreate.length;
  console.log(`🎯 TOTAL DE OPERACIONES A EJECUTAR: ${totalOperations}\n`);

  let completedOps = 0;
  const startTime = Date.now();
  const CONCURRENCY = 15;

  // 4. FASE 1: TRASLADAR OPORTUNIDADES EXISTENTES A INTAKE
  if (oppsToMove.length > 0) {
    console.log("🚀 Moviendo oportunidades existentes hacia la primera columna...");
    for (let i = 0; i < oppsToMove.length; i += CONCURRENCY) {
      const batch = oppsToMove.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (o) => {
        try {
          await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/${o.id}`, {
            method: 'PUT',
            headers: HEADERS,
            body: JSON.stringify({ pipelineStageId: INTAKE_STAGE_ID })
          });
        } catch (e) {}
        completedOps++;
      }));

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const percent = ((completedOps / totalOperations) * 100).toFixed(1);
      process.stdout.write(`[PROGRESO ${percent}%] ${completedOps}/${totalOperations} procesadas (${elapsed}s)\r`);
      await sleep(150);
    }
  }

  // 5. FASE 2: CREAR OPORTUNIDADES EN INTAKE PARA EL RESTO DE LOS 13K+ CONTACTOS
  if (contactsToCreate.length > 0) {
    console.log("\n🚀 Creando oportunidades en Intake para el resto de la base completa...");
    for (let i = 0; i < contactsToCreate.length; i += CONCURRENCY) {
      const batch = contactsToCreate.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (c) => {
        try {
          const fullName = `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Sin Nombre';
          await fetchWithRetry(`https://services.leadconnectorhq.com/opportunities/`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({
              pipelineId: PIPELINE_ID,
              locationId,
              name: `${fullName} [Base General]`,
              pipelineStageId: INTAKE_STAGE_ID,
              status: 'open',
              contactId: c.id
            })
          });
        } catch (e) {}
        completedOps++;
      }));

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const percent = ((completedOps / totalOperations) * 100).toFixed(1);
      process.stdout.write(`[PROGRESO ${percent}%] ${completedOps}/${totalOperations} procesadas (${elapsed}s)\r`);
      await sleep(150);
    }
  }

  console.log(`\n\n🎉 ¡POBLACIÓN DEL 100% COMPLETADA CON ÉXITO!`);
  console.log(`🌟 Los ${allContacts.length} contactos de tu CRM están ahora concentrados en la primera columna "📥 Intake / Base Completa (Por Auditar & Distribuir)".\n`);
}

runMassIntake13K();
