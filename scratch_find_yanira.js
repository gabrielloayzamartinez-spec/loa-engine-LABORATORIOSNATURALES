import { GHL_CONFIG } from './src/config/index.js';

const HEADERS = {
  'Authorization': `Bearer ${GHL_CONFIG.apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

async function findContact() {
  const url = `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_CONFIG.locationId}&query=Yanira%20Menendez`;
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();
  const contacts = data.contacts || [];
  if (contacts.length > 0) {
    console.log("Found:", contacts[0].id, contacts[0].source);
    // console.log("Custom Fields:", contacts[0].customFields);
  } else {
    console.log("No contact found");
  }
}

findContact();
