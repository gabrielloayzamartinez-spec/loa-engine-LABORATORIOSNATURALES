import dotenv from 'dotenv';
dotenv.config();

import { readSecret, hasSecret, envList } from './secrets.js';
import { SEDE_PIPELINES, SEDE_CUSTOM_FIELDS } from './routing_tables.js';

/**
 * ==============================================================================
 * LOA ENGINE - MASTER MULTI-SEDE GATEWAY (ORQUESTADOR POINT-TO-POINT)
 * ==============================================================================
 * Configuración multi-tenant para las sedes de Laboratorios Naturales:
 * - PALACIOS
 * - BENAVIDES
 * - ROOSEVELT (standby)
 * - PIURA     (standby)
 *
 * ARQUITECTURA DESCENTRALIZADA (vigente):
 * Cada sede es un tentáculo hermético e independiente con su propio PIT,
 * Location ID, pipeline y custom fields. NO existe cuenta "central" ni bóveda
 * universal: el enrutamiento es estrictamente punto a punto.
 *
 * SEGURIDAD: ningún token tiene valor por defecto en el código. Si un PIT falta,
 * el valor es '' y el gateway marca la sede como `isConfigured: false`
 * (fail-safe: el proceso NO muere, la sede simplemente queda inoperativa).
 */

function buildSedeGhl(prefix) {
  return {
    apiKey: readSecret(`GHL_API_KEY_${prefix}`),
    locationId: readSecret(`GHL_LOCATION_ID_${prefix}`)
  };
}

function buildSedeMeta(prefix) {
  const adAccountIds = envList(`META_AD_ACCOUNT_IDS_${prefix}`);
  return {
    appId: readSecret(`META_APP_ID_${prefix}`),
    appSecret: readSecret(`META_APP_SECRET_${prefix}`),
    accessToken: readSecret(`META_ACCESS_TOKEN_${prefix}`),
    adAccountIds,
    adAccountId: adAccountIds[0] || readSecret(`META_AD_ACCOUNT_ID_${prefix}`)
  };
}

function isSedeConfigured(ghl) {
  return Boolean(ghl.apiKey && ghl.locationId);
}

const PALACIOS_GHL = buildSedeGhl('PALACIOS');
const BENAVIDES_GHL = buildSedeGhl('BENAVIDES');
const ROOSEVELT_GHL = buildSedeGhl('ROOSEVELT');
const PIURA_GHL = buildSedeGhl('PIURA');

export const SEDES_GATEWAY = {
  PALACIOS: {
    sedeId: 'PALACIOS',
    name: 'Laboratorios Naturales - Sede Palacios',
    vtigerSedeName: 'PALACIOS',
    isActive: true,
    isPaused: false,
    isConfigured: isSedeConfigured(PALACIOS_GHL),
    ghl: PALACIOS_GHL,
    meta: buildSedeMeta('PALACIOS'),
    pageIds: [
      '566501466542620', // Naturales BioNatural
      '718150351371765', // Laboratorios Naturales BIO
      '111906554968800'  // BioNatural - Ultra
    ],
    pipeline: SEDE_PIPELINES.PALACIOS,
    customFields: SEDE_CUSTOM_FIELDS.PALACIOS,
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
    isPaused: process.env.PAUSE_BENAVIDES === 'true',
    isConfigured: isSedeConfigured(BENAVIDES_GHL),
    ghl: BENAVIDES_GHL,
    meta: buildSedeMeta('BENAVIDES'),
    pageIds: [
      '126154270581792',  // Bio Natural (Click2Ring)
      '510617778807469',  // Naturales Bio Corp (Ernesto)
      '1147742788423762'  // BioNatural Fuerza (InHouse)
    ],
    pipeline: SEDE_PIPELINES.BENAVIDES,
    customFields: SEDE_CUSTOM_FIELDS.BENAVIDES,
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
    isConfigured: isSedeConfigured(ROOSEVELT_GHL),
    pipeline: SEDE_PIPELINES.ROOSEVELT,
    customFields: SEDE_CUSTOM_FIELDS.ROOSEVELT,
    ghl: ROOSEVELT_GHL,
    meta: buildSedeMeta('ROOSEVELT'),
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
    isConfigured: isSedeConfigured(PIURA_GHL),
    pipeline: SEDE_PIPELINES.PIURA,
    customFields: SEDE_CUSTOM_FIELDS.PIURA,
    ghl: PIURA_GHL,
    meta: buildSedeMeta('PIURA'),
    pageIds: [
      '1147257965133802', // Natural Bio
      '1057863707412893'  // BioNatural
    ],
    users: {}
  }
};

/**
 * Resuelve la configuración de sede adecuada según:
 * 1. locationId recibido en webhook o payload (coincidencia exacta)
 * 2. pageId de Facebook
 * 3. Nombre de sede explícito ('PALACIOS', 'BENAVIDES', etc.)
 *
 * MODO ESTRICTO: si el locationId NO pertenece a ninguna sede registrada,
 * se devuelve un contexto marcado con `isUnresolved: true` (fail-safe).
 * Esto evita enrutar por accidente datos de una subcuenta desconocida hacia
 * la subcuenta de Palacios.
 */
export function resolveSedeContext({ locationId = '', pageId = '', sede = '' } = {}, { strict = true } = {}) {
  // 1. Por Location ID de GHL
  if (locationId) {
    for (const conf of Object.values(SEDES_GATEWAY)) {
      if (conf.ghl.locationId && conf.ghl.locationId === locationId) {
        return conf;
      }
    }
    if (strict) {
      return {
        sedeId: 'UNRESOLVED',
        name: `Subcuenta no registrada (${locationId})`,
        isUnresolved: true,
        isActive: false,
        isPaused: false,
        isConfigured: false,
        ghl: { apiKey: '', locationId },
        meta: { appId: '', appSecret: '', accessToken: '', adAccountIds: [], adAccountId: '' },
        pageIds: [],
        pipeline: null,
        customFields: null,
        users: {}
      };
    }
  }

  // 2. Por Page ID de Facebook
  if (pageId) {
    for (const conf of Object.values(SEDES_GATEWAY)) {
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
  if (cleanSede && strict) {
    return {
      sedeId: 'UNRESOLVED',
      name: `Sede no registrada (${sede})`,
      isUnresolved: true,
      isActive: false,
      isPaused: false,
      isConfigured: false,
      ghl: { apiKey: '', locationId: '' },
      meta: { appId: '', appSecret: '', accessToken: '', adAccountIds: [], adAccountId: '' },
      pageIds: [],
      pipeline: null,
      customFields: null,
      users: {}
    };
  }

  // Fallback explícito y auditado: PALACIOS es la sede primaria operativa.
  return SEDES_GATEWAY.PALACIOS;
}

/**
 * Obtiene los headers de autorización para la API de GHL según la sede o locationId.
 * REGLA FAIL-SAFE: si la sede no tiene PIT configurado, se devuelve un header con
 * token vacío en lugar de propagar `undefined` (que rompería el parseo del cliente).
 */
export function getGhlHeaders({ locationId = '', sede = '' } = {}) {
  const conf = resolveSedeContext({ locationId, sede });
  const token = conf?.ghl?.apiKey || '';
  return {
    'Authorization': `Bearer ${token}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json'
  };
}

/**
 * Obtiene la configuración de Meta App para la sede correspondiente.
 */
export function getMetaConfigBySede({ locationId = '', pageId = '', sede = '' } = {}) {
  const conf = resolveSedeContext({ locationId, pageId, sede });
  return conf?.meta || { appId: '', appSecret: '', accessToken: '', adAccountIds: [], adAccountId: '' };
}

/**
 * Sedes activas para procesamiento de pipelines y curación.
 * Solo se consideran las que tienen credenciales cargadas (isConfigured).
 */
export function getActiveSedes() {
  return Object.values(SEDES_GATEWAY).filter(s => s.isActive && !s.isPaused);
}

/**
 * Sedes operativas: activas, no pausadas y con PIT + Location ID presentes.
 */
export function getOperationalSedes() {
  return Object.values(SEDES_GATEWAY).filter(s => s.isActive && !s.isPaused && s.isConfigured);
}

/**
 * Sedes que están encendidas por diseño pero sin credenciales cargadas.
 * Se usan para emitir WARN en el arranque sin detener el proceso.
 */
export function getDegradedSedes() {
  return Object.values(SEDES_GATEWAY).filter(s => s.isActive && !s.isConfigured);
}

/**
 * Resuelve el mapa de Custom Field IDs oficiales de la sede.
 */
export function resolveSedeCustomFields({ locationId = '', pageId = '', sede = '' } = {}) {
  const conf = resolveSedeContext({ locationId, pageId, sede });
  return conf?.customFields || SEDE_CUSTOM_FIELDS.PALACIOS;
}

/**
 * Resuelve el descriptor del pipeline y stages oficiales de la sede.
 */
export function resolveSedePipeline({ locationId = '', pageId = '', sede = '' } = {}) {
  const conf = resolveSedeContext({ locationId, pageId, sede });
  return conf?.pipeline || SEDE_PIPELINES.PALACIOS;
}

/**
 * Sedes declaradas como encendidas en el diseño (para auditoría de secretos).
 */
export function getOperationalSedeIds() {
  return Object.values(SEDES_GATEWAY).filter(s => s.isActive).map(s => s.sedeId);
}

export { hasSecret };
