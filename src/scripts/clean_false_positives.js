import dotenv from 'dotenv';
dotenv.config();

import { ghlFetch } from '../utils/ghl_http_client.js';
import { getActiveSedes, getGhlHeaders } from '../config/index.js';
import { findVTigerContact } from '../services/vtiger_api_service.js';

// MODO AUDITORÍA: Si es true, SOLO detecta pero NO borra nada en GHL.
// Si es false, ejecuta la purga real (Cirugía de Limpieza).
const DRY_RUN = true; 

// Etiquetas que se consideran "basura" si resultan ser un lead nuevo
const TAGS_TO_STRIP = ['compro', 'no-compro', 'no-contesta'];

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAllGhlContacts(locationId, headers) {
  let allContacts = [];
  let currentUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100`;
  
  console.log(`\n[+] Iniciando escaneo de contactos en la sede ${locationId}...`);

  while (currentUrl) {
    const res = await ghlFetch(currentUrl, { headers, method: 'GET' }, 1, 'Sanitizer');
    
    if (res.status !== 200) {
      console.error(`[-] Error obteniendo contactos. HTTP ${res.status}`);
      break;
    }
    
    const data = await res.json();
    const contacts = data.contacts || [];
    if (contacts.length === 0) break;

    // Filtrar localmente los que tengan alguna etiqueta sospechosa (ej. "compro")
    const suspects = contacts.filter(c => {
      const tags = (c.tags || []).map(t => typeof t === 'string' ? t.toLowerCase() : '');
      return TAGS_TO_STRIP.some(ts => tags.includes(ts));
    });

    allContacts = allContacts.concat(suspects);
    console.log(`[Escaneo] Procesados ${allContacts.length} contactos sospechosos hasta ahora...`);
    
    // Paginación V2 (Cursor)
    currentUrl = data.meta && data.meta.nextPageUrl ? data.meta.nextPageUrl : null;
  }
  
  return allContacts;
}

async function stripGhlData(contactId, locationId, headers, tagsToRemove) {
  for (const tag of tagsToRemove) {
    const url = `https://services.leadconnectorhq.com/contacts/${contactId}/tags`;
    const body = JSON.stringify({ tags: [tag] });
    const res = await ghlFetch(url, { headers, method: 'DELETE', body }, 1, 'Sanitizer');
    if (res.status === 200 || res.status === 201) {
      console.log(`   [✓] Etiqueta eliminada: ${tag}`);
    } else {
      console.warn(`   [x] Falló al eliminar etiqueta ${tag} (HTTP ${res.status})`);
    }
  }
}

async function runSweeper() {
  console.log('===========================================================');
  console.log('🧹 INICIANDO SCRIPT BARREDOR DE FALSOS POSITIVOS 🧹');
  console.log(`Modo: ${DRY_RUN ? 'SIMULACIÓN (AUDITORÍA)' : 'EJECUCIÓN REAL (PURGA)'}`);
  console.log('===========================================================\n');

  const sedes = getActiveSedes().filter(s => !s.isPaused);

  for (const sede of sedes) {
    const headers = getGhlHeaders({ locationId: sede.ghl.locationId });
    console.log(`\n>>> Evaluando Sede: ${sede.name} <<<`);
    
    const suspects = await fetchAllGhlContacts(sede.ghl.locationId, headers);
    console.log(`\n=> Total sospechosos a re-evaluar en ${sede.name}: ${suspects.length}\n`);

    let falsosPositivosDetectados = 0;

    for (const [index, contact] of suspects.entries()) {
      const ghlName = `${contact.firstName || ''} ${contact.lastName || ''}`.trim();
      const cleanPhone = contact.phone ? contact.phone.replace(/\D/g, '') : 'Sin Teléfono';

      console.log(`[${index + 1}/${suspects.length}] Evaluando: ${ghlName} | Telf: ${cleanPhone} | ID: ${contact.id}`);

      // Pasamos el contacto por el nuevo Escudo Estricto
      const vContact = await findVTigerContact(contact, sede.name);

      if (!vContact) {
        falsosPositivosDetectados++;
        console.log(`   🚨 [FALSO POSITIVO ENCONTRADO] El contacto falló la prueba estricta.`);
        
        const currentTags = (contact.tags || []).map(t => typeof t === 'string' ? t.toLowerCase() : '');
        const tagsToRemove = currentTags.filter(t => TAGS_TO_STRIP.includes(t));

        if (DRY_RUN) {
          console.log(`   🔍 [DRY-RUN] Se borrarían las etiquetas: [${tagsToRemove.join(', ')}]`);
        } else {
          console.log(`   🔧 [CIRUGÍA] Purgando etiquetas basura en GHL...`);
          await stripGhlData(contact.id, sede.ghl.locationId, headers, tagsToRemove);
          console.log(`   ✅ [LIMPIO] Contacto desinfectado.`);
        }
      } else {
        console.log(`   🛡️  [VÁLIDO] Pasó la prueba estricta. Es un match real.`);
      }
      
      await sleep(200); // Rate limit protection
    }

    console.log(`\n===========================================================`);
    console.log(`RESUMEN DE ${sede.name}:`);
    console.log(`Total Sospechosos Analizados : ${suspects.length}`);
    console.log(`Falsos Positivos Detectados  : ${falsosPositivosDetectados}`);
    console.log(`===========================================================\n`);
  }
}

runSweeper().catch(console.error);
