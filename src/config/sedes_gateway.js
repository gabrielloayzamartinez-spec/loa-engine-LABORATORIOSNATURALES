import dotenv from 'dotenv';
dotenv.config();

/**
 * ==============================================================================
 * LOA ENGINE - MASTER MULTI-SEDE GATEWAY (ORCHESTRATOR)
 * ==============================================================================
 * Centraliza la configuración multi-tenant para las 4 sedes de Laboratorios Naturales:
 * - PALACIOS
 * - BENAVIDES
 * - ROOSEVELT
 * - PIURA
 *
 * Permite enrutamiento dinámico de APIs de GoHighLevel, Fanpages de Meta y
 * aislamiento estricto en vTiger CRM.
 */

export const SEDES_GATEWAY = {
  PALACIOS: {
    sedeId: 'PALACIOS',
    name: 'Laboratorios Naturales - Sede Palacios',
    vtigerSedeName: 'PALACIOS',
    ghl: {
      apiKey: process.env.GHL_API_KEY_PALACIOS || process.env.GHL_API_KEY || 'pit-4d48784c-23cd-466d-a6b2-4850138e35d0',
      locationId: process.env.GHL_LOCATION_ID_PALACIOS || process.env.GHL_LOCATION_ID || 'ATPYNnsfZ1W8sd6WgWIV'
    },
    meta: {
      appId: process.env.META_APP_ID_PALACIOS || process.env.META_APP_ID || '1056780273419484',
      appSecret: process.env.META_APP_SECRET_PALACIOS || process.env.META_APP_SECRET || 'fe27d772c7fedee2e133ae4833503f6e',
      accessToken: process.env.META_ACCESS_TOKEN_PALACIOS || process.env.META_ACCESS_TOKEN || 'EAAUbkNeyC9wBSsqE4YfEZCESXQ7AnmHlAG9dZCUzgla7t7Rq2mZBcu8XmSX470oZAx0nTapXW0qWe70hw3ZBWjEP1kPgU92MCFcebQVC0OZA6W9S4ZBFA7ZBdomvg0AiXX6e8kDrVKRMlQ03r5K5sYC6G6Amh6dWHR8XZBJTDOgOqwQ5x4mgZBVZCyM203UALpHc03MfPgzYeV5coN3EPz3wyOSLTQgyKJVezgLVN7JBfi3JoT6kTBNNQZC3Hq5kVZCXatQZBLdtDU4EpLnZBpIK0tO4zAKOYEZD',
      adAccountId: process.env.META_AD_ACCOUNT_ID_PALACIOS || process.env.META_AD_ACCOUNT_ID || 'act_329247349605319'
    },
    pageIds: [
      '566501466542620', // Naturales BioNatural
      '718150351371765', // Laboratorios Naturales BIO
      '111906554968800'  // BioNatural - Ultra
    ],
    users: {
      ernesto: {
        id: 'G1mp9WCw9jwkNhnSZ2ER',
        name: 'REDES PALACIOS ERNESTO',
        email: 'fb.palacios.1@gmail.com',
        role: 'ACCOUNT-USER'
      },
      ultra: {
        id: 'mOA8p7H0G3MC0TEWrlKf',
        name: 'REDES PALACIOS ULTRA',
        email: 'fb.palacios.2ultra@gmail.com',
        role: 'ACCOUNT-USER'
      }
    }
  },

  BENAVIDES: {
    sedeId: 'BENAVIDES',
    name: 'Laboratorios Naturales - Sede Benavides',
    vtigerSedeName: 'BENAVIDES',
    ghl: {
      apiKey: process.env.GHL_API_KEY_BENAVIDES || 'pit-3e6d43f5-70f6-4b8e-ba75-04a8d05a162e',
      locationId: process.env.GHL_LOCATION_ID_BENAVIDES || ''
    },
    meta: {
      appId: process.env.META_APP_ID_BENAVIDES || '',
      appSecret: process.env.META_APP_SECRET_BENAVIDES || '',
      accessToken: process.env.META_ACCESS_TOKEN_BENAVIDES || process.env.META_ACCESS_TOKEN || 'EAAUbkNeyC9wBSsqE4YfEZCESXQ7AnmHlAG9dZCUzgla7t7Rq2mZBcu8XmSX470oZAx0nTapXW0qWe70hw3ZBWjEP1kPgU92MCFcebQVC0OZA6W9S4ZBFA7ZBdomvg0AiXX6e8kDrVKRMlQ03r5K5sYC6G6Amh6dWHR8XZBJTDOgOqwQ5x4mgZBVZCyM203UALpHc03MfPgzYeV5coN3EPz3wyOSLTQgyKJVezgLVN7JBfi3JoT6kTBNNQZC3Hq5kVZCXatQZBLdtDU4EpLnZBpIK0tO4zAKOYEZD',
      adAccountId: process.env.META_AD_ACCOUNT_ID_BENAVIDES || ''
    },
    pageIds: [
      '126154270581792',  // Bio Natural (Click2Ring)
      '510617778807469',  // Naturales Bio Corp (Ernesto)
      '1147742788423762'  // BioNatural Fuerza (InHouse)
    ],
    users: {
      redes1: {
        id: 'GLC6pCjW4oP76hcT8QuC',
        name: 'REDES 1 BENAVIDES',
        email: 'bionatural.benavides@gmail.com',
        role: 'ACCOUNT-USER'
      },
      redes2: {
        id: 'qicGSpBcrbYnPHpXceV2',
        name: 'REDES 2 BENAVIDES',
        email: 'bionatural.benavides.two@gmail.com',
        role: 'ACCOUNT-USER'
      }
    }
  },

  ROOSEVELT: {
    sedeId: 'ROOSEVELT',
    name: 'Laboratorios Naturales - Sede Roosevelt',
    vtigerSedeName: 'ROOSEVELT',
    ghl: {
      apiKey: process.env.GHL_API_KEY_ROOSEVELT || '',
      locationId: process.env.GHL_LOCATION_ID_ROOSEVELT || ''
    },
    meta: {
      appId: process.env.META_APP_ID_ROOSEVELT || '',
      appSecret: process.env.META_APP_SECRET_ROOSEVELT || '',
      accessToken: process.env.META_ACCESS_TOKEN_ROOSEVELT || process.env.META_ACCESS_TOKEN || '',
      adAccountId: process.env.META_AD_ACCOUNT_ID_ROOSEVELT || ''
    },
    pageIds: [
      '568453466348355',  // Bio Naturales
      '1075001465705985'  // BioNatural Plus
    ],
    users: {}
  },

  PIURA: {
    sedeId: 'PIURA',
    name: 'Laboratorios Naturales - Sede Piura',
    vtigerSedeName: 'PIURA',
    ghl: {
      apiKey: process.env.GHL_API_KEY_PIURA || '',
      locationId: process.env.GHL_LOCATION_ID_PIURA || ''
    },
    meta: {
      appId: process.env.META_APP_ID_PIURA || '',
      appSecret: process.env.META_APP_SECRET_PIURA || '',
      accessToken: process.env.META_ACCESS_TOKEN_PIURA || process.env.META_ACCESS_TOKEN || '',
      adAccountId: process.env.META_AD_ACCOUNT_ID_PIURA || ''
    },
    pageIds: [
      '1147257965133802', // Natural Bio
      '1057863707412893'  // BioNatural
    ],
    users: {}
  }
};

/**
 * Resuelve la configuración de sede adecuada según:
 * 1. locationId recibido en webhook o payload
 * 2. pageId de Facebook
 * 3. Nombre de sede explícito ('PALACIOS', 'BENAVIDES', etc.)
 */
export function resolveSedeContext({ locationId = '', pageId = '', sede = '' } = {}) {
  // 1. Por Location ID de GHL
  if (locationId) {
    for (const [key, conf] of Object.entries(SEDES_GATEWAY)) {
      if (conf.ghl.locationId && conf.ghl.locationId === locationId) {
        return conf;
      }
    }
  }

  // 2. Por Page ID de Facebook
  if (pageId) {
    for (const [key, conf] of Object.entries(SEDES_GATEWAY)) {
      if (conf.pageIds.includes(String(pageId))) {
        return conf;
      }
    }
  }

  // 3. Por Nombre de Sede
  const cleanSede = (sede || '').toUpperCase().trim();
  if (cleanSede && SEDES_GATEWAY[cleanSede]) {
    return SEDES_GATEWAY[cleanSede];
  }

  // Fallback seguro: PALACIOS (subcuenta principal)
  return SEDES_GATEWAY.PALACIOS;
}

/**
 * Obtiene los headers de autorización para la API de GHL según la sede o locationId
 */
export function getGhlHeaders({ locationId = '', sede = '' } = {}) {
  const conf = resolveSedeContext({ locationId, sede });
  return {
    'Authorization': `Bearer ${conf.ghl.apiKey}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json'
  };
}

/**
 * Obtiene la configuración de Meta App para la sede correspondiente
 */
export function getMetaConfigBySede({ locationId = '', pageId = '', sede = '' } = {}) {
  const conf = resolveSedeContext({ locationId, pageId, sede });
  return conf.meta;
}

