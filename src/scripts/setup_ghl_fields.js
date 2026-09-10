import { GHL_CONFIG, CUSTOM_FIELDS_DEF } from '../config/index.js';
import fs from 'fs';
import path from 'path';

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

async function fetchCustomFields() {
  const url = `https://services.leadconnectorhq.com/locations/${locationId}/customFields`;
  const res = await fetchWithRetry(url, { headers: HEADERS });
  if (res.status === 200) {
    const data = await res.json();
    return data.customFields || [];
  }
  return [];
}

export async function getOrCreateCustomFields() {
  console.log("\n🔍 Verificando Campos Personalizados en GHL...");
  const existingFields = await fetchCustomFields();
  const createdFields = [];

  for (const def of CUSTOM_FIELDS_DEF) {
    const found = existingFields.find(f => f.name === def.name);
    if (found) {
      console.log(`✅ Campo detectado: "${found.name}" (ID: ${found.id})`);
      createdFields.push(found);
      continue;
    }

    console.log(`🚀 Creando Campo Personalizado: "${def.name}" (${def.dataType})...`);
    try {
      const payload = {
        name: def.name,
        dataType: def.dataType
      };
      if (def.options) {
        payload.options = def.options;
      }
      
      const createRes = await fetchWithRetry(`https://services.leadconnectorhq.com/locations/${locationId}/customFields`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(payload)
      });
      
      const createData = await createRes.json();
      const created = createData.customField || createData;
      console.log(`🎉 ¡CAMPO "${created.name}" CREADO CON ÉXITO! (ID: ${created.id || 'N/A'})`);
      createdFields.push(created);
    } catch (err) {
      console.error(`❌ Error creando Campo "${def.name}":`, err.message);
    }
  }
  return createdFields;
}

if (process.argv[1] && process.argv[1].endsWith('setup_ghl_fields.js')) {
  getOrCreateCustomFields();
}
