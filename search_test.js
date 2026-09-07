import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;

const HEADERS_CONV = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-04-15',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

async function test() {
  const contactId = "d20QWLWg4DYah0hQ2NKV"; // Ontiveros Rosy
  
  const notesUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;
  const resNotes = await fetch(notesUrl, { headers: HEADERS_CONV });
  const dataNotes = await resNotes.json();
  console.log("Notes Data:", JSON.stringify(dataNotes, null, 2));
}
test();
