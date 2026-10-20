import { GHL_CONFIG, SEDES_GATEWAY, resolveSedeContext, getGhlHeaders } from '../config/index.js';
import { normalizeTreatment } from '../domain/clinical_vocabulary.js';
import { recordMetaReferral } from '../services/meta_referral_store.js';

/**
 * Agente 4: Captura de Origen Publicitario en Segundo 0 (El Respaldo Clave)
 *
 * FLUJOGRAMA OPERATIVO (SEGUNDO 0-1):
 * Cuando el lead hace clic en el anuncio y abre Messenger o WhatsApp, Meta
 * dispara el webhook al motor con: page_id, PSID, ad_id (referral) y campaña.
 *
 * El Agente 4 captura el ad_id + campaña DE INMEDIATO y lo persiste en memoria
 * y estado (meta_referral_store), SIN esperar a GHL.
 *
 * Cuando GHL cree el contacto en el segundo 2-3, si la integración nativa de GHL
 * no trae el ad_id, el Router toma este respaldo clave para garantizar el 100%
 * de atribución sin demoras.
 */
export async function processAdIdCorrection(event, pageId = '') {
  try {
    let referral = event.referral;
    if (!referral && event.message?.referral) referral = event.message.referral;
    if (!referral && event.postback?.referral) referral = event.postback.referral;

    if (!referral) return; // Sin referral, nada que respaldar

    const adId = referral.ad_id || referral.adId || '';
    const refParam = referral.ref || '';
    const senderPsid = event.sender?.id || '';
    const adTitle = referral.ad_title || '';
    const source = referral.source || 'ADS';
    const type = referral.type || 'OPEN_THREAD';

    // [SEGUNDO 0 — RESPALDO INMEDIATO EN MEMORIA / ESTADO]
    const record = recordMetaReferral({
      psid: senderPsid,
      pageId,
      adId,
      ref: refParam,
      adTitle,
      source,
      type
    });

    if (record) {
      const msg = `[AGENTE_4] [RESPALDO-CAPTURADO] Ad ID: ${adId || 'N/A'} | PSID: ${senderPsid || 'N/A'} | Page: ${pageId} | Ref: ${refParam || 'N/A'}`;
      console.log(msg);
      if (global.pushLiveLog) global.pushLiveLog(msg);
    }
  } catch (err) {
    console.error('[Agente 4 Error]:', err.message);
  }
}

