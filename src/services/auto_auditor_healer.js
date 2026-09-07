import { GHL_CONFIG, PAGE_TAG_MAP, PALACIOS_USERS } from '../config/index.js';
import { processMasterContact } from '../agents/master_processor.js';
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

async function fetchWithRetry(url, options, attempt = 1) {
  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      await sleep(1500 * attempt);
      if (attempt < 5) return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 5) {
      await sleep(1500);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

// Métricas de Auto-Corrección y Salud
export const healMetrics = {
  totalAudited: 0,
  tagsRepaired: 0,
  advisorsReassigned: 0,
  oppsCreatedOrMoved: 0,
  notesDeduplicated: 0,
  discrepanciesFixed: 0,
  lastHealRunTime: null
};

/**
 * 🛠️ AUTO-AUDITOR & SELF-HEALER CONTINUO
 * 
 * 1. Inspecciona cada contacto en GHL.
 * 2. Verifica si sus etiquetas de sede, meta y multi-touch son correctas.
 * 3. Verifica si el asesor comercial (`assignedTo`) está correctamente asignado.
 * 4. Verifica si las oportunidades en ambos tableros están en la etapa exacta.
 * 5. Corrige de forma atómica e inmediata cualquier discrepancia encontrada.
 */
export async function auditAndHealContact(contactId, options = {}) {
  try {
    const result = await processMasterContact(contactId, { silent: options.silent !== false });
    if (result && result.success) {
      healMetrics.totalAudited++;
      if (result.isMultipleClick) {
        healMetrics.discrepanciesFixed += (result.clicksToDiscount || 0);
      }
      return { success: true, healed: true, data: result };
    }
    return { success: false, reason: result?.error };
  } catch (err) {
    console.error(`[AutoHeal Error] Contacto ${contactId}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Bucle Guardián Continuo de Auto-Corrección
 */
let isAutoAuditRunning = false;
let autoAuditNextPageUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=50`;

export async function runContinuousAutoAuditCycle() {
  if (isAutoAuditRunning) return;
  isAutoAuditRunning = true;

  try {
    if (!autoAuditNextPageUrl) {
      autoAuditNextPageUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=50`;
    }

    const res = await fetchWithRetry(autoAuditNextPageUrl, { headers: HEADERS_CONTACTS });
    if (res.status === 200) {
      const data = await res.json();
      const contacts = data.contacts || [];

      const CONCURRENCY = 6;
      for (let i = 0; i < contacts.length; i += CONCURRENCY) {
        const batch = contacts.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(c => auditAndHealContact(c.id, { silent: true })));
      }

      healMetrics.lastHealRunTime = new Date().toISOString();
      autoAuditNextPageUrl = data.meta?.nextPageUrl || null;
    }
  } catch (e) {
    console.error("[AutoAudit Cycle Error]:", e.message);
  } finally {
    isAutoAuditRunning = false;
  }
}

export function getHealMetrics() {
  return healMetrics;
}
