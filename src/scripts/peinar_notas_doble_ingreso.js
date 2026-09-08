/**
 * 🧹 PEINADO Y ACTUALIZACIÓN HISTÓRICA DE NOTAS Y DOBLE INGRESO PUBLICITARIO
 * 
 * Este script barre los contactos históricos de GoHighLevel para:
 * 1. Sustituir las notas antiguas "AUDITORÍA MULTI-TOUCH" por la "📌 FICHA DE INGRESO Y PERFIL DEL CLIENTE".
 * 2. Aplicar la deduplicación de ráfagas técnicas (< 15 minutos en misma sede/anuncio = un solo ingreso).
 * 3. Identificar con precisión el DOBLE INGRESO VÁLIDO:
 *    - Multiproducto (distinto anuncio/tratamiento).
 *    - Multisede independiente (Palacios Ernesto, Ultra, Benavides, Piura).
 *    - Reactivación tras tiempo prolongado (7+ días).
 * 4. Integrar estatus comercial en tiempo real:
 *    - 🛍️ CLIENTE COMPRADOR (con compras en vTiger/GHL)
 *    - 📞 PROSPECTO CALIFICADO (con teléfono para despacho)
 *    - 💬 CURIOSO (solo chat preliminar)
 * 5. Clasificar intereses clínicos (⚠️ MULTICONSULTA si pregunta por 3+ tratamientos).
 * 6. Respetar el Token Bucket Queue y el blindaje de 15 minutos de asesores activos.
 */

import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { GHL_CONFIG } from '../config/index.js';
import { processMasterContact } from '../agents/master_processor.js';
import { tokenBucketQueue } from '../services/token_bucket_queue.js';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS_CONTACTS = {
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
      const wait = 2000 * attempt;
      console.log(`\n⏳ [Rate Limit 429] Esperando ${wait / 1000}s para reanudar...`);
      await sleep(wait);
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < 5) {
      await sleep(2000);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw e;
  }
}

export async function runPeinadoNotasDobleIngreso(maxContacts = 100) {
  console.log('\n=======================================================================');
  console.log('🧹 INICIANDO PEINADO HISTÓRICO: FICHA LIMPIA Y DOBLE INGRESO');
  console.log('   Laboratorios Naturales - LOA Unified Master Engine');
  console.log('=======================================================================\n');

  const todayStr = new Date().toISOString().split('T')[0];
  const csvReportPath = path.join(process.cwd(), `reporte_doble_ingreso_${todayStr}.csv`);
  const csvHeader = 'Fecha,ID GHL,Nombre,Sede,Estatus Comercial,Tratamiento,Total Clics,Doble Ingreso,Clasificacion,Descuento Leads\n';
  fs.writeFileSync(csvReportPath, csvHeader, 'utf-8');
  console.log(`📄 Reporte CSV inicializado en: ${csvReportPath}\n`);

  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100&sortBy=date_updated&order=desc`;
  const contactsToAudit = [];

  console.log(`📥 Extrayendo contactos actualizados recientemente desde GoHighLevel (límite: ${maxContacts})...`);
  while (url && contactsToAudit.length < maxContacts) {
    try {
      const res = await fetchWithRetry(url, { headers: HEADERS_CONTACTS });
      if (res.status !== 200) {
        console.error(`Error al listar contactos: HTTP ${res.status}`);
        break;
      }

      const data = await res.json();
      const contacts = data.contacts || [];
      if (contacts.length === 0) break;

      for (const c of contacts) {
        if (contactsToAudit.length >= maxContacts) break;
        contactsToAudit.push(c);
      }

      process.stdout.write(`\r  Descargados: ${contactsToAudit.length} contactos...`);
      url = data.meta?.nextPageUrl || null;
      await sleep(150);
    } catch (e) {
      console.error('\nError en paginación de contactos:', e.message);
      break;
    }
  }

  console.log(`\n\n🎯 Total de contactos a procesar: ${contactsToAudit.length}\n`);

  let processedCount = 0;
  let doubleEntriesCount = 0;
  let singleLeadsCount = 0;
  let reentriesCount = 0;
  let buyersCount = 0;
  let qualifiedProspectsCount = 0;
  let curiousCount = 0;
  let multiconsultasCount = 0;
  let shieldedCount = 0;

  for (let i = 0; i < contactsToAudit.length; i++) {
    const c = contactsToAudit[i];
    const contactNum = i + 1;

    try {
      // Procesar a través de la cola de tasa controlada (Token Bucket)
      const res = await tokenBucketQueue.enqueue(async () => {
        return await processMasterContact(c, {
          silent: true,
          historicalSweep: true,
          forceFetchConversations: true
        });
      }, 'LOW');

      processedCount++;

      if (res && res.success) {
        const isDouble = res.touchTag === 'pauta-doble-ingreso' || (res.classificationLabel || '').includes('DOBLE INGRESO');
        const isReentry = (res.classificationLabel || '').includes('REINGRESO');
        
        if (isDouble) doubleEntriesCount++;
        else if (isReentry) reentriesCount++;
        else singleLeadsCount++;

        if ((res.classificationLabel || '').includes('COMPRADOR')) buyersCount++;
        else if (res.hasPhone) qualifiedProspectsCount++;
        else curiousCount++;

        // Registrar en CSV
        const safeName = (res.fullName || 'Sin Nombre').replace(/"/g, '""');
        const safeSede = (res.pageLabel || 'General').replace(/"/g, '""');
        const safeClass = (res.classificationLabel || 'Lead Nuevo X1').replace(/"/g, '""');
        const row = `"${todayStr}","${res.contactId}","${safeName}","${safeSede}","${res.hasPhone ? 'Con Telefono' : 'Curioso'}","${res.treatment || 'General'}",${res.totalAdClicks || 1},${isDouble ? 'SI' : 'NO'},"${safeClass}",${res.clicksToDiscount || 0}\n`;
        fs.appendFileSync(csvReportPath, row, 'utf-8');

        process.stdout.write(`\r[${contactNum}/${contactsToAudit.length}] Procesado: ${res.fullName.substring(0, 22).padEnd(22)} | Sede: ${(res.pageLabel || 'Central').substring(0, 15).padEnd(15)} | ${res.classificationLabel.substring(0, 25)}`);
      } else if (res && res.reason === 'advisor_talking_shield_active') {
        shieldedCount++;
        process.stdout.write(`\r[${contactNum}/${contactsToAudit.length}] 🛡️ Blindaje activo: Asesor en chat reciente con contacto ID: ${c.id}`);
      }
    } catch (err) {
      console.error(`\n❌ Error en contacto ${c.id}: ${err.message}`);
    }
  }

  console.log('\n\n=======================================================================');
  console.log('🎉 RESUMEN DEL PEINADO Y ACTUALIZACIÓN DE FICHAS:');
  console.log('=======================================================================');
  console.log(`👥 Total Contactos Procesados: ${processedCount}`);
  console.log(`⭐ Dobles Ingresos Válidos (Multiproducto/Multisede/Tiempo): ${doubleEntriesCount}`);
  console.log(`🟢 Leads Nuevos Únicos (X1): ${singleLeadsCount}`);
  console.log(`🟡 Reingresos Mismo Producto: ${reentriesCount}`);
  console.log(`🛡️ Contactos Protegidos por Blindaje de Asesor (15 min): ${shieldedCount}`);
  console.log(`📄 Archivo de auditoría generado: ${csvReportPath}`);
  console.log('=======================================================================\n');

  return {
    processedCount,
    doubleEntriesCount,
    singleLeadsCount,
    reentriesCount,
    shieldedCount,
    csvReportPath
  };
}

// Invocación directa por terminal
if (process.argv[1]?.includes('peinar_notas_doble_ingreso.js')) {
  const argLimit = parseInt(process.argv[2], 10) || 100;
  runPeinadoNotasDobleIngreso(argLimit).then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Error en ejecución CLI:', err);
    process.exit(1);
  });
}
