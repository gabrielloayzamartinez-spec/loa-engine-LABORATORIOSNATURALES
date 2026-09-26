/**
 * ==============================================================================
 * LOA ENGINE - TABLAS DE ENRUTAMIENTO PUNTO A PUNTO (POINT-TO-POINT)
 * ==============================================================================
 * ARQUITECTURA DESCENTRALIZADA: aquí vive el mapa de pipelines, etapas y
 * Custom Field IDs de cada sede. Ningún middleware, router o agente debe
 * contener IDs de GHL hardcodeados: todos importan desde este módulo.
 *
 * NOTA DE SEGURIDAD: estos identificadores son metadatos operativos (no tokens).
 * Los secretos viven exclusivamente en src/config/secrets.js + process.env.
 * ==============================================================================
 */

// ------------------------------------------------------------------------------
// PIPELINES OFICIALES POR SEDE
// ------------------------------------------------------------------------------
export const SEDE_PIPELINES = {
  PALACIOS: {
    id: 'YCZePq7oBz7XREDAPtsj',
    name: 'Embudo Comercial (Redes - Palacios)',
    stages: {
      prospectoInicial: '46b85935-c0cc-454c-9c09-9740d8c8f30a',
      contactoCapturado: '43b410a2-cb31-492c-bbe7-9e40c9251884',
      seguimiento: 'e574b419-25cb-40fc-9a93-75b3f4502d52',
      ganado: '5b0ca386-1c01-45ec-a531-6e235c0d8305',
      perdido: 'c19ea2ef-2c74-4779-941b-6405ba21ff48'
    }
  },
  BENAVIDES: {
    id: 'Dv8kOeJvsMs9WMyTJAfD',
    name: 'Embudo Comercial (Redes - Benavides)',
    stages: {
      prospectoInicial: 'e93516ad-bbac-48cf-9f31-6d4aa0715e1e',
      contactoCapturado: 'c5dfcdf8-3ab3-43d2-8c33-6f5396bbd223',
      seguimiento: '0fc0152e-3a68-4fb4-9434-eb2d279c709e',
      ganado: 'baf424a2-0a06-4b6f-affb-216ee1d27786',
      perdido: '686c258d-4b5d-4b5d-ba11-e4456c995c7a'
    }
  },
  // Sedes en standby: sin pipeline activo hasta su encendido formal.
  ROOSEVELT: null,
  PIURA: null
};

export const OFFICIAL_CUSTOM_FIELD_KEYS = [
  'idAnuncio', 'adIdAlt', 'tratamientoComprado',
  'utmCampaign', 'utmSource', 'utmMedium', 'utmContent', 'utmTerm', 'adsetId',
  'sedeAsignada', 'origenLead', 'tieneTelefono', 'ultimaInteraccion',
  'estadoComercial', 'statusContacto',
  'fechaAsignacion', 'fechaCompra', 'fechaPrimeraCompra', 'fechaUltimaCompra', 'fechaUltimaFactura',
  'precioVenta', 'numCompras', 'estadoCompraLista', 'sedeTiendaCompra',
  'anotacionesRedes', 'canalCaptacion', 'contactNo', 'idCliente', 'historialCompleto'
];

// ------------------------------------------------------------------------------
// CUSTOM FIELDS OFICIALES POR SEDE (29 llaves simétricas 1:1)
// ------------------------------------------------------------------------------
export const SEDE_CUSTOM_FIELDS = {
  PALACIOS: {
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
  BENAVIDES: {
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
  ROOSEVELT: null,
  PIURA: null
};

// ------------------------------------------------------------------------------
// CANAL DE ORIGEN → ETIQUETA COMERCIAL
// ------------------------------------------------------------------------------
export const ORIGEN_LEAD_OPTIONS = ['vTiger_Antiguo', 'Messenger_Nuevo', 'WhatsApp_Nuevo'];
