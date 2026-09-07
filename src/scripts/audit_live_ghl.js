import { GHL_CONFIG, PALACIOS_USERS } from '../config/index.js';

const { apiKey, locationId } = GHL_CONFIG;
const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Accept': 'application/json'
};

async function auditLiveGHL() {
  console.log('=================================================');
  console.log('🔍 AUDITORÍA EN VIVO DE GOHIGHLEVEL (TIEMPO REAL)');
  console.log('=================================================\n');

  try {
    // 1. Obtener Pipeline Maestro y sus Oportunidades
    const pipeRes = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`, { headers: HEADERS });
    const pipeData = await pipeRes.json();
    const maestroPipe = (pipeData.pipelines || []).find(p => p.name.includes('Pipeline Maestro'));

    if (maestroPipe) {
      console.log(`🎯 PIPELINE MAESTRO: ${maestroPipe.name}`);
      console.log(`ID: ${maestroPipe.id}`);
      console.log('Etapas del Tablero:');
      (maestroPipe.stages || []).forEach(s => console.log(`  • ${s.name} (ID: ${s.id})`));
    }

    // 2. Obtener los 10 contactos más recientes
    console.log('\n-------------------------------------------------');
    console.log('👥 ÚLTIMOS 10 CONTACTOS EN EL CRM:');
    console.log('-------------------------------------------------');
    const contactsRes = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=10`, { headers: HEADERS });
    const contactsData = await contactsRes.json();
    const contacts = contactsData.contacts || [];

    for (let idx = 0; idx < contacts.length; idx++) {
      const c = contacts[idx];
      const fullName = `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Sin Nombre';
      const phone = c.phone || '❌ SIN TELÉFONO';
      const tags = (c.tags || []).join(', ') || 'Sin etiquetas';
      const date = c.dateAdded ? new Date(c.dateAdded).toLocaleString('es-ES') : 'N/A';
      
      let assignedName = 'Sin Asignar';
      for (const [key, user] of Object.entries(PALACIOS_USERS)) {
        if (c.assignedTo === user.id) {
          assignedName = user.name;
          break;
        }
      }

      console.log(`\n[${idx + 1}] 👤 ${fullName}`);
      console.log(`    📅 Fecha Registro: ${date}`);
      console.log(`    📞 Teléfono: ${phone}`);
      console.log(`    🏛️ Asesor Asignado: ${assignedName}`);
      console.log(`    🏷️ Etiquetas: [ ${tags} ]`);
    }

    // 3. Obtener Oportunidades recientes en el Pipeline Maestro
    if (maestroPipe) {
      console.log('\n-------------------------------------------------');
      console.log('📊 OPORTUNIDADES ACTIVAS EN EL PIPELINE MAESTRO:');
      console.log('-------------------------------------------------');
      const oppsRes = await fetch(`https://services.leadconnectorhq.com/opportunities/search?locationId=${locationId}&pipelineId=${maestroPipe.id}&limit=10`, { headers: HEADERS });
      const oppsData = await oppsRes.json();
      const opps = oppsData.opportunities || [];
      console.log(`Total oportunidades recientes leídas: ${opps.length}`);
      
      opps.forEach((o, i) => {
        const stage = (maestroPipe.stages || []).find(s => s.id === o.pipelineStageId);
        const stageName = stage ? stage.name : 'Etapa Desconocida';
        console.log(`  ${i + 1}. [${stageName}] ${o.name} (Estado: ${o.status})`);
      });
    }

    console.log('\n=================================================');
    console.log('✅ AUDITORÍA EN VIVO FINALIZADA CON ÉXITO');
    console.log('=================================================\n');

  } catch (error) {
    console.error('❌ Error durante la auditoría:', error.message);
  }
}

auditLiveGHL();
