import { GHL_CONFIG } from '../config/index.js';
import { fetchWithRetry } from '../utils/fetcher.js';
import { auditAdAttribution } from '../services/ad_attribution_engine.js';
import fs from 'fs';
import path from 'path';

const HEADERS = {
  'Authorization': `Bearer ${GHL_CONFIG.apiKey}`,
  'Version': '2021-07-28',
  'Accept': 'application/json'
};

const STATE_FILE = path.join(process.cwd(), 'src', 'workers', 'auditor_state.json');

/**
 * Escanea contactos recientes (Patrullaje Diario) y un bloque de contactos antiguos (Patrullaje Histórico).
 */
export async function runAutonomousAudit(recentLimit = 200, historyLimit = 100) {
  console.log(`\n======================================================`);
  console.log(`🤖 [AUDITOR AUTÓNOMO] Iniciando patrullaje...`);
  console.log(`======================================================\n`);

  try {
    // 1. PATRULLAJE DIARIO (Recientes)
    console.log(`[Diario] Obteniendo últimos ${recentLimit} contactos recientes...`);
    const recentUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_CONFIG.locationId}&limit=${recentLimit}`;
    const recentRes = await fetchWithRetry(recentUrl, { headers: HEADERS });
    
    let fixCountDaily = 0;
    if (recentRes.ok) {
      const data = await recentRes.json();
      const contacts = data.contacts || [];
      for (const c of contacts) {
        await new Promise(r => setTimeout(r, 400));
        try {
          await auditAdAttribution(c.id, { silent: true });
          fixCountDaily++;
        } catch (err) {}
      }
    }
    console.log(`[Diario] Completado: ${fixCountDaily} revisados.`);

    // 2. PATRULLAJE HISTÓRICO PROGRESIVO
    console.log(`\n[Histórico] Iniciando bloque histórico (hasta ${historyLimit} contactos)...`);
    let state = { nextPageUrl: null };
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }

    let historyUrl = state.nextPageUrl || `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_CONFIG.locationId}&limit=${historyLimit}`;
    
    const histRes = await fetchWithRetry(historyUrl, { headers: HEADERS });
    let fixCountHistory = 0;

    if (histRes.ok) {
      const histData = await histRes.json();
      const histContacts = histData.contacts || [];
      
      for (const c of histContacts) {
        await new Promise(r => setTimeout(r, 400));
        try {
          await auditAdAttribution(c.id, { silent: true });
          fixCountHistory++;
        } catch (err) {}
      }
      
      // Guardar el cursor para la próxima vez (dentro de 12 horas)
      state.nextPageUrl = histData.meta?.nextPageUrl || null;
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      
      if (!state.nextPageUrl) {
         console.log(`🎉 [Histórico] ¡HEMOS LLEGADO AL FINAL DE LA BASE DE DATOS! El próximo ciclo reiniciará el escaneo.`);
      } else {
         console.log(`[Histórico] Bloque procesado. Cursor guardado para la siguiente ronda.`);
      }
    }

    console.log(`\n======================================================`);
    console.log(`✅ [AUDITOR AUTÓNOMO] Misión cumplida.`);
    console.log(`   - Recientes escaneados: ${fixCountDaily}`);
    console.log(`   - Históricos escaneados: ${fixCountHistory}`);
    console.log(`======================================================\n`);

  } catch (err) {
    console.error(`[Auditor] Error crítico:`, err.message);
  }
}
