/**
 * ==============================================================================
 * LOA ENGINE - FILTRO DE MENSAJES DE SISTEMA (EARLY DROP)
 * ==============================================================================
 * INCIDENTE QUE ORIGINA ESTE MÓDULO:
 * Un SMS transaccional con un código OTP de WhatsApp
 * ("Your WhatsApp code: 825-319") proveniente de +1 240-348-6504 disparó TODO el
 * pipeline del motor: creó un contacto fantasma, una Oportunidad y una Tarjeta
 * Forense con atribución publicitaria FALSA.
 *
 * REGLA: los mensajes automatizados/transaccionales (OTP, verificación, opt-out,
 * avisos de operador, plantillas de sistema) NO son leads. Se descartan con un
 * `200 OK` inmediato y NO deben tocar la base de datos ni el CRM.
 *
 * Es defensa en PROFUNDIDAD: aunque el mensaje llegue y no se detecte aquí, el
 * aprendizaje del Cerebro ya no entrena con transcripts crudos (ver
 * `LEARNING_NOISE_TERMS` en learning_brain.js).
 * ==============================================================================
 */

/**
 * Patrones de mensajes automatizados / transaccionales.
 * Se evalúan sobre el texto NORMALIZADO (sin tildes, en minúsculas).
 */
export const SYSTEM_MESSAGE_PATTERNS = [
  // --- Códigos de verificación (OTP) ---
  /\b(whatsapp|verification|security|confirmation|access|login|auth(?:entication)?)\s+code\b/,
  /\bcode\b[:\s]*\d{3,}[- ]?\d{2,}/,
  /\b\d{3}[- ]\d{3}\b.*\b(code|otp|pin)\b/,
  /\b(otp|one[-\s]?time\s?(?:password|code|pin)|codigo de verificacion|codigo de seguridad)\b/,
  /\bdo not share\b/,
  /\bno compartas?\b.*\b(codigo|code)\b/,
  /\b(tu|your)\s+(codigo|code)\s+(de\s+)?(whatsapp|verificacion|verification)\b/,

  // --- Opt-out / cumplimiento (TCPA) ---
  /\breply\s+stop\b/,
  /\btext\s+stop\b/,
  /\bstop\s+to\s+(unsubscribe|opt[-\s]?out)\b/,
  /\b(unsubscribe|opt[-\s]?out|optout)\b/,
  /^\s*(stop|baja|cancelar|salir)\s*$/,

  // --- Avisos de operador / sistema GHL-Meta ---
  /\b(msg&data rates|message and data rates|standard rates may apply)\b/,
  /\bthis (?:is )?an automated (?:message|response|system)\b/,
  /\bautomated (?:assistant|message|reply)\b/,
  /\bdelivery (?:receipt|report|failed|status)\b/,
  /\bmissed (?:call|voice ?mail)\b/,
  /\bappointment (?:reminder|confirmation)\b/,
  /\byour (?:order|package|shipment|appointment) (?:has|is|was)\b/,
  /\b(hsm|template)\s+(message|notification)\b/,
  /\bdo not reply to this (?:message|number)\b/,

  // --- Ruido de plataforma ---
  /\bopportunity (?:created|updated|moved|won|lost)\b/,
  /^\s*\[?(auditoria|audit|save process|loa engine)\]?/
];

/**
 * ¿Es un mensaje automatizado/de sistema que debe descartarse?
 *
 * Fail-safe por diseño: ante texto vacío o no concluyente devuelve `false`
 * (se procesa el lead), porque perder un lead real es peor que procesar ruido.
 * El ruido se corrige con el resto de defensas; el lead perdido no se recupera.
 *
 * @param {string} body texto del mensaje entrante
 * @returns {{ isSystem: boolean, matched: string|null }}
 */
export function detectSystemMessage(body = '') {
  const raw = String(body || '').trim();
  if (!raw) return { isSystem: false, matched: null };

  const norm = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quita tildes
    .replace(/\s+/g, ' ')
    .trim();

  for (const rx of SYSTEM_MESSAGE_PATTERNS) {
    if (rx.test(norm)) {
      return { isSystem: true, matched: rx.source.slice(0, 60) };
    }
  }

  // Regla heurística: un mensaje que es casi sólo dígitos/guiños y muy corto
  // (ej. "825-319", "123456") no es una consulta comercial.
  const digitsOnly = norm.replace(/[^0-9]/g, '');
  const alnumCount = norm.replace(/[^a-z0-9]/g, '').length;
  if (digitsOnly.length >= 4 && alnumCount > 0 && digitsOnly.length / alnumCount >= 0.7 && norm.length <= 24) {
    return { isSystem: true, matched: 'cuerpo predominantemente numérico (posible OTP/código)' };
  }

  return { isSystem: false, matched: null };
}

/** Alias booleano para uso directo en condicionales. */
export function isSystemMessage(body = '') {
  return detectSystemMessage(body).isSystem;
}

/**
 * Canal de captación a partir de los metadatos REALES del evento.
 *
 * BUG QUE CORRIGE: `resolveLeadChannel()` devolvía `'FB-MSGR'` por defecto, así
 * que un SMS nativo de Twilio/GHL se etiquetaba como Messenger y contaminaba la
 * atribución. El canal por defecto ahora es `'DESCONOCIDO'`.
 *
 * @param {object} ctx
 * @param {string} [ctx.type]        `message_type` de GHL: SMS, Email, WhatsApp, FB, IG...
 * @param {string} [ctx.source]      fuente/transport del payload
 * @param {string} [ctx.campaignName]
 * @param {boolean} [ctx.isForm]
 * @param {string|null} [ctx.formId]
 * @param {boolean} [ctx.hasMetaPage] hay `page_id`/atribución de Meta en el evento
 */
export function resolveChannelFromEvent({
  type = '',
  source = '',
  campaignName = '',
  isForm = false,
  formId = null,
  hasMetaPage = false
} = {}) {
  const t = String(type || '').toLowerCase();
  const s = String(source || '').toLowerCase();
  const c = String(campaignName || '').toUpperCase();

  if (isForm || formId || /FORMULARIO|\bFORM\b/.test(c)) return 'FORM';

  // Metadatos explícitos del transporte (máxima prioridad)
  if (/sms|twilio/.test(t) || /sms|twilio/.test(s)) return 'SMS';
  if (/whatsapp|wsp/.test(t) || /whatsapp|wsp/.test(s) || /WHATSAPP|\bWSP\b/.test(c)) return 'WHATSAPP';
  if (/email|mail/.test(t)) return 'EMAIL';
  if (/instagram|\big\b/.test(t)) return 'IG-DM';
  if (/facebook|messenger|\bfb\b/.test(t)) return 'FB-MSGR';

  // Sin transporte explícito: sólo es Messenger si hay evidencia real de Meta.
  if (hasMetaPage || /MESSENGER|FB-?MSGR/.test(c)) return 'FB-MSGR';

  return 'DESCONOCIDO';
}
