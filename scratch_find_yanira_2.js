import { GHL_CONFIG } from './src/config/index.js';

const HEADERS = {
  'Authorization': `Bearer ${GHL_CONFIG.apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

async function checkDetails() {
  const url = `https://services.leadconnectorhq.com/contacts/rPqLqAaZcEFhYatmNgdO`;
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();
  const contact = data.contact;
  
  console.log("Source:", contact.source);
  console.log("Tags:", contact.tags);
  const trat = contact.customFields.find(f => f.id === '3oOQYSTsK5q8D1vV8v4L' || f.id === 'W8lV8lJ2c8GgH6Qp1uQj' || f.id === 'H9nC0QZ1a8W1P1M8X7N7' || (f.id === '9CgXb4z60f7qI9wF2a7t' || f.name === 'Tratamiento comprado' || f.name === 'tratamiento_comprado'));
  // Actually let's just log all custom fields to be sure
  contact.customFields.forEach(f => {
    if (f.id === 'l31iB7OQpX0U8u2iZJ1l' || f.id === 'L3eEulpe8II7q0UAJnKZ') {} // skip some noise
    console.log(`CF [${f.id}]:`, f.value);
  });
  console.log("Attribution:", contact.attributionSource);
}

checkDetails();
