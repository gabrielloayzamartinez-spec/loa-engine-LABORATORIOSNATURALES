/**
 * ==============================================================================
 * LOA ENGINE - ALMACÉN DE RESPALDO DE REFERRALS DE META (SEGUNDO 0-1)
 * ==============================================================================
 * CAPTURA EN SEGUNDO 0:
 * Cuando un usuario hace clic en un anuncio de Facebook o Instagram, Meta emite
 * un webhook con el PSID del usuario y el referral (ad_id, campaña, ref).
 *
 * Este almacén guarda en memoria instantánea (0ms) dicho referral con un TTL
 * configurable (por defecto 2 horas). Cuando GHL notifica el nuevo chat en el
 * segundo 2-3, si GHL no trae el Ad ID nativamente, el Router consulta este
 * almacén como "EL RESPALDO CLAVE".
 *
 * PERSISTENCIA:
 * Respaldo duradero en disco (`data/state_meta_referrals.json`) con escritura
 * atómica para que un reinicio de Node no pierda los leads recientes.
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const BACKUP_FILE = path.join(DATA_DIR, 'state_meta_referrals.json');
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch { /* best-effort */ }
}

// Mapa en memoria: psid -> { adId, refParam, pageId, psid, timestamp, adTitle }
const referralsByPsid = new Map();

// Mapa en memoria: pageId -> lista de { adId, refParam, pageId, psid, timestamp } (últimos 50)
const referralsByPage = new Map();

let isHydrated = false;

function hydrateFromDisk() {
  if (isHydrated) return;
  isHydrated = true;
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      const raw = fs.readFileSync(BACKUP_FILE, 'utf-8');
      const data = JSON.parse(raw);
      const now = Date.now();
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item?.psid && item.timestamp && (now - item.timestamp) < DEFAULT_TTL_MS) {
            referralsByPsid.set(String(item.psid), item);
            pushToPageMap(item);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[MetaReferralStore] [HYDRATE-WARN] ${err.message}`);
  }
}

function pushToPageMap(item) {
  if (!item?.pageId) return;
  const pageKey = String(item.pageId);
  const list = referralsByPage.get(pageKey) || [];
  list.unshift(item);
  if (list.length > 50) list.pop();
  referralsByPage.set(pageKey, list);
}

let saveTimer = null;
function persistToDisk() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      ensureDataDir();
      const now = Date.now();
      const items = [];
      for (const [psid, item] of referralsByPsid.entries()) {
        if ((now - item.timestamp) < DEFAULT_TTL_MS) {
          items.push(item);
        } else {
          referralsByPsid.delete(psid);
        }
      }
      const tmp = `${BACKUP_FILE}.tmp.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8');
      fs.renameSync(tmp, BACKUP_FILE);
    } catch (err) {
      console.warn(`[MetaReferralStore] [PERSIST-WARN] ${err.message}`);
    }
  }, 1000);
}

// Hidratar al cargar el módulo
hydrateFromDisk();

/**
 * Registra un referral capturado de Meta en Segundo 0.
 * Inmediato, sin bloqueos de red (0 ms).
 */
export function recordMetaReferral({
  psid = '',
  pageId = '',
  adId = '',
  ref = '',
  adTitle = '',
  source = '',
  type = ''
} = {}) {
  const cleanAdId = String(adId || '').trim();
  const cleanPsid = String(psid || '').trim();
  const cleanPageId = String(pageId || '').trim();

  if (!cleanAdId && !ref) return null;

  const record = {
    psid: cleanPsid,
    pageId: cleanPageId,
    adId: cleanAdId,
    ref: String(ref || '').trim(),
    adTitle: String(adTitle || '').trim(),
    source: String(source || '').trim(),
    type: String(type || '').trim(),
    timestamp: Date.now()
  };

  if (cleanPsid) {
    referralsByPsid.set(cleanPsid, record);
  }
  if (cleanPageId) {
    pushToPageMap(record);
  }

  persistToDisk();
  return record;
}

/**
 * Obtiene el referral capturado por PSID.
 */
export function getMetaReferralByPsid(psid) {
  if (!psid) return null;
  const clean = String(psid).trim();
  const record = referralsByPsid.get(clean);
  if (!record) return null;
  if ((Date.now() - record.timestamp) > DEFAULT_TTL_MS) {
    referralsByPsid.delete(clean);
    return null;
  }
  return record;
}

/**
 * Fallback: obtiene el referral más reciente capturado para una fanpage
 * dentro de una ventana máxima (por defecto 5 minutos).
 */
export function getLatestMetaReferralByPageId(pageId, maxAgeMs = 5 * 60 * 1000) {
  if (!pageId) return null;
  const list = referralsByPage.get(String(pageId));
  if (!list || list.length === 0) return null;

  const now = Date.now();
  for (const item of list) {
    if ((now - item.timestamp) <= maxAgeMs) {
      return item;
    }
  }
  return null;
}

/**
 * Retorna estadísticas actuales del almacén.
 */
export function getMetaReferralStoreStats() {
  return {
    totalPsids: referralsByPsid.size,
    pagesTracked: referralsByPage.size
  };
}
