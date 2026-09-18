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
    isActive: true,
    ghl: {
      apiKey: process.env.GHL_API_KEY_PALACIOS || process.env.GHL_API_KEY || 'pit-8148816f-fe78-4db8-9b5c-7c6713284b0e',
      locationId: process.env.GHL_LOCATION_ID_PALACIOS || process.env.GHL_LOCATION_ID || '5NqOaPYqWyIw2FPBfoRg'
    },
    meta: {
      appId: process.env.META_APP_ID_PALACIOS || '',
      appSecret: process.env.META_APP_SECRET_PALACIOS || '',
      accessToken: process.env.META_ACCESS_TOKEN_PALACIOS || '',
      adAccountIds: (process.env.META_AD_ACCOUNT_IDS_PALACIOS || process.env.META_AD_ACCOUNT_ID_PALACIOS || '')
        .split(',').map(s => s.trim()).filter(Boolean),
      adAccountId: process.env.META_AD_ACCOUNT_ID_PALACIOS || (process.env.META_AD_ACCOUNT_IDS_PALACIOS || '').split(',')[0]?.trim() || ''
    },
    pageIds: [
      '566501466542620', // Naturales BioNatural
      '718150351371765', // Laboratorios Naturales BIO
      '111906554968800'  // BioNatural - Ultra
    ],
    pipeline: {
      id: 'YCZePq7oBz7XREDAPtsj', // 🚀 Embudo Comercial (Redes - Palacios)
      stages: {
        prospectoInicial: '46b85935-c0cc-454c-9c09-9740d8c8f30a',
        contactoCapturado: '43b410a2-cb31-492c-bbe7-9e40c9251884',
        seguimiento: 'e574b419-25cb-40fc-9a93-75b3f4502d52',
        ganado: '5b0ca386-1c01-45ec-a531-6e235c0d8305',
        perdido: 'c19ea2ef-2c74-4779-941b-6405ba21ff48'
      }
    },
    customFields: {
      idAnuncio: 'NR0eI8a2EvugkHhpRJ1w',
      adIdAlt: 'PUUykPTCijq7rZoLYwAD',
      tratamientoComprado: '5Sci2WhOpJq9kZWsLTrp',
      utmCampaign: '0VEvRUhcoN8o5YiaLAkG',
      utmSource: '7BnlWDntf3bYBBRJNszD',
      utmMedium: 'G7Mxwp38qS1pKcE80iOY',
      utmContent: 'RV3opVc8o1I7rCnQZnhS',
      utmTerm: 'Mwi6muWBiOMnM6m9FMdZ',
      adsetId: 'jmH0CYynvNBMOxKfBbsN',
      sedeAsignada: 'AXACVLFNsTOEzanAHCdf',
      origenLead: '4mOsSGfHcGMJkoWUWlyX',
      tieneTelefono: 'SMAiwKnSvPHWguEbOQxX',
      ultimaInteraccion: 'qX4hJ8L9ul3tXFsBdp6m',
      estadoComercial: 'NQGDs2mWeIjH3iGhSK9u',
      statusContacto: 'G0E9a8RExcUgFbqJO2gF',
      fechaAsignacion: '0FZcDJLkOPhcpqHAsEdF',
      fechaCompra: 'sil3rY9lmRVfCHdQ3tGP',
      fechaPrimeraCompra: 'RqSVtgzyVBZPUB2cXrJk',
      fechaUltimaCompra: 'zfamE9R79cBBBN1G5Skq',
      fechaUltimaFactura: 'heHOec7RMVJ9MRFJ1Z9H',
      precioVenta: 'FJvzBM7KriNIBgA8zvqS',
      numCompras: 'fy6i5hdHG21jYFlUVWtL',
      estadoCompraLista: 'mX7qu8FLS7Qv1BuLKlhb',
      sedeTiendaCompra: 'aE5sCUO8LH7TZD961J17',
      anotacionesRedes: 'rmr5DruA5Jxh7ENERilB',
      canalCaptacion: 'vl6ca0ODB0VILwMnfPqn',
      contactNo: 'FjldqW9y3ZVbZU02D6Yb',
      idCliente: 'M734HXzYwihdi01GhBwO',
      historialCompleto: 'T3jzpe1j65tDGXLfQNrM'
    },
    users: {
      ernesto: {
        id: '8LuTk9jzt5BeaKLxdVru',
        name: 'REDES 1 ERNESTO',
        email: 'fb.palacios.1@gmail.com',
        role: 'ACCOUNT-USER'
      },
      ultra: {
        id: 'RrzgEyi2VOKIJ7Tf54SR',
        name: 'REDES 2 CLICK2RING',
        email: 'fb.palacios.2ultra@gmail.com',
        role: 'ACCOUNT-USER'
      },
      click2ring: {
        id: 'RrzgEyi2VOKIJ7Tf54SR',
        name: 'REDES 2 CLICK2RING',
        email: 'fb.palacios.2ultra@gmail.com',
        role: 'ACCOUNT-USER'
      }
    }
  },

  BENAVIDES: {
    sedeId: 'BENAVIDES',
    name: 'Laboratorios Naturales - Sede Benavides',
    vtigerSedeName: 'BENAVIDES',
    isActive: true,
    ghl: {
      apiKey: process.env.GHL_API_KEY_BENAVIDES || '',
      locationId: process.env.GHL_LOCATION_ID_BENAVIDES || 'QXcNBK6XCgpQaZ81Z8pv'
    },
    meta: {
      appId: process.env.META_APP_ID_BENAVIDES || '',
      appSecret: process.env.META_APP_SECRET_BENAVIDES || '',
      accessToken: process.env.META_ACCESS_TOKEN_BENAVIDES || '',
      adAccountIds: (process.env.META_AD_ACCOUNT_IDS_BENAVIDES || process.env.META_AD_ACCOUNT_ID_BENAVIDES || '')
        .split(',').map(s => s.trim()).filter(Boolean),
      adAccountId: process.env.META_AD_ACCOUNT_ID_BENAVIDES || (process.env.META_AD_ACCOUNT_IDS_BENAVIDES || '').split(',')[0]?.trim() || ''
    },
    pageIds: [
      '126154270581792',  // Bio Natural (Click2Ring)
      '510617778807469',  // Naturales Bio Corp (Ernesto)
      '1147742788423762'  // BioNatural Fuerza (InHouse)
    ],
    pipeline: {
      id: 'Dv8kOeJvsMs9WMyTJAfD', // 🚀 Embudo Comercial (Redes - Benavides)
      stages: {
        prospectoInicial: 'e93516ad-bbac-48cf-9f31-6d4aa0715e1e',
        contactoCapturado: 'c5dfcdf8-3ab3-43d2-8c33-6f5396bbd223',
        seguimiento: '0fc0152e-3a68-4fb4-9434-eb2d279c709e',
        ganado: 'baf424a2-0a06-4b6f-affb-216ee1d27786',
        perdido: '686c258d-4b5d-4b5d-ba11-e4456c995c7a'
      }
    },
    customFields: {
      idAnuncio: 'bjIdaPk0dzyuNw0RCMwn',
      adIdAlt: 'xYgC0RFCZZ1GagK2aaXu',
      tratamientoComprado: 'xqDD056VzkFTOxHniDkw',
      utmCampaign: 'o5AQRN1o7qkhSomgYiaG',
      utmSource: 'yAi98DhTmnBuHppg9Taj',
      utmMedium: 'XwjFGpmds9nvS3e45P5c',
      utmContent: 'a8zymCz1usSfr8kxiNYq',
      utmTerm: 'tWGsiDXWU8EXNHGNT1po',
      adsetId: 'PS7wvoCZg8bslRRjoZCr',
      sedeAsignada: 'HJLN7LVvZHVX2Rr7eJma',
      origenLead: 'Vw6usJnpwuBScBm4yiSY',
      tieneTelefono: '0PvAaqJs7aERycth9mKW',
      ultimaInteraccion: 'V9bkHHckMsmeC698i1kr',
      estadoComercial: 'FZTDnqeUyPaRHORQtpEc',
      statusContacto: 'BcIQ4ABU1Z98P4QNqWuA',
      fechaAsignacion: 'tODtNHiDxM2bhGHMUfwI',
      fechaCompra: 'DBu8OOmAavc1LXWtyAx2',
      fechaPrimeraCompra: 'bZIdwWfU8WKD7Hz3pnqn',
      fechaUltimaCompra: 'gTpgIitRchybSigsJtwv',
      fechaUltimaFactura: 'YjxZgQh97PoX8vrud6l3',
      precioVenta: 'rfxEsUUqXIbq3i0vki3q',
      numCompras: '43IIRmrsIAyvrXOCvJwe',
      estadoCompraLista: 'aG6nDjQKvXob6apsWaB2',
      sedeTiendaCompra: 'W12pi3cD5ZbY8R2NqlwL',
      anotacionesRedes: 'Jun1LzYK7Y11yhCD6Ift',
      canalCaptacion: 'vsq2yFqYfKgcqaHu5bwi',
      contactNo: 'qwtO252zF8ZPnsfuyrE9',
      idCliente: 'wbI32mOZbUg2Mmd9RihL',
      historialCompleto: 'cZZF2iWCedZpfD8kqR16'
    },
    users: {
      redes1: {
        id: 'GLC6pCjW4oP76hcT9QuC',
        name: 'REDES 1 BENAVIDES',
        email: 'bionatural.benavides@gmail.com',
        role: 'ACCOUNT-USER'
      },
      redes2: {
        id: 'qicGSpBerbYnPHpXdeV2',
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
    isActive: false,
    pipeline: null,
    customFields: null,
    ghl: {
      apiKey: process.env.GHL_API_KEY_ROOSEVELT || '',
      locationId: process.env.GHL_LOCATION_ID_ROOSEVELT || ''
    },
    meta: {
      appId: process.env.META_APP_ID_ROOSEVELT || '',
      appSecret: process.env.META_APP_SECRET_ROOSEVELT || '',
      accessToken: process.env.META_ACCESS_TOKEN_ROOSEVELT || '',
      adAccountIds: (process.env.META_AD_ACCOUNT_IDS_ROOSEVELT || process.env.META_AD_ACCOUNT_ID_ROOSEVELT || '')
        .split(',').map(s => s.trim()).filter(Boolean),
      adAccountId: process.env.META_AD_ACCOUNT_ID_ROOSEVELT || (process.env.META_AD_ACCOUNT_IDS_ROOSEVELT || '').split(',')[0]?.trim() || ''
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
    isActive: false,
    pipeline: null,
    customFields: null,
    ghl: {
      apiKey: process.env.GHL_API_KEY_PIURA || '',
      locationId: process.env.GHL_LOCATION_ID_PIURA || ''
    },
    meta: {
      appId: process.env.META_APP_ID_PIURA || '',
      appSecret: process.env.META_APP_SECRET_PIURA || '',
      accessToken: process.env.META_ACCESS_TOKEN_PIURA || '',
      adAccountIds: (process.env.META_AD_ACCOUNT_IDS_PIURA || process.env.META_AD_ACCOUNT_ID_PIURA || '')
        .split(',').map(s => s.trim()).filter(Boolean),
      adAccountId: process.env.META_AD_ACCOUNT_ID_PIURA || (process.env.META_AD_ACCOUNT_IDS_PIURA || '').split(',')[0]?.trim() || ''
    },
    pageIds: [
      '1147257965133802', // Natural Bio
      '1057863707412893'  // BioNatural
    ],
    users: {}
  },

  CENTRAL: {
    sedeId: 'CENTRAL',
    name: 'Laboratorios Naturales - Cuenta Central Universal (Bóveda)',
    vtigerSedeName: 'CENTRAL',
    isUniversalCentral: true,
    allowActiveRouting: false,
    isActive: false,
    pipeline: null,
    customFields: null,
    ghl: {
      apiKey: process.env.GHL_API_KEY_CENTRAL || 'pit-4d48784c-23cd-466d-a6b2-4850138e35d0',
      locationId: process.env.GHL_LOCATION_ID_CENTRAL || 'ATPYNnsfZ1W8sd6WgWIV'
    },
    meta: {
      appId: process.env.META_APP_ID_PALACIOS || '',
      appSecret: process.env.META_APP_SECRET_PALACIOS || '',
      accessToken: process.env.META_ACCESS_TOKEN_PALACIOS || '',
      adAccountIds: [],
      adAccountId: ''
    },
    pageIds: [],
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

/**
 * Obtiene todas las sedes activas para procesamiento de pipelines y curación
 */
export function getActiveSedes() {
  return Object.values(SEDES_GATEWAY).filter(s => s.isActive && !s.isUniversalCentral);
}

/**
 * Resuelve el mapa de Custom Field IDs oficiales de la sede
 */
export function resolveSedeCustomFields({ locationId = '', pageId = '', sede = '' } = {}) {
  const conf = resolveSedeContext({ locationId, pageId, sede });
  return conf?.customFields || SEDES_GATEWAY.PALACIOS.customFields;
}

/**
 * Resuelve el descriptor del pipeline y stages oficiales de la sede
 */
export function resolveSedePipeline({ locationId = '', pageId = '', sede = '' } = {}) {
  const conf = resolveSedeContext({ locationId, pageId, sede });
  return conf?.pipeline || SEDES_GATEWAY.PALACIOS.pipeline;
}

