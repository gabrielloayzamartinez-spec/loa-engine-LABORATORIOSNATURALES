import { GHL_CONFIG, PAGE_TAG_MAP, PALACIOS_USERS } from '../config/index.js';

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

export async function runHistoricalAssignment() {
  console.log("\n=================================================");
  console.log("🚀 MUDANZA HISTÓRICA DE ASIGNACIÓN DE USUARIOS");
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
      const tags = (c.tags || []).map(t => typeof t === 'string' ? t.toLowerCase() : '');
      
      let detectedPage = null;
      for (const [pageName, tag] of Object.entries(PAGE_TAG_MAP)) {
        if (tags.includes(tag)) {
          detectedPage = pageName;
          break;
        }
      }

      if (detectedPage) {
        allContacts.push({
          id: c.id,
          name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Sin Nombre',
          assignedTo: c.assignedTo || null,
          detectedPage
        });
      }
    }

    url = data.meta?.nextPageUrl || null;
  }

  console.log(`\n📊 Total de contactos identificados con etiquetas de página: ${allContacts.length}\n`);

  let stats = {
    scanned: 0,
    palaciosAssigned: 0,
    benavidesAssigned: 0,
    rooseveltAssigned: 0,
    piuraAssigned: 0,
    alreadyAssigned: 0
  };

  for (const c of allContacts) {
    let targetUserId = null;
    let targetUserName = "";

    if (c.detectedPage === 'Naturales BioNatural') {
      targetUserId = PALACIOS_USERS['naturales bionatural'].id;
      targetUserName = PALACIOS_USERS['naturales bionatural'].name;
    } else if (c.detectedPage === 'BioNatural - Ultra') {
      targetUserId = PALACIOS_USERS['bionatural ultra'].id;
      targetUserName = PALACIOS_USERS['bionatural ultra'].name;
    } else if (c.detectedPage === 'Naturales Bio Corp') {
      targetUserId = PALACIOS_USERS['redes benavides 1'].id;
      targetUserName = PALACIOS_USERS['redes benavides 1'].name;
    } else if (c.detectedPage === 'Bio Natural' || c.detectedPage === 'BioNatural Fuerza') {
      targetUserId = PALACIOS_USERS['redes benavides 2'].id;
      targetUserName = PALACIOS_USERS['redes benavides 2'].name;
    } else if (c.detectedPage === 'Bio Naturales' || c.detectedPage === 'BioNatural Plus' || c.detectedPage === 'Bio Naturales Plus') {
      targetUserId = PALACIOS_USERS['redes roosevelt'].id;
      targetUserName = PALACIOS_USERS['redes roosevelt'].name;
    } else if (c.detectedPage === 'BioNatural' || c.detectedPage === 'Natural Bio') {
      targetUserId = PALACIOS_USERS['redes piura'].id;
      targetUserName = PALACIOS_USERS['redes piura'].name;
    }

    if (targetUserId) {
      if (c.assignedTo !== targetUserId) {
        try {
          const updateUrl = `https://services.leadconnectorhq.com/contacts/${c.id}`;
          const res = await fetchWithRetry(updateUrl, {
            method: 'PUT',
            headers: HEADERS,
            body: JSON.stringify({ assignedTo: targetUserId })
          });

          if (res.ok) {
            if (targetUserName.includes('BENAVIDES')) {
              stats.benavidesAssigned++;
              console.log(`[BENAVIDES] Asignado: ${c.name} -> ${c.detectedPage}`);
            } else if (targetUserId === PALACIOS_USERS['redes roosevelt'].id) {
              stats.rooseveltAssigned++;
              console.log(`[ROOSEVELT] Asignado: ${c.name} -> ${c.detectedPage}`);
            } else if (targetUserId === PALACIOS_USERS['redes piura'].id) {
              stats.piuraAssigned++;
              console.log(`[PIURA] Asignado: ${c.name} -> ${c.detectedPage}`);
            } else {
              stats.palaciosAssigned++;
              console.log(`[PALACIOS] Asignado: ${c.name} -> ${c.detectedPage}`);
            }
          }
        } catch (err) {
          console.error(`[Error] Fallo al asignar ${c.name}: ${err.message}`);
        }
        await sleep(100); // Prevención de rate limits
      } else {
        stats.alreadyAssigned++; // Ya estaba asignado correctamente
      }
    } else {
      stats.alreadyAssigned++;
    }
  }

  console.log(`\n🎉 MUDANZA HISTÓRICA FINALIZADA:`);
  console.log(`=================================================`);
  console.log(`🏢 Asignados a PALACIOS (Nuevos): ${stats.palaciosAssigned}`);
  console.log(`🏢 Asignados a BENAVIDES (Nuevos): ${stats.benavidesAssigned}`);
  console.log(`🏢 Asignados a ROOSEVELT (Nuevos): ${stats.rooseveltAssigned}`);
  console.log(`🏢 Asignados a PIURA (Nuevos): ${stats.piuraAssigned}`);
  console.log(`✅ Ya estaban correctamente asignados o sin mapeo: ${stats.alreadyAssigned}`);
  console.log(`=================================================\n\n`);
}

if (process.argv[1] && process.argv[1].endsWith('historical_assignment.js')) {
  runHistoricalAssignment();
}
