import { GHL_CONFIG, PALACIOS_USERS } from '../config/index.js';
import { processMasterContact } from './master_processor.js';
import { routeChatByContact } from './chat_router_agent.js';
import fs from 'fs';
import path from 'path';

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

let batchRateLimitBlockedUntil = 0;

async function fetchWithRetry(url, options, attempt = 1) {
  const now = Date.now();
  if (now < batchRateLimitBlockedUntil) {
    const waitMs = batchRateLimitBlockedUntil - now;
    console.log(`[Rate-Limit Shield] 🛡️ Pausa preventiva activa. Esperando ${Math.ceil(waitMs / 1000)}s...`);
    await sleep(waitMs);
  }

  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      console.warn(`[Rate-Limit Shield] ⚠️ GHL retornó 429. Pausando peticiones durante 60 segundos...`);
      batchRateLimitBlockedUntil = Date.now() + 60000;
      await sleep(60000);
      if (attempt < 4) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 4) {
      await sleep(2000 * attempt);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

/**
 * Ejecutor Masivo Multi-Worker de Alta Velocidad (13,589 Contactos)
 */
export async function runMasterSweep(options = {}) {
  console.log("\n============================================================");
  console.log("🚀 EJECUTOR MAESTRO DE AUDITORÍA Y DISTRIBUCIÓN 1 POR 1");
  console.log("   • Análisis Forense de Mensajes, Botones y Campañas");
  console.log("   • Distribución a Columnas (Intake, X1, X2, X3, X4+)");
  console.log("   • Asignación Automática de Asesores Comerciales por Sede");
  console.log("   • Sincronización del Pipeline Comercial (Precalificado / Calificado)");
  console.log("   • Generación de Reporte CSV de Deducciones Financieras");
  console.log("============================================================\n");

  const csvFilename = `reporte_descuentos_agencia_${new Date().toISOString().split('T')[0]}.csv`;
  const csvHeaders = "Fecha Auditoria,Nombre del Lead,ID GHL,Página/Sede,Asesor Asignado,Total Toques,Leads Reales,Leads a Descontar,Clasificacion,Tiene Telefono\n";
  fs.writeFileSync(csvFilename, csvHeaders);
  console.log(`📝 Creado archivo de reporte: ${csvFilename}\n`);

  let url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100`;
  const allContacts = [];

  console.log("📥 Descargando lista completa de contactos desde GoHighLevel...");
  let pageCount = 0;
  const maxContacts = options.limit || null;

  while (url) {
    try {
      const res = await fetchWithRetry(url, { headers: HEADERS_CONTACTS });
      if (res.status !== 200) break;
      const data = await res.json();
      const contacts = data.contacts || [];
      if (contacts.length === 0) break;

      allContacts.push(...contacts);
      pageCount++;
      process.stdout.write(`\rDescargados: ${allContacts.length} contactos (Página ${pageCount})...`);

      if (maxContacts && allContacts.length >= maxContacts) {
        allContacts.splice(maxContacts);
        break;
      }

      url = data.meta?.nextPageUrl || null;
      await sleep(50);
    } catch (e) {
      console.error("\nError obteniendo contactos:", e.message);
      break;
    }
  }

  console.log(`\n\n📊 Total de contactos a auditar y distribuir: ${allContacts.length}\n`);

  let totalProcessed = 0;
  let countIntake = 0;
  let countX1 = 0;
  let countX2 = 0;
  let countX3 = 0;
  let countX4Plus = 0;
  let totalClicksDiscountable = 0;
  let precalificadosCount = 0;
  let calificadosCount = 0;

  // Procesamiento concurrente de 12 trabajadores simultáneos
  const CONCURRENCY = 12;
  const startTime = Date.now();

  for (let i = 0; i < allContacts.length; i += CONCURRENCY) {
    const batch = allContacts.slice(i, i + CONCURRENCY);
    
    await Promise.all(batch.map(async (c) => {
      const res = await processMasterContact(c, { silent: true });
      if (res && res.success) {
        totalProcessed++;
        if (res.hasPhone) calificadosCount++;
        else precalificadosCount++;

        if (res.totalAdClicks === 0) {
          countIntake++;
        } else if (res.totalAdClicks === 1) {
          countX1++;
        } else if (res.totalAdClicks === 2) {
          countX2++;
          totalClicksDiscountable += 1;
        } else if (res.totalAdClicks === 3) {
          countX3++;
          totalClicksDiscountable += 2;
        } else if (res.totalAdClicks >= 4) {
          countX4Plus++;
          totalClicksDiscountable += (res.clicksToDiscount || 0);
        }

        if (res.totalAdClicks > 0) {
          const dateStr = new Date().toLocaleDateString('es-ES');
          const csvRow = `"${dateStr}","${res.fullName}","${res.contactId}","${res.pageLabel}","${res.advisorName || 'Sin Asesor'}",${res.totalAdClicks},1,${res.clicksToDiscount},"${res.classificationLabel}","${res.hasPhone ? 'SÍ' : 'NO'}"\n`;
          fs.appendFileSync(csvFilename, csvRow);
        }
      }
    }));

    const progress = Math.min(i + CONCURRENCY, allContacts.length);
    const percent = ((progress / allContacts.length) * 100).toFixed(1);
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);

    if (progress % 50 === 0 || progress === allContacts.length) {
      console.log(`[PROGRESO ${percent}%] ${progress}/${allContacts.length} auditados (${elapsedSec}s) | 📥 Intake: ${countIntake} | 🟢 X1: ${countX1} | 🟡 X2: ${countX2} | 🟠 X3: ${countX3} | 🔴 X4+: ${countX4Plus} | 💰 Descuentos: ${totalClicksDiscountable} leads | 📞 Calificados: ${calificadosCount}...`);
    }
    await sleep(120);
  }

  console.log(`\n============================================================`);
  console.log(`🎉 AUDITORÍA Y DISTRIBUCIÓN MAESTRA 100% COMPLETADA:`);
  console.log(`============================================================`);
  console.log(`👥 Total Contactos Procesados: ${totalProcessed}`);
  console.log(`📥 Base General / Orgánicos (Intake): ${countIntake}`);
  console.log(`🟢 Leads Nuevos Únicos (X1): ${countX1}`);
  console.log(`🟡 Reingresos X2 (Desc. 1): ${countX2}`);
  console.log(`🟠 Reingresos X3 (Desc. 2): ${countX3}`);
  console.log(`🔴 Saturación X4+ (Desc. 3+): ${countX4Plus}`);
  console.log(`📞 Pipeline Comercial: Calificados con Tel: ${calificadosCount} | Precalificados Chat: ${precalificadosCount}`);
  console.log(`💰 TOTAL LEADS A DESCONTAR A LA AGENCIA: ${totalClicksDiscountable} leads`);
  console.log(`📄 Reporte CSV consolidado en: ${csvFilename}`);
  console.log(`============================================================\n`);
}

/**
 * Agente 2: Barrido Prioritario de Bandejas No Leídas (Con Rate-Limit Shield)
 * Audita y depura de forma protegida los ~1,133 chats vivos que ven los vendedores hoy.
 */
export async function runPriorityUnreadSweep() {
  console.log("\n============================================================");
  console.log("🛡️ [AGENTE 2] INICIANDO BARRIDO PRIORITARIO CON RATE-LIMIT SHIELD");
  console.log("   • Objetivo: Limpiar y reasignar bandejas vivas (chats no leídos)");
  console.log("   • Cadencia protegida: ~3 llamadas/seg (Pausa 300ms entre chats)");
  console.log("   • Escritura atómica: Sede + Tags + Ad ID + Tratamiento en 1 PUT");
  console.log("============================================================\n");

  const order = [
    "naturales bionatural", // Palacios Ernesto
    "redes benavides 1",    // Benavides 1
    "redes benavides 2",    // Benavides 2
    "redes roosevelt",      // Roosevelt
    "redes piura",          // Piura
    "bionatural ultra"      // Palacios Ultra
  ];

  let grandTotalAudited = 0;

  for (const key of order) {
    const advisor = PALACIOS_USERS[key];
    if (!advisor) continue;

    console.log(`\n🔍 [Agente 2] Auditando bandeja de: ${advisor.name}...`);
    let advisorAudited = 0;
    let page = 1;

    while (true) {
      const url = `https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&assignedTo=${advisor.id}&status=unread&limit=50`;
      const res = await fetchWithRetry(url, { headers: HEADERS_CONTACTS });
      if (res.status !== 200) break;

      const data = await res.json();
      const convs = data.conversations || [];
      if (convs.length === 0) {
        console.log(`✅ Bandeja de ${advisor.name} al día.`);
        break;
      }

      console.log(`📦 Página ${page}: Procesando ${convs.length} chats no leídos de ${advisor.name}...`);

      for (const c of convs) {
        if (!c.contactId) continue;
        advisorAudited++;
        grandTotalAudited++;

        // Ejecutar enrutamiento e hidratación inteligente (Agente 3 & 4)
        await routeChatByContact(c.contactId);

        // Rate-Limit Shield: 300ms de pausa estricta (máximo 3.3 req/seg)
        await sleep(300);
      }

      page++;
      // Chequear restantes en tiempo real
      await sleep(500);
      const checkRes = await fetchWithRetry(`https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&assignedTo=${advisor.id}&status=unread&limit=1`, { headers: HEADERS_CONTACTS });
      if (checkRes.status === 200) {
        const checkData = await checkRes.json();
        const remaining = checkData.total || 0;
        console.log(`📊 Restantes no leídos en ${advisor.name}: ${remaining}`);
        if (remaining === 0 || advisorAudited >= 400) break;
      } else {
        break;
      }
    }
  }

  console.log("\n============================================================");
  console.log(`🎉 [AGENTE 2] BARRIDO PRIORITARIO DE BANDEJAS COMPLETADO`);
  console.log(`   • Total de conversaciones auditadas y curadas: ${grandTotalAudited}`);
  console.log("============================================================\n");
}

// Ejecución directa si se invoca por CLI
if (process.argv[1] && process.argv[1].endsWith('master_batch_runner.js')) {
  if (process.argv.includes('--priority') || process.argv.includes('--unread')) {
    runPriorityUnreadSweep();
  } else {
    const argLimit = parseInt(process.argv[2]) || null;
    runMasterSweep({ limit: argLimit });
  }
}
