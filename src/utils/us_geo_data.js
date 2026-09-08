/**
 * 🗺️ US Geographic & Area Code Inferrer (Laboratorios Naturales)
 * 
 * Permite autocompletar la sección "General Info" de GoHighLevel:
 * 1. País: Siempre "United States"
 * 2. Estado (state): Deducido por Código de Área telefónico o ZIP Code
 * 3. Zona Horaria (timezone): Deducida por Estado o Código de Área (IANA format)
 * 4. Dirección Postal (address1), Ciudad (city), Código Postal (postalCode)
 */

export const STATE_TIMEZONES = {
  // Eastern (ET)
  'CT': 'America/New_York', 'DE': 'America/New_York', 'FL': 'America/New_York',
  'GA': 'America/New_York', 'IN': 'America/Indiana/Indianapolis', 'KY': 'America/New_York',
  'ME': 'America/New_York', 'MD': 'America/New_York', 'MA': 'America/New_York',
  'MI': 'America/Detroit', 'NH': 'America/New_York', 'NJ': 'America/New_York',
  'NY': 'America/New_York', 'NC': 'America/New_York', 'OH': 'America/New_York',
  'PA': 'America/New_York', 'RI': 'America/New_York', 'SC': 'America/New_York',
  'VT': 'America/New_York', 'VA': 'America/New_York', 'WV': 'America/New_York',
  'DC': 'America/New_York',

  // Central (CT)
  'AL': 'America/Chicago', 'AR': 'America/Chicago', 'IL': 'America/Chicago',
  'IA': 'America/Chicago', 'KS': 'America/Chicago', 'LA': 'America/Chicago',
  'MN': 'America/Chicago', 'MS': 'America/Chicago', 'MO': 'America/Chicago',
  'NE': 'America/Chicago', 'ND': 'America/Chicago', 'OK': 'America/Chicago',
  'SD': 'America/Chicago', 'TN': 'America/Chicago', 'TX': 'America/Chicago',
  'WI': 'America/Chicago',

  // Mountain (MT)
  'AZ': 'America/Phoenix', 'CO': 'America/Denver', 'ID': 'America/Boise',
  'MT': 'America/Denver', 'NM': 'America/Denver', 'UT': 'America/Denver',
  'WY': 'America/Denver',

  // Pacific (PT)
  'CA': 'America/Los_Angeles', 'NV': 'America/Los_Angeles',
  'OR': 'America/Los_Angeles', 'WA': 'America/Los_Angeles',

  // Otros
  'AK': 'America/Anchorage', 'HI': 'Pacific/Honolulu', 'PR': 'America/Puerto_Rico'
};

// Diccionario de códigos de área de Estados Unidos mapeados a Estado
export const AREA_CODE_TO_STATE = {
  // Florida
  '305': 'FL', '786': 'FL', '954': 'FL', '754': 'FL', '561': 'FL', '407': 'FL', '321': 'FL',
  '813': 'FL', '727': 'FL', '239': 'FL', '352': 'FL', '904': 'FL', '850': 'FL',
  // Texas
  '210': 'TX', '214': 'TX', '254': 'TX', '281': 'TX', '325': 'TX', '361': 'TX', '409': 'TX',
  '430': 'TX', '432': 'TX', '469': 'TX', '512': 'TX', '682': 'TX', '713': 'TX', '726': 'TX',
  '737': 'TX', '806': 'TX', '817': 'TX', '830': 'TX', '832': 'TX', '903': 'TX', '915': 'TX',
  '936': 'TX', '940': 'TX', '956': 'TX', '972': 'TX', '979': 'TX',
  // California
  '209': 'CA', '213': 'CA', '279': 'CA', '310': 'CA', '323': 'CA', '408': 'CA', '415': 'CA',
  '424': 'CA', '442': 'CA', '510': 'CA', '530': 'CA', '559': 'CA', '562': 'CA', '619': 'CA',
  '626': 'CA', '628': 'CA', '650': 'CA', '657': 'CA', '661': 'CA', '669': 'CA', '707': 'CA',
  '714': 'CA', '747': 'CA', '760': 'CA', '805': 'CA', '818': 'CA', '820': 'CA', '831': 'CA',
  '858': 'CA', '909': 'CA', '916': 'CA', '925': 'CA', '949': 'CA', '951': 'CA',
  // New York
  '212': 'NY', '315': 'NY', '332': 'NY', '347': 'NY', '516': 'NY', '518': 'NY', '585': 'NY',
  '607': 'NY', '631': 'NY', '646': 'NY', '680': 'NY', '716': 'NY', '718': 'NY', '838': 'NY',
  '845': 'NY', '914': 'NY', '917': 'NY', '929': 'NY', '934': 'NY',
  // New Jersey
  '201': 'NJ', '551': 'NJ', '609': 'NJ', '640': 'NJ', '732': 'NJ', '848': 'NJ', '856': 'NJ',
  '862': 'NJ', '908': 'NJ', '973': 'NJ',
  // Illinois
  '217': 'IL', '224': 'IL', '309': 'IL', '312': 'IL', '331': 'IL', '618': 'IL', '630': 'IL',
  '708': 'IL', '773': 'IL', '779': 'IL', '815': 'IL', '847': 'IL', '872': 'IL',
  // Georgia
  '229': 'GA', '404': 'GA', '470': 'GA', '478': 'GA', '678': 'GA', '706': 'GA', '762': 'GA',
  '770': 'GA', '912': 'GA',
  // North Carolina
  '252': 'NC', '336': 'NC', '704': 'NC', '743': 'NC', '828': 'NC', '910': 'NC', '919': 'NC',
  '980': 'NC', '984': 'NC',
  // Pennsylvania
  '215': 'PA', '223': 'PA', '267': 'PA', '272': 'PA', '412': 'PA', '445': 'PA', '484': 'PA',
  '570': 'PA', '610': 'PA', '717': 'PA', '724': 'PA', '814': 'PA', '878': 'PA',
  // Arizona
  '480': 'AZ', '520': 'AZ', '602': 'AZ', '623': 'AZ', '928': 'AZ',
  // Nevada
  '702': 'NV', '725': 'NV', '775': 'NV',
  // Colorado
  '303': 'CO', '719': 'CO', '720': 'CO', '970': 'CO',
  // Washington
  '206': 'WA', '253': 'WA', '360': 'WA', '425': 'WA', '509': 'WA', '564': 'WA',
  // Massachusetts
  '339': 'MA', '351': 'MA', '413': 'MA', '508': 'MA', '617': 'MA', '774': 'MA', '781': 'MA',
  '857': 'MA', '978': 'MA',
  // Virginia
  '276': 'VA', '434': 'VA', '540': 'VA', '571': 'VA', '703': 'VA', '757': 'VA', '804': 'VA',
  // Ohio
  '216': 'OH', '220': 'OH', '234': 'OH', '283': 'OH', '330': 'OH', '380': 'OH', '419': 'OH',
  '440': 'OH', '513': 'OH', '567': 'OH', '614': 'OH', '740': 'OH', '937': 'OH',
  // Michigan
  '231': 'MI', '248': 'MI', '269': 'MI', '313': 'MI', '517': 'MI', '586': 'MI', '616': 'MI',
  '734': 'MI', '810': 'MI', '906': 'MI', '947': 'MI', '989': 'MI',
  // Indiana
  '219': 'IN', '260': 'IN', '317': 'IN', '463': 'IN', '574': 'IN', '765': 'IN', '812': 'IN', '930': 'IN',
  // Tennessee
  '423': 'TN', '615': 'TN', '629': 'TN', '731': 'TN', '865': 'TN', '901': 'TN', '931': 'TN',
  // Maryland
  '240': 'MD', '301': 'MD', '410': 'MD', '443': 'MD', '667': 'MD',
  // Missouri
  '314': 'MO', '417': 'MO', '573': 'MO', '636': 'MO', '660': 'MO', '816': 'MO',
  // Wisconsin
  '262': 'WI', '414': 'WI', '534': 'WI', '608': 'WI', '715': 'WI', '920': 'WI',
  // Minnesota
  '218': 'MN', '320': 'MN', '507': 'MN', '612': 'MN', '651': 'MN', '763': 'MN', '952': 'MN',
  // South Carolina
  '803': 'SC', '843': 'SC', '854': 'SC', '864': 'SC',
  // Alabama
  '205': 'AL', '251': 'AL', '256': 'AL', '334': 'AL', '938': 'AL',
  // Louisiana
  '225': 'LA', '318': 'LA', '337': 'LA', '504': 'LA', '985': 'LA',
  // Kentucky
  '270': 'KY', '364': 'KY', '502': 'KY', '606': 'KY', '859': 'KY',
  // Oregon
  '458': 'OR', '503': 'OR', '541': 'OR', '971': 'OR',
  // Oklahoma
  '405': 'OK', '539': 'OK', '580': 'OK', '918': 'OK',
  // Connecticut
  '203': 'CT', '475': 'CT', '860': 'CT', '959': 'CT',
  // Utah
  '385': 'UT', '435': 'UT', '801': 'UT',
  // New Mexico
  '505': 'NM', '575': 'NM',
  // Arkansas
  '479': 'AR', '501': 'AR', '870': 'AR',
  // Nevada
  '702': 'NV', '775': 'NV', '725': 'NV',
  // Kansas
  '316': 'KS', '620': 'KS', '785': 'KS', '913': 'KS',
  // Mississippi
  '228': 'MS', '601': 'MS', '662': 'MS', '769': 'MS',
  // Iowa
  '319': 'IA', '515': 'IA', '563': 'IA', '641': 'IA', '712': 'IA',
  // Nebraska
  '308': 'NE', '402': 'NE', '531': 'NE',
  // Idaho
  '208': 'ID', '986': 'ID',
  // Hawaii
  '808': 'HI',
  // Maine
  '207': 'ME',
  // New Hampshire
  '603': 'NH',
  // Rhode Island
  '401': 'RI',
  // Montana
  '406': 'MT',
  // Delaware
  '302': 'DE',
  // South Dakota
  '605': 'SD',
  // North Dakota
  '701': 'ND',
  // Alaska
  '907': 'AK',
  // Vermont
  '802': 'VT',
  // Wyoming
  '307': 'WY',
  // West Virginia
  '304': 'WV', '681': 'WV',
  // Washington DC
  '202': 'DC',
  // Puerto Rico
  '787': 'PR', '939': 'PR'
};

/**
 * Deduce Estado y Zona Horaria a partir de un teléfono de USA (+1XXXXXXXXXX)
 */
export function getGeoFromPhone(phone) {
  if (!phone) return { state: null, timezone: null, country: 'United States' };
  const clean = String(phone).replace(/\D/g, '');
  let areaCode = null;
  if (clean.length === 10 && clean[0] >= '2') {
    areaCode = clean.slice(0, 3);
  } else if (clean.length === 11 && clean[0] === '1' && clean[1] >= '2') {
    areaCode = clean.slice(1, 4);
  }

  if (!areaCode) return { state: null, timezone: null, country: 'United States' };

  const state = AREA_CODE_TO_STATE[areaCode] || null;
  const timezone = state ? STATE_TIMEZONES[state] : null;

  return {
    state,
    timezone,
    country: 'United States'
  };
}

/**
 * Deduce Estado a partir de los primeros 3 dígitos de un ZIP Code de USA
 */
export function getStateFromZip(zip) {
  if (!zip) return null;
  const num = parseInt(String(zip).slice(0, 5), 10);
  if (isNaN(num)) return null;

  if (num >= 600 && num <= 999) return 'PR';
  if (num >= 1000 && num <= 2799) return 'MA';
  if (num >= 2800 && num <= 2999) return 'RI';
  if (num >= 3000 && num <= 3899) return 'NH';
  if (num >= 3900 && num <= 4999) return 'ME';
  if (num >= 5000 && num <= 5999) return 'VT';
  if (num >= 6000 && num <= 6999) return 'CT';
  if (num >= 7000 && num <= 8999) return 'NJ';
  if (num >= 10000 && num <= 14999) return 'NY';
  if (num >= 15000 && num <= 19699) return 'PA';
  if (num >= 19700 && num <= 19999) return 'DE';
  if (num >= 20000 && num <= 20599) return 'DC';
  if (num >= 20600 && num <= 21999) return 'MD';
  if (num >= 22000 && num <= 24699) return 'VA';
  if (num >= 24700 && num <= 26999) return 'WV';
  if (num >= 27000 && num <= 28999) return 'NC';
  if (num >= 29000 && num <= 29999) return 'SC';
  if (num >= 30000 && num <= 31999) return 'GA';
  if (num >= 32000 && num <= 34999) return 'FL';
  if (num >= 35000 && num <= 36999) return 'AL';
  if (num >= 37000 && num <= 38599) return 'TN';
  if (num >= 38600 && num <= 39999) return 'MS';
  if (num >= 40000 && num <= 42799) return 'KY';
  if (num >= 43000 && num <= 45999) return 'OH';
  if (num >= 46000 && num <= 47999) return 'IN';
  if (num >= 48000 && num <= 49999) return 'MI';
  if (num >= 50000 && num <= 52999) return 'IA';
  if (num >= 53000 && num <= 54999) return 'WI';
  if (num >= 55000 && num <= 56799) return 'MN';
  if (num >= 57000 && num <= 57799) return 'SD';
  if (num >= 58000 && num <= 58899) return 'ND';
  if (num >= 59000 && num <= 59999) return 'MT';
  if (num >= 60000 && num <= 62999) return 'IL';
  if (num >= 63000 && num <= 65999) return 'MO';
  if (num >= 66000 && num <= 67999) return 'KS';
  if (num >= 68000 && num <= 69999) return 'NE';
  if (num >= 70000 && num <= 71599) return 'LA';
  if (num >= 71600 && num <= 72999) return 'AR';
  if (num >= 73000 && num <= 74999) return 'OK';
  if (num >= 75000 && num <= 79999) return 'TX';
  if (num >= 80000 && num <= 81699) return 'CO';
  if (num >= 82000 && num <= 83199) return 'WY';
  if (num >= 83200 && num <= 83999) return 'ID';
  if (num >= 84000 && num <= 84799) return 'UT';
  if (num >= 85000 && num <= 86599) return 'AZ';
  if (num >= 87000 && num <= 88499) return 'NM';
  if (num >= 88900 && num <= 89899) return 'NV';
  if (num >= 90000 && num <= 96199) return 'CA';
  if (num >= 96700 && num <= 96899) return 'HI';
  if (num >= 97000 && num <= 97999) return 'OR';
  if (num >= 98000 && num <= 99499) return 'WA';
  if (num >= 99500 && num <= 99999) return 'AK';

  return null;
}

/**
 * Parsea una dirección física de USA desglosada en:
 * { address1, city, state, postalCode, country, timezone }
 */
export function parseFullUsAddress(rawText) {
  if (!rawText) return null;

  // Filtro estricto de exclusión internacional
  const nonUsPattern = /\b(peru|perú|lima|callao|arequipa|trujillo|mexico|méxico|colombia|bogota|bogotá|medellin|medellín|argentina|chile|venezuela|ecuador|bolivia|guatemala|honduras|el salvador|españa|spain)\b/i;
  if (nonUsPattern.test(rawText)) return null;

  let address1 = null;
  let city = null;
  let state = null;
  let postalCode = null;

  // 1. Extraer ZIP code (5 dígitos)
  const zipMatch = rawText.match(/\b\d{5}(?:-\d{4})?\b/);
  if (zipMatch) {
    postalCode = zipMatch[0].slice(0, 5);
    state = getStateFromZip(postalCode);
  }

  // 2. Extraer Estado por abreviación (ej. FL, TX, CA, NY)
  const stateRegex = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR)\b/i;
  const stateMatch = rawText.match(stateRegex);
  if (stateMatch) {
    state = stateMatch[1].toUpperCase();
  }

  // 3. Extraer Calle y Número (ej. 1234 Main St, 742 Evergreen Terr Apt 4)
  const streetPattern = /\b\d{1,5}\s+[A-Za-z0-9#\s.-]+?\s+(?:street|st|avenue|ave|blvd|boulevard|drive|dr|road|rd|lane|ln|way|court|ct|circle|cir|terrace|ter|place|pl|trail|trl|parkway|pkwy|highway|hwy|suite|ste|apt|unit)\b(?:\s+(?:apt|ste|unit|#)\s*[A-Za-z0-9-]+)?/i;
  const streetMatch = rawText.match(streetPattern);
  if (streetMatch) {
    address1 = streetMatch[0].trim();
  }

  // 4. Extraer Ciudad (si está entre la calle y el estado/zip)
  if (address1 && (state || postalCode)) {
    const afterStreet = rawText.slice(rawText.indexOf(address1) + address1.length);
    const cityMatch = afterStreet.match(/^[,\s]+([A-Za-z\s]+?)(?:,\s*|\s+)(?:[A-Z]{2}|\d{5})/i);
    if (cityMatch && cityMatch[1].trim().length >= 3) {
      city = cityMatch[1].trim();
    }
  }

  if (!address1 && !postalCode) return null;

  const timezone = state ? STATE_TIMEZONES[state] : null;

  return {
    address1,
    city,
    state,
    postalCode,
    country: 'United States',
    timezone
  };
}
