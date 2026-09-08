import dotenv from 'dotenv';
dotenv.config();
import { analyzeSymptoms, extractShippingData, inferTreatmentFromCampaignOrUtm } from '../agents/nlp_symptom_engine.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

const HEADERS = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

const TRATAMIENTO_FIELD = 'WcrrCIL4A2203kIbeFsJ';
const ALL_PRODUCT_TAGS = [
  'producto-artritis',
  'producto-diabetes',
  'producto-prostata',
  'producto-potencia',
  'producto-colageno',
  'producto-vision',
  'producto-gastro'
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      console.log(`[Rate Limit 429] Esperando ${attempt * 2}s...`);
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

/**
 * Peinado Correctivo de Tratamientos y Etiquetas
 * Recorre contactos recientes para sanar falsos positivos de Artritis en leads de Potencia/Diabetes/Próstata.
 */
export async function runPeinadoCorrectivo(limitContacts = 100) {
  console.log('===============================================================');
  console.log('🧹 INICIANDO PEINADO CORRECTIVO DE PRODUCTOS Y FUENTES (GHL)');
  console.log('===============================================================');

  let totalScanned = 0;
  let totalFixed = 0;
  let nextPageUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&limit=50&sortBy=date_updated&order=desc`;

  while (nextPageUrl && totalScanned < limitContacts) {
    const res = await fetchWithRetry(nextPageUrl, { headers: HEADERS });
    if (res.status !== 200) {
      console.error(`Error al consultar contactos: HTTP ${res.status}`);
      break;
    }

    const data = await res.json();
    const contacts = data.contacts || [];
    if (contacts.length === 0) break;

    for (const c of contacts) {
      totalScanned++;
      const currentTags = (c.tags || []).map(t => String(t).trim().toLowerCase());
      const hasArtritisTag = currentTags.includes('producto-artritis');
      const hasOtherProductTag = currentTags.some(t => ALL_PRODUCT_TAGS.includes(t) && t !== 'producto-artritis');
      const sourceIsArtritis = (c.source || '').includes('Artritis');

      // Solo auditar contactos que tienen Artritis como etiqueta o fuente Y otra señal, o que tengan múltiples productos
      if (!hasArtritisTag && !sourceIsArtritis) continue;

      // Buscar mensajes del contacto
      const convRes = await fetchWithRetry(`https://services.leadconnectorhq.com/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${c.id}`, { headers: HEADERS });
      if (convRes.status !== 200) continue;
      const convData = await convRes.json();
      const conv = convData.conversations?.[0];
      if (!conv) continue;

      const msgRes = await fetchWithRetry(`https://services.leadconnectorhq.com/conversations/${conv.id}/messages?limit=25`, { headers: HEADERS });
      if (msgRes.status !== 200) continue;
      const msgData = await msgRes.json();
      const messages = msgData.messages?.messages || [];
      const combinedText = messages.map(m => m.body || '').join(' \n ');

      // Re-analizar con el motor NLP corregido
      const nlp = analyzeSymptoms(combinedText);
      const utmTreatment = inferTreatmentFromCampaignOrUtm(c.attributionSource?.utmMedium) ||
                           inferTreatmentFromCampaignOrUtm(c.attributionSource?.utmCampaign) ||
                           inferTreatmentFromCampaignOrUtm(c.attributionSource?.campaign);
      const realTreatment = nlp.primaryTreatment || utmTreatment;

      // Si el tratamiento primario NO es Artritis, pero estaba contaminado con Artritis:
      if (realTreatment && realTreatment !== 'Artritis' && (hasArtritisTag || sourceIsArtritis)) {
        console.log(`\n🚨 DETECTADO FALSO POSITIVO: ${c.firstName || ''} ${c.lastName || ''} (${c.id})`);
        console.log(`   Tratamiento Real: ${realTreatment} | Tratamiento Anterior: Artritis`);

        // 1. Limpiar etiquetas: Eliminar producto-artritis y asegurar etiqueta correcta
        const newTags = currentTags.filter(t => t !== 'producto-artritis');
        const correctTag = `producto-${realTreatment.toLowerCase()}`;
        if (!newTags.includes(correctTag)) newTags.push(correctTag);

        // 2. Limpiar fuente
        let newSource = c.source || '';
        if (sourceIsArtritis) {
          newSource = newSource.replace(/Artritis/g, realTreatment);
        }

        // 3. Limpiar campo personalizado Tratamiento
        const existingCFs = c.customFields || [];
        const updatedCFs = existingCFs.map(f => {
          if (f.id === TRATAMIENTO_FIELD) {
            return { id: f.id, field_value: realTreatment };
          }
          return { id: f.id, field_value: f.value };
        });

        // Si no existía el campo en customFields, agregarlo
        if (!existingCFs.some(f => f.id === TRATAMIENTO_FIELD)) {
          updatedCFs.push({ id: TRATAMIENTO_FIELD, field_value: realTreatment });
        }

        const shipping = extractShippingData(combinedText, c.phone);

        const updatePayload = {
          tags: newTags,
          source: newSource,
          customFields: updatedCFs
        };

        // Enriquecer General Info (País, Estado, Zona Horaria, Dirección)
        if (!c.country || c.country === '--') updatePayload.country = 'United States';
        if (!c.address1 && shipping.address1) updatePayload.address1 = shipping.address1;
        if (!c.city && shipping.city) updatePayload.city = shipping.city;
        if ((!c.state || c.state === '--') && shipping.state) updatePayload.state = shipping.state;
        if (!c.postalCode && shipping.postalCode) updatePayload.postalCode = shipping.postalCode;
        if ((!c.timezone || c.timezone === '--') && shipping.timezone) updatePayload.timezone = shipping.timezone;

        const updateRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${c.id}`, {
          method: 'PUT',
          headers: HEADERS,
          body: JSON.stringify(updatePayload)
        });

        if (updateRes.status === 200) {
          totalFixed++;
          console.log(`   ✅ CORREGIDO CON ÉXITO -> Fuente: ${newSource} | Tag: ${correctTag}`);
        } else {
          console.error(`   ❌ Falló actualización de ${c.id}: HTTP ${updateRes.status}`);
        }

        await sleep(400); // Respetar rate-limit
      }
    }

    nextPageUrl = data.meta?.nextPageUrl || null;
    await sleep(500);
  }

  console.log('\n===============================================================');
  console.log(`🏁 PEINADO FINALIZADO: ${totalScanned} contactos auditados, ${totalFixed} corregidos.`);
  console.log('===============================================================');
}

// Ejecución directa si se invoca por CLI
if (process.argv[1]?.includes('peinado_correctivo_productos.js')) {
  const limit = parseInt(process.argv[2], 10) || 100;
  runPeinadoCorrectivo(limit);
}
