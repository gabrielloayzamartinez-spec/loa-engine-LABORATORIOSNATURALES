import { GHL_CONFIG } from '../config/index.js';

const { apiKey, locationId } = GHL_CONFIG;
const HEADERS_CONTACTS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

async function runDuplicateRadar() {
  console.log('=============================================');
  console.log('🔍 RADAR DE DUPLICADOS INICIADO (Modo Aislado)');
  console.log('=============================================');

  try {
    let allContacts = [];
    let nextPageUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100`;
    
    console.log('[1/3] Extrayendo historial de contactos desde GHL...');
    while (nextPageUrl) {
      const res = await fetch(nextPageUrl, { headers: HEADERS_CONTACTS });
      if (res.status === 429) {
        console.log('Rate limit alcanzado. Esperando 10 segundos...');
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      const data = await res.json();
      const contacts = data.contacts || [];
      allContacts.push(...contacts);
      
      nextPageUrl = data.meta?.nextPageUrl || null;
      process.stdout.write(`\rDescargados: ${allContacts.length} contactos...`);
    }
    console.log('\n[✔] Extracción completa.');

    console.log('\n[2/3] Analizando clics múltiples y duplicados...');
    
    // Agrupar por nombre completo (ignorando vacíos y pasándolos a minúsculas)
    const nameGroups = {};
    for (const c of allContacts) {
      const first = (c.firstName || '').trim().toLowerCase();
      const last = (c.lastName || '').trim().toLowerCase();
      const fullName = `${first} ${last}`.trim();
      
      if (!fullName) continue; // Ignorar contactos sin nombre

      if (!nameGroups[fullName]) {
        nameGroups[fullName] = [];
      }
      nameGroups[fullName].push(c);
    }

    let report = [];
    let tagsApplied = 0;

    console.log('\n[3/3] Aplicando etiquetas y generando reporte...');
    for (const [name, contacts] of Object.entries(nameGroups)) {
      if (contacts.length > 1) { // Si hay 2, 3, 4 o más clics
        
        // Ordenar del más antiguo al más reciente
        contacts.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
        
        const original = contacts[0];
        report.push(`- ${name.toUpperCase()} hizo clic ${contacts.length} veces.`);
        
        // Etiquetar a los clones (2do, 3ro, 4to...)
        for (let i = 1; i < contacts.length; i++) {
          const clone = contacts[i];
          const duplicateTag = `alerta-duplicado-clic-${i+1}`;
          
          const currentTags = clone.tags || [];
          if (!currentTags.includes(duplicateTag)) {
            try {
              await fetch(`https://services.leadconnectorhq.com/contacts/${clone.id}/tags`, {
                method: 'POST',
                headers: HEADERS_CONTACTS,
                body: JSON.stringify({ tags: [duplicateTag] })
              });
              tagsApplied++;
              console.log(`  [Etiquetado] ${name} (Clic #${i+1}) -> ${duplicateTag}`);
            } catch(e) {
              console.log(`  [Error etiquetando] ${name}: ${e.message}`);
            }
          }
        }
      }
    }

    console.log('\n=============================================');
    console.log('📊 REPORTE FINAL PARA COMISIONES');
    console.log('=============================================');
    console.log(`Total de Casos Duplicados Detectados: ${report.length}`);
    console.log(`Nuevas Etiquetas Aplicadas Hoy: ${tagsApplied}`);
    console.log('\nDetalle de Usuarios (Descuentos a aplicar):');
    report.forEach(r => console.log(r));
    console.log('=============================================');
    console.log('Filtra en GHL por las etiquetas "alerta-duplicado-clic-2", "alerta-duplicado-clic-3", etc.');

  } catch (error) {
    console.error("Error en el Radar de Duplicados:", error.message);
  }
}

runDuplicateRadar();
