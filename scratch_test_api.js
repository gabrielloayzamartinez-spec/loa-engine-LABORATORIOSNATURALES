import { GHL_CONFIG } from './src/config/index.js';

const HEADERS = {
  'Authorization': `Bearer ${GHL_CONFIG.apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

async function test() {
  const upsertBody = {
    locationId: GHL_CONFIG.locationId,
    email: `test-${Date.now()}@test.com`,
    firstName: "Test",
    source: "INITIAL-SOURCE"
  };
  
  const upsertRes = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(upsertBody)
  });
  const upsertData = await upsertRes.json();
  const contactId = upsertData.contact.id;
  console.log("Created contact:", contactId, "Source:", upsertData.contact.source);

  const url = `https://services.leadconnectorhq.com/contacts/${contactId}`;
  
  const putRes = await fetch(url, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify({ source: "NEW-SOURCE" })
  });
  console.log("PUT status:", putRes.status);
  const putData = await putRes.json();
  console.log("Source after PUT:", putData.contact?.source);
}

test();
