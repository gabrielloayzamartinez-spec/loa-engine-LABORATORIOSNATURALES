import { GHL_CONFIG } from './src/config/index.js';
const HEADERS = {
  'Authorization': `Bearer ${GHL_CONFIG.apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

async function checkFields() {
  const res = await fetch(`https://services.leadconnectorhq.com/locations/${GHL_CONFIG.locationId}/customFields`, { headers: HEADERS });
  const data = await res.json();
  data.customFields.forEach(f => console.log(`${f.id} - ${f.name} (${f.fieldKey})`));
}
checkFields();
