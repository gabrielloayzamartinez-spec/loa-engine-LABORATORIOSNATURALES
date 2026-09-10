import dotenv from 'dotenv';
dotenv.config();

// ==========================================
// 1. CONFIGURACIÓN DE GOHIGHLEVEL (GHL)
// ==========================================
export const GHL_CONFIG = {
  apiKey: process.env.GHL_API_KEY,
  locationId: process.env.GHL_LOCATION_ID
};

// ==========================================
// 1.5 CONFIGURACIÓN DE VTIGER CRM
// ==========================================
export const VTIGER_CONFIG = {
  url: process.env.VTIGER_URL || 'https://ventascallcenter.com',
  username: process.env.VTIGER_USERNAME || 'GABRIEL',
  accessKey: process.env.VTIGER_ACCESS_KEY || 'KkfUOi0vXW4951jm'
};

// ==========================================
// 2. CONFIGURACIÓN DE META DEVELOPER API (MAPI / CAPI)
// ==========================================
export const META_CONFIG = {
  graphApiVersion: process.env.META_API_VERSION || 'v20.0',
  appId: process.env.META_APP_ID || '',
  appSecret: process.env.META_APP_SECRET || '',
  accessToken: process.env.META_ACCESS_TOKEN || '',
  adAccountId: process.env.META_AD_ACCOUNT_ID || '',
  pixelId: process.env.META_PIXEL_ID || '',
  exclusionAudienceId: process.env.META_EXCLUSION_AUDIENCE_ID || '',
  webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || 'ghl_meta_secure_token_2026'
};

// ==========================================
// 3. DEFINICIONES DE TABLEROS DUALES EN GHL
// ==========================================
export const MASTER_PIPELINE_DEF = {
  name: "🎯 Pipeline Maestro - Call Center USA",
  stages: [
    { name: "💬 Precalificado (Sin Teléfono / En Chat)", position: 1 },
    { name: "📞 Lead Calificado (Con Teléfono / Listo para Llamar)", position: 2 },
    { name: "⏳ En Llamada / Negociación", position: 3 },
    { name: "🎉 Venta Cerrada (Ganado)", position: 4 },
    { name: "❌ No Contesta / Descalificado", position: 5 }
  ]
};

export const AUDIT_PIPELINE_DEF = {
  name: "📊 Radar de Pauta & Auditoría Multi-Touch",
  stages: [
    { name: "📥 Intake / Base Completa (Por Auditar & Distribuir)", position: 1 },
    { name: "🟢 1er Clic (Lead Nuevo / X1)", position: 2 },
    { name: "🟡 2do Clic (Reingreso / X2 - Descuento 1)", position: 3 },
    { name: "🟠 3er Clic (Reingreso / X3 - Descuento 2)", position: 4 },
    { name: "🔴 4to Clic+ (Saturación / X4+)", position: 5 }
  ]
};

// ==========================================
// 3.5. DEFINICIONES DEL PIPELINE UNIFICADO
// ==========================================
export const UNIFIED_PIPELINE_DEF = {
  name: "🚀 Embudo Comercial (Redes)",
  stages: [
    { name: "💬 Prospecto Inicial (Sin Teléfono)", position: 1 },
    { name: "📞 Contacto Capturado", position: 2 },
    { name: "⏳ Seguimiento / Negociación", position: 3 },
    { name: "🎉 Ganado (Compró)", position: 4 },
    { name: "❌ Perdido / Sin Respuesta", position: 5 }
  ]
};

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
  "718150351371765": "Laboratorios Naturales BIO",
  // PALACIOS ULTRA  
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
    id: "G1mp9WCw9jwkNhnSZ2ER",
    name: "REDES PALACIOS ERNESTO",
    email: "fb.palacios.1@gmail.com",
    pages: ["Naturales BioNatural", "Laboratorios Naturales BIO"],
    fbPageIds: ["566501466542620", "718150351371765"]
  },
  "bionatural ultra": {
    id: "mOA8p7H0G3MC0TEWrlKf",
    name: "REDES PALACIOS ULTRA",
    email: "fb.palacios.2ultra@gmail.com",
    pages: ["BioNatural - Ultra"],
    fbPageIds: ["111906554968800"]
  },
  "redes benavides 1": {
    id: "ihjnwtDWkH7mrJhSlYOa",
    name: "REDES BENAVIDES BIONATURAL",
    email: "bionatural.benavides@gmail.com",
    pages: ["Naturales Bio Corp"],
    fbPageIds: ["510617778807469"]
  },
  "redes benavides 2": {
    id: "7eU3NJ61WwG8Z1LFlJwZ",
    name: "REDES BENAVIDES 2 BIONATURAL",
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
