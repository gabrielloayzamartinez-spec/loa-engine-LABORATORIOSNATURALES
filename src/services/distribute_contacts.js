import { GHL_CONFIG, PAGE_TAG_MAP } from '../config/index.js';

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
      // GoHighLevel limits are 100 req / 10s. We need to sleep longer if we hit it.
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
      
      // Detectar etiqueta de página para el título basado en config.js
      let pageLabel = 'General';
      for (const [pageName, pageTag] of Object.entries(PAGE_TAG_MAP)) {
        if (tags.includes(pageTag)) {
          pageLabel = pageName;
          break;
        }
      }

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
      const res = await processContactPipeline(c, 'Batch Distribution');
      if (res && res.success) {
        if (res.action === 'created_calificado') { successTotal++; calificados++; }
        else if (res.action === 'created_precalificado') { successTotal++; precalificados++; }
        // We can track moved as well if we add variables for them, but for batch creating we just count newly created
      }
    }));

    const progress = Math.min(i + CONCURRENCY, allContacts.length);
    if (progress % 100 === 0 || progress === allContacts.length) {
      console.log(`[PROGRESO] ${progress}/${allContacts.length} procesados | Nuevos Calificados: ${calificados} | Nuevos Precalificados: ${precalificados}...`);
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

if (process.argv[1] && process.argv[1].endsWith('distribute_contacts.js')) {
  runDistributeContacts();
}

export async function processContactPipeline(c, context = 'Background') {
  try {
    const hasPhone = Boolean(c.phone && c.phone.trim().length > 0);
    const tags = (c.tags || []).map(t => typeof t === 'string' ? t.toLowerCase() : '');
    // Detectar etiqueta de página para el título basado en config.js
    let pageLabel = 'General';
    for (const [pageName, pageTag] of Object.entries(PAGE_TAG_MAP)) {
      if (tags.includes(pageTag)) {
        pageLabel = pageName;
        break;
      }
    }

    const stageId = hasPhone ? STAGE_CALIFICADO_ID : STAGE_PRECALIFICADO_ID;
    const name = `${c.first_name || c.firstName || ''} ${c.last_name || c.lastName || ''}`.trim() || 'Sin Nombre';
    const oppName = `${name} [${pageLabel}]`;

    // 1. Check if opportunity already exists for this contact in the CRM
    const searchUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&contact_id=${c.id}`;
    const searchRes = await fetchWithRetry(searchUrl, { headers: HEADERS });
    const searchData = await searchRes.json();
    const existingOpps = searchData.opportunities || [];
    
    const masterOpp = existingOpps.find(o => o.pipelineId === PIPELINE_ID);

    if (masterOpp) {
      // 2. Already exists. Should we move it?
      if (masterOpp.pipelineStageId === STAGE_PRECALIFICADO_ID && hasPhone) {
        console.log(`[${context}] Actualizando oportunidad: ${name} -> Moviendo a Calificado (Añadió teléfono)`);
        const updateUrl = `https://services.leadconnectorhq.com/opportunities/${masterOpp.id}`;
        const updateRes = await fetchWithRetry(updateUrl, {
          method: 'PUT',
          headers: HEADERS,
          body: JSON.stringify({ pipelineStageId: STAGE_CALIFICADO_ID, name: oppName })
        });
        if (updateRes.ok) return { action: 'moved_to_calificado', success: true };
      } else {
        // En etapa correcta o más avanzada
        return { action: 'ignored_existing', success: true };
      }
    } else {
      // 3. Create new opportunity
      console.log(`[${context}] Creando oportunidad nueva para: ${name} -> ${hasPhone ? 'Calificado' : 'Precalificado'}`);
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
      const createRes = await fetchWithRetry(oppUrl, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(payload)
      });

      if (createRes.ok) {
        return { action: hasPhone ? 'created_calificado' : 'created_precalificado', success: true };
      } else {
        console.error(`[${context} Error] Fallo al crear oportunidad para ${name}: ${createRes.statusText}`);
      }
    }
    return { action: 'error', success: false };
  } catch (err) {
    console.error(`[${context} Exception] Error procesando contacto: ${err.message}`);
    return { action: 'error', success: false };
  }
}

export async function processSingleContactFromWebhook(payload) {
  const contactId = payload.id || payload.contactId || payload.contact_id;
  if (!contactId) {
    console.error('[Webhook Event] No se encontró un ID válido en el payload.');
    return false;
  }

  try {
    // 1. Obtener la información COMPLETA del contacto para no perder el nombre
    const url = `https://services.leadconnectorhq.com/contacts/${contactId}`;
    const res = await fetchWithRetry(url, { headers: HEADERS });
    if (!res.ok) {
      console.error(`[Webhook Event] Fallo al obtener detalles completos del contacto ${contactId}: ${res.statusText}`);
      return false;
    }
    const data = await res.json();
    const fullContact = data.contact;

    // 2. Procesar con los datos completos
    const result = await processContactPipeline(fullContact, 'Webhook Event');
    if (result && result.success) {
      if (result.action === 'created_calificado' || result.action === 'moved_to_calificado') {
        return { success: true, stage: 'calificado' };
      } else if (result.action === 'created_precalificado') {
        return { success: true, stage: 'precalificado' };
      }
    }
  } catch (err) {
    console.error(`[Webhook Event] Error al obtener el contacto completo: ${err.message}`);
  }
  return false;
}
