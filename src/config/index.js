import dotenv from 'dotenv';
dotenv.config();

import { readSecret, hasSecret, IS_PRODUCTION, STRICT_CONFIG, redact, sanitizeForLog } from './secrets.js';
import { SEDES_GATEWAY, resolveSedeContext, getGhlHeaders, getMetaConfigBySede, getActiveSedes, getOperationalSedes, getDegradedSedes, resolveSedeCustomFields, resolveSedePipeline } from './sedes_gateway.js';
import { SEDE_PIPELINES, SEDE_CUSTOM_FIELDS } from './routing_tables.js';

/**
 * ==============================================================================
 * LOA ENGINE - CONFIGURACIÓN CENTRAL (ZERO HARDCODING / FAIL-SAFE)
 * ==============================================================================
 * Toda credencial proviene de `process.env` vía `readSecret()`.
 * Sin secretos hardcodeados, sin fallbacks de tokens, sin valores por defecto
 * peligrosos. Si un secreto falta, el motor degrada la sede afectada y sigue vivo.
 * ==============================================================================
 */

// ==========================================
// 1. CONFIGURACIÓN DE GOHIGHLEVEL (GHL)
// ==========================================
// Arquitectura descentralizada: ya NO existe una cuenta central única.
// `GHL_CONFIG` es el alias de la subcuenta PRIMARIA (Palacios) que consumen los
// scripts legacy y los workers de una sola sede. Todo enrutamiento nuevo debe
// usar `resolveSedeContext()` / `getGhlHeaders({ locationId })`.
export const GHL_CONFIG = {
  apiKey: SEDES_GATEWAY.PALACIOS.ghl.apiKey,
  locationId: SEDES_GATEWAY.PALACIOS.ghl.locationId
};

// ==========================================
// 1.5 CONFIGURACIÓN DE VTIGER CRM (GROUND TRUTH - SOLO LECTURA)
// ==========================================
// ACCESO CENTRALIZADO: UNA (1) cuenta de Administrador con acceso global.
// El aislamiento multi-sede NO se hace con credenciales distintas, sino
// condicionando cada consulta por el campo nativo de sede (`cf_3451`) desde
// `src/services/vtigerClient.js`. Un solo token maestro = un solo punto que
// proteger, rotar y auditar.
export const VTIGER_CONFIG = {
  // URL y usuario no son secretos: se admiten como configuración declarativa.
  url: readSecret('VTIGER_URL'),
  username: readSecret('VTIGER_USERNAME'),
  // El access key NUNCA tiene fallback: si falta, queda vacío y la capa de
  // servicio reporta "vTiger no configurado" sin tumbar el proceso.
  accessKey: readSecret('VTIGER_ACCESS_KEY')
};

// ==========================================
// 2. CONFIGURACIÓN DE META DEVELOPER API (MAPI / CAPI)
// ==========================================
export const META_CONFIG = {
  graphApiVersion: readSecret('META_API_VERSION'),
  // Configuración legacy mono-app (compatibilidad con scripts antiguos)
  appId: readSecret('META_APP_ID'),
  appSecret: readSecret('META_APP_SECRET'),
  accessToken: readSecret('META_ACCESS_TOKEN'),
  adAccountId: readSecret('META_AD_ACCOUNT_ID'),
  pixelId: readSecret('META_PIXEL_ID'),
  exclusionAudienceId: readSecret('META_EXCLUSION_AUDIENCE_ID'),
  // Sin fallback hardcodeado: si el token no está definido, la verificación
  // del webhook falla cerrada (403) en lugar de aceptar un token público.
  webhookVerifyToken: readSecret('META_WEBHOOK_VERIFY_TOKEN')
};

// ==========================================
// 3. DEFINICIONES DE TABLEROS DUALES EN GHL
// ==========================================
export const MASTER_PIPELINE_DEF = {
  name: "Pipeline Maestro - Call Center USA",
  stages: [
    { name: "Precalificado (Sin Teléfono / En Chat)", position: 1 },
    { name: "Lead Calificado (Con Teléfono / Listo para Llamar)", position: 2 },
    { name: "En Llamada / Negociación", position: 3 },
    { name: "Venta Cerrada (Ganado)", position: 4 },
    { name: "No Contesta / Descalificado", position: 5 }
  ]
};

export const AUDIT_PIPELINE_DEF = {
  name: "Radar de Pauta & Auditoría Multi-Touch",
  stages: [
    { name: "Intake / Base Completa (Por Auditar & Distribuir)", position: 1 },
    { name: "1er Clic (Lead Nuevo / X1)", position: 2 },
    { name: "2do Clic (Reingreso / X2 - Descuento 1)", position: 3 },
    { name: "3er Clic (Reingreso / X3 - Descuento 2)", position: 4 },
    { name: "4to Clic+ (Saturación / X4+)", position: 5 }
  ]
};

// ==========================================
// 3.5. DEFINICIONES DEL PIPELINE UNIFICADO (POR SEDE, POINT-TO-POINT)
// ==========================================
/**
 * Construye el descriptor del embudo comercial de una sede a partir de la
 * tabla oficial de enrutamiento (src/config/routing_tables.js).
 * @param {'PALACIOS'|'BENAVIDES'} sedeId
 */
export function buildUnifiedPipelineDef(sedeId = 'PALACIOS') {
  const conf = SEDE_PIPELINES[String(sedeId).toUpperCase()];
  if (!conf) return null;
  return {
    name: conf.name,
    pipelineId: conf.id,
    stages: [
      { key: 'prospectoInicial', name: "Prospecto Inicial (Sin Teléfono)", id: conf.stages.prospectoInicial, position: 1 },
      { key: 'contactoCapturado', name: "Contacto Capturado", id: conf.stages.contactoCapturado, position: 2 },
      { key: 'seguimiento', name: "Seguimiento / Negociación", id: conf.stages.seguimiento, position: 3 },
      { key: 'ganado', name: "Ganado (Compró)", id: conf.stages.ganado, position: 4 },
      { key: 'perdido', name: "Perdido / Sin Respuesta", id: conf.stages.perdido, position: 5 }
    ]
  };
}

// Alias retrocompatible: descriptor de la sede primaria (Palacios).
export const UNIFIED_PIPELINE_DEF = buildUnifiedPipelineDef('PALACIOS');

// ==========================================
// 3.6. CAMPOS PERSONALIZADOS (CUSTOM FIELDS) GHL
// ==========================================
export const CUSTOM_FIELDS_DEF = [
  {
    name: "Sede Asignada",
    dataType: "SINGLE_OPTIONS",
    options: ["Palacios", "Piura", "Roosevelt", "Benavides"]
  },
  {
    name: "Estado de Compra",
    dataType: "SINGLE_OPTIONS",
    options: ["Comprador", "No Comprador"]
  },
  {
    name: "Origen Lead",
    dataType: "SINGLE_OPTIONS",
    options: ["vTiger_Antiguo", "Messenger_Nuevo", "WhatsApp_Nuevo"]
  },
  {
    name: "Ultima Interaccion",
    dataType: "DATE"
  }
];

// ==========================================
// 4. MAPEO 1:1 DE FANPAGES Y ETIQUETAS DE SEDE
// ==========================================
export const PAGE_TAG_MAP = {
  "Naturales BioNatural": "naturales bionatural",
  "Laboratorios Naturales BIO": "laboratorios naturales bio",
  "BioNatural - Ultra": "bionatural ultra",
  "Naturales Bio Corp": "naturales bio corp",
  "Bio Natural": "bio natural",
  "BioNatural Fuerza": "bionatural fuerza",
  "Bio Naturales": "bio naturales",
  "BioNatural Plus": "bionatural plus",
  "Natural Bio": "natural bio",
  "BioNatural": "bionatural"
};

// ==========================================
// 4B. MAPEO INVERSO: FACEBOOK PAGE ID → NOMBRE DE PÁGINA
// Fuente de verdad oficial 1:1 según infraestructura de sedes.
// ==========================================
export const FB_PAGE_ID_MAP = {
  // PALACIOS ERNESTO
  "566501466542620": "Naturales BioNatural",
  // PALACIOS CLICK2RING (REDES 2)
  "718150351371765": "Laboratorios Naturales BIO", // formularios -> CLICK2RING
  "111906554968800": "BioNatural - Ultra",
  // BENAVIDES 1
  "510617778807469": "Naturales Bio Corp",
  // BENAVIDES 2
  "126154270581792": "Bio Natural",
  "1147742788423762": "BioNatural Fuerza",
  // ROOSEVELT
  "568453466348355": "Bio Naturales",
  "1075001465705985": "BioNatural Plus",
  // PIURA
  "1147257965133802": "Natural Bio",
  "1057863707412893": "BioNatural"
};

// ==========================================
// 5. ASIGNACIÓN POR SEDE Y ASESORES COMERCIALES OFICIALES
// ==========================================
export const PALACIOS_USERS = {
  "naturales bionatural": {
    id: "8LuTk9jzt5BeaKLxdVru",
    name: "REDES 1 ERNESTO",
    email: "fb.palacios.1@gmail.com",
    pages: ["Naturales BioNatural"],
    fbPageIds: ["566501466542620"]
  },
  "bionatural ultra": {
    id: "RrzgEyi2VOKIJ7Tf54SR",
    name: "REDES 2 CLICK2RING",
    email: "fb.palacios.2ultra@gmail.com",
    pages: ["BioNatural - Ultra", "Laboratorios Naturales BIO"],
    fbPageIds: ["111906554968800", "718150351371765"]
  },
  "redes benavides 1": {
    id: "GLC6pCjW4oP76hcT9QuC",
    name: "REDES 1 BENAVIDES",
    email: "bionatural.benavides@gmail.com",
    pages: ["Naturales Bio Corp"],
    fbPageIds: ["510617778807469"]
  },
  "redes benavides 2": {
    id: "qicGSpBerbYnPHpXdeV2",
    name: "REDES 2 BENAVIDES",
    email: "bionatural.benavides.two@gmail.com",
    pages: ["Bio Natural", "BioNatural Fuerza"],
    fbPageIds: ["126154270581792", "1147742788423762"]
  },
  "redes roosevelt": {
    id: "nFCbXqI0h1JPg0NCMzJo",
    name: "REDES ROOSVELT BIONATURAL",
    email: "bionatural.roosevelt@gmail.com",
    pages: ["Bio Naturales", "BioNatural Plus"],
    fbPageIds: ["568453466348355", "1075001465705985"]
  },
  "redes piura": {
    id: "2vIwv7mCV1bC5ZlIBxAJ",
    name: "REDES PIURA BIONATURAL",
    email: "bionatural.piura@gmail.com",
    pages: ["Natural Bio", "BioNatural"],
    fbPageIds: ["1147257965133802", "1057863707412893"]
  }
};

// [Blindaje]: Alias de acceso directo para evitar TypeErrors
Object.defineProperty(PALACIOS_USERS, 'ernesto', {
  get: () => PALACIOS_USERS["naturales bionatural"],
  enumerable: false
});
Object.defineProperty(PALACIOS_USERS, 'ultra', {
  get: () => PALACIOS_USERS["bionatural ultra"],
  enumerable: false
});

// ==========================================
// 6. GATEWAY MULTI-SEDE ORCHESTRATOR
// ==========================================
export {
  SEDES_GATEWAY,
  resolveSedeContext,
  getGhlHeaders,
  getMetaConfigBySede,
  getActiveSedes,
  getOperationalSedes,
  getDegradedSedes,
  resolveSedeCustomFields,
  resolveSedePipeline,
  SEDE_PIPELINES,
  SEDE_CUSTOM_FIELDS,
  IS_PRODUCTION,
  STRICT_CONFIG,
  hasSecret,
  redact,
  sanitizeForLog
};
