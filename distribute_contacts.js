import { GHL_CONFIG } from './config.js';

const { apiKey, locationId } = GHL_CONFIG;

const PIPELINE_ID = 'yDWAU0AGW3QiivEz4VJg';
const STAGE_PRECALIFICADO_ID = '29293e88-d26e-4095-bde9-d40aa0cf1024'; // Sin Teléfono
const STAGE_CALIFICADO_ID = '5e7d5fb0-0a71-46df-aa42-912fe0b487f1';   // Con Teléfono

const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      await sleep(250 * Math.pow(2, attempt));
      if (attempt < 3) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < 3) {
      await sleep(500);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw e;
  }
}

export async function runDistributeContacts() {
  console.log("\n=================================================");
  console.log("🎯 DISTRIBUCIÓN MASIVA AL PIPELINE MAESTRO");
  console.log("Regla: Sin Teléfono -> Precalificado | Con Teléfono -> Calificado");
  console.log("=================================================\n");

  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100`;
  const allContacts = [];

  console.log("📥 Consultando todos los contactos del CRM...");
  while (url) {
    const res = await fetchWithRetry(url, { headers: HEADERS });
    const data = await res.json();
    const contacts = data.contacts || [];
    if (contacts.length === 0) break;

    for (const c of contacts) {
      const hasPhone = Boolean(c.phone && c.phone.trim().length > 0);
      const tags = (c.tags || []).map(t => t.toLowerCase());
      
      // Detectar etiqueta de página para el título
      let pageLabel = 'General';
      if (tags.includes('naturales bionatural')) pageLabel = 'BioNatural';
      else if (tags.includes('bionatural ultra')) pageLabel = 'Ultra';
      else if (tags.includes('naturales bio corp')) pageLabel = 'Bio Corp';
      else if (tags.includes('bio natural')) pageLabel = 'Bio Natural';
      else if (tags.includes('bio naturales')) pageLabel = 'Bio Naturales';
      else if (tags.includes('laboratorios naturales bio')) pageLabel = 'Laboratorios';

      allContacts.push({
        id: c.id,
        name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Sin Nombre',
        phone: c.phone || null,
        hasPhone,
        pageLabel,
        assignedTo: c.assignedTo || null
      });
    }

    url = data.meta?.nextPageUrl || null;
  }

  console.log(`\n📊 Total contactos a inyectar en el Pipeline: ${allContacts.length}\n`);

  const CONCURRENCY = 10;
  let precalificados = 0;
  let calificados = 0;
  let successTotal = 0;

  for (let i = 0; i < allContacts.length; i += CONCURRENCY) {
    const batch = allContacts.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (c) => {
      try {
        const stageId = c.hasPhone ? STAGE_CALIFICADO_ID : STAGE_PRECALIFICADO_ID;
        const oppName = `${c.name} [${c.pageLabel}]`;

        const payload = {
          pipelineId: PIPELINE_ID,
          locationId: locationId,
          name: oppName,
          pipelineStageId: stageId,
          status: 'open',
          contactId: c.id
        };

        if (c.assignedTo) {
          payload.assignedTo = c.assignedTo;
        }

        const oppUrl = `https://services.leadconnectorhq.com/opportunities/`;
        const res = await fetchWithRetry(oppUrl, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          successTotal++;
          if (c.hasPhone) calificados++;
          else precalificados++;
        }
      } catch (e) {}
    }));

    const progress = Math.min(i + CONCURRENCY, allContacts.length);
    if (progress % 100 === 0 || progress === allContacts.length) {
      console.log(`[PROGRESO] ${progress}/${allContacts.length} procesados | Calificados: ${calificados} | Precalificados: ${precalificados}...`);
    }
    await sleep(100);
  }

  console.log(`\n🎉 DISTRIBUCIÓN AL PIPELINE MAESTRO FINALIZADA:`);
  console.log(`=================================================`);
  console.log(`👥 Total de Oportunidades Creadas: ${successTotal}`);
  console.log(`💬 1. En 'Precalificado' (Sin Teléfono): ${precalificados} (${(((precalificados)/successTotal)*100).toFixed(1)}%)`);
  console.log(`📞 2. En 'Calificado'   (Con Teléfono): ${calificados} (${(((calificados)/successTotal)*100).toFixed(1)}%)`);
  console.log(`=================================================\n`);
}

if (process.argv[1].endsWith('distribute_contacts.js')) {
  runDistributeContacts();
}

export async function processSingleContactFromWebhook(c) {
  try {
    const hasPhone = Boolean(c.phone && c.phone.trim().length > 0);
    const tags = (c.tags || []).map(t => typeof t === 'string' ? t.toLowerCase() : '');
    
    let pageLabel = 'General';
    if (tags.includes('naturales bionatural')) pageLabel = 'BioNatural';
    else if (tags.includes('bionatural ultra')) pageLabel = 'Ultra';
    else if (tags.includes('naturales bio corp')) pageLabel = 'Bio Corp';
    else if (tags.includes('bio natural')) pageLabel = 'Bio Natural';
    else if (tags.includes('bio naturales')) pageLabel = 'Bio Naturales';
    else if (tags.includes('laboratorios naturales bio')) pageLabel = 'Laboratorios';

    const stageId = hasPhone ? STAGE_CALIFICADO_ID : STAGE_PRECALIFICADO_ID;
    const name = `${c.first_name || c.firstName || ''} ${c.last_name || c.lastName || ''}`.trim() || 'Sin Nombre';
    const oppName = `${name} [${pageLabel}]`;

    const payload = {
      pipelineId: PIPELINE_ID,
      locationId: locationId,
      name: oppName,
      pipelineStageId: stageId,
      status: 'open',
      contactId: c.id
    };

    if (c.assignedTo) {
      payload.assignedTo = c.assignedTo;
    }

    console.log(`[Webhook Event] Processing contact: ${name} -> Has Phone?: ${hasPhone ? 'YES' : 'NO'}`);

    const oppUrl = `https://services.leadconnectorhq.com/opportunities/`;
    const res = await fetchWithRetry(oppUrl, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      console.log(`[Webhook Success] Opportunity created successfully in stage: ${hasPhone ? 'Calificado' : 'Precalificado'}`);
      return { success: true, stage: hasPhone ? 'calificado' : 'precalificado' };
    } else {
      console.error(`[Webhook Error] Failed creating opportunity: ${res.statusText}`);
      return false;
    }
  } catch (err) {
    console.error(`[Webhook Exception] Error processing contact: ${err.message}`);
    return false;
  }
}
