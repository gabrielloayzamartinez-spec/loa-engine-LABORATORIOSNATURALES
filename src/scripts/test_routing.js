import { GHL_CONFIG } from '../config/index.js';
import { fetchWithRetry } from '../utils/http_client.js';
import { routeChatByContact } from '../agents/chat_router_agent.js';

const contactId = 'TxBMJzde5BG1up8uYMNr'; // Arturo Davila

async function testRouting() {
  console.log(`Buscando contacto ${contactId}...`);
  const contactRes = await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    headers: {
      'Authorization': `Bearer ${GHL_CONFIG.apiKey}`,
      'Version': '2021-07-28'
    }
  }, 1, true);

  if (contactRes.status !== 200) {
    console.error('Error buscando contacto:', await contactRes.text());
    return;
  }

  const { contact } = await contactRes.json();
  console.log(`Contacto encontrado: ${contact.fullNameLowerCase}`);
  
  // Ejecutar el ruteo en modo Dry-Run (isLive = false)
  console.log('--- INICIANDO DRY RUN ---');
  await routeChatByContact(contact, false);
  console.log('--- FIN DRY RUN ---');
}

testRouting();
