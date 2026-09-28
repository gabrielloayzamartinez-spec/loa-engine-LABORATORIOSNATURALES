/**
 * ==============================================================================
 * LOA ENGINE - SUITE DEL FILTRO DE ENTRADA Y ATRIBUCIÓN HONESTA (OFFLINE)
 * ==============================================================================
 * Blinda los 4 criterios del ticket de ingeniería "Falso Positivo en Radar de
 * Entrada" (SMS OTP que disparó todo el pipeline con atribución publicitaria falsa).
 *
 *   1. Early drop de mensajes de sistema (OTP, STOP, avisos de operador).
 *   2. Canal derivado del TRANSPORTE real (SMS != FB-MSGR) y `DESCONOCIDO` por
 *      defecto en vez de asumir Messenger.
 *   3. Triage: sin Ad ID ni dolencia identificable => `Desconocido`, sin atribuir
 *      producto ni proveedor de pauta.
 *   4. Anti-contaminación del Cerebro: el vocabulario no aprende ruido, y la
 *      memoria persistida contaminada se purga.
 *
 * Ejecución:  node src/tests/test_ingress_filter.js
 * ==============================================================================
 */

import { detectSystemMessage, isSystemMessage, resolveChannelFromEvent } from '../utils/system_message_filter.js';
import {
  normalizeTreatment, normalizeTreatmentOrUnknown, isRealTreatment,
  UNKNOWN_TREATMENT, CANONICAL_TREATMENTS
} from '../domain/clinical_vocabulary.js';
import { analyzeSymptoms, resolveLeadProvider, resolveLeadChannel, buildVtigerSource } from '../agents/nlp_symptom_engine.js';
import { learningBrain } from '../services/learning_brain.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

console.log('\n==========================================================');
console.log(' [TEST] FILTRO DE ENTRADA Y ATRIBUCION HONESTA');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
// 1. EARLY DROP: MENSAJES DE SISTEMA
// ------------------------------------------------------------------------------
console.log('[TEST 1] Early drop de mensajes automatizados/transaccionales');

// El mensaje exacto del incidente
const incidente = 'Your WhatsApp code: 825-319';
assert(detectSystemMessage(incidente).isSystem === true, `El OTP del incidente es descartado ("${incidente}")`);

const SISTEMA = [
  'Your WhatsApp code: 825-319. Do not share this code with anyone.',
  '825-319',
  '123456',
  'Reply STOP to unsubscribe',
  'MSG&DATA RATES MAY APPLY',
  'Your order has shipped',
  'This is an automated message',
  'Opportunity created',
  'Opt-out'
];
let descartados = 0;
for (const t of SISTEMA) if (isSystemMessage(t)) descartados++;
assert(descartados === SISTEMA.length, `Todos los mensajes de sistema se descartan (${descartados}/${SISTEMA.length})`);

// CRITICO: no debe haber falsos positivos con leads reales
const LEADS_REALES = [
  'Hola me interesan las gomitas de colageno y biotina',
  'MUESTRA GRATIS POTENCIA',
  'Buenas noches, cuanto cuesta el tratamiento?',
  'Quiero informacion de diabetes',
  'Me duele la rodilla, tienen algo?',
  'estoy interesada en el colageno',
  '',
  'Hola'
];
let falsosPositivos = 0;
for (const t of LEADS_REALES) if (isSystemMessage(t)) { falsosPositivos++; console.error(`      falso positivo: ${JSON.stringify(t)}`); }
assert(falsosPositivos === 0, `Ningun lead real es descartado (${LEADS_REALES.length} casos, ${falsosPositivos} falsos positivos)`);

// ------------------------------------------------------------------------------
// 2. CANAL DERIVADO DEL TRANSPORTE REAL
// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Canal: derivado del transporte, no asumido');
assert(resolveChannelFromEvent({ type: 'SMS' }) === 'SMS', 'Un mensaje SMS produce canal SMS (antes: FB-MSGR)');
assert(resolveChannelFromEvent({ type: 'TYPE_SMS' }) === 'SMS', 'El tipo compuesto de GHL (TYPE_SMS) tambien es SMS');
assert(resolveChannelFromEvent({ type: 'WhatsApp' }) === 'WHATSAPP', 'WhatsApp produce canal WHATSAPP');
assert(resolveChannelFromEvent({ type: 'Email' }) === 'EMAIL', 'Email produce canal EMAIL');
assert(resolveChannelFromEvent({ type: '', hasMetaPage: true }) === 'FB-MSGR', 'Con evidencia real de Meta si es FB-MSGR');
assert(resolveChannelFromEvent({ type: '', hasMetaPage: false }) === 'DESCONOCIDO', 'Sin transporte ni evidencia de Meta el canal es DESCONOCIDO (no se inventa)');
assert(resolveChannelFromEvent({ isForm: true }) === 'FORM', 'Un formulario produce canal FORM');
assert(resolveLeadChannel({ campaignName: 'HONGOS - BENAVIDES - FORM' }) === 'FORM', 'La deteccion por nombre de campana sigue funcionando');
assert(resolveLeadChannel({ campaignName: 'POTENCIA WHATSAPP' }) === 'WHATSAPP', 'La deteccion de WHATSAPP por campana sigue funcionando');
assert(resolveLeadChannel({}) === 'DESCONOCIDO', 'resolveLeadChannel ya no defaultea a FB-MSGR');

// ------------------------------------------------------------------------------
// 3. TRIAGE: SIN EVIDENCIA NO SE ATRIBUYE PRODUCTO
// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Triage: sin evidencia no se atribuye producto ni proveedor');
assert(UNKNOWN_TREATMENT === 'Desconocido', 'El estado de triage es "Desconocido"');
assert(normalizeTreatmentOrUnknown('') === 'Desconocido', 'Sin dolencia => Desconocido (no "General")');
assert(normalizeTreatmentOrUnknown('texto sin dolencia') === 'Desconocido', 'Texto sin dolencia => Desconocido');
assert(normalizeTreatment('General') === 'Desconocido', 'El valor legado "General" mapea al triage');
assert(isRealTreatment('Potencia') === true, 'Potencia es una dolencia comercial real');
assert(isRealTreatment('Desconocido') === false, 'Desconocido NO es una dolencia comercial');
assert(!CANONICAL_TREATMENTS.includes('Desconocido'), 'El Cerebro no aprende el estado de triage');

// El texto del OTP NO debe producir dolencia
const nlpOtp = analyzeSymptoms(incidente);
assert(nlpOtp.primaryTreatment === null, 'El OTP no produce tratamiento primario');
assert(nlpOtp.productTags.length === 0, 'El OTP no produce ninguna etiqueta de producto');

// Sin evidencia de pauta, el proveedor no debe ser un proveedor de pauta
const provSinEvidencia = resolveLeadProvider({ pageId: '', pageName: '', campaignName: '', isPaidAd: false });
assert(provSinEvidencia === 'IN_HOUSE', `Sin evidencia de pauta el proveedor es IN_HOUSE (recibido: ${provSinEvidencia})`);
const provConPauta = resolveLeadProvider({ pageId: '', pageName: '', campaignName: '', isPaidAd: true });
assert(provConPauta === 'CLICK2RING', `Un lead de pauta sin campana mapeada usa el default de pauta (recibido: ${provConPauta})`);
assert(resolveLeadProvider({ pageId: '111906554968800' }) === 'CLICK2RING', 'La matriz oficial por fanpage sigue intacta (Ultra -> CLICK2RING)');
assert(resolveLeadProvider({ pageId: '566501466542620' }) === 'ERNESTO', 'La matriz oficial por fanpage sigue intacta (Naturales BioNatural -> ERNESTO)');

// Origen final de un lead de triage
const fuentesTriage = buildVtigerSource({
  sedeName: '', campaignName: '', pageId: '',
  provider: provSinEvidencia,
  channel: resolveChannelFromEvent({ type: 'SMS' }),
  treatment: normalizeTreatmentOrUnknown('')
});
assert(fuentesTriage === 'PALACIOS-IN_HOUSE-SMS-Desconocido', `Origen honesto del lead sin clasificar (recibido: ${fuentesTriage})`);
assert(!fuentesTriage.includes('ERNESTO'), 'El origen de triage NO atribuye un proveedor de pauta (el bug original)');
assert(fuentesTriage.includes('SMS'), 'El origen de triage declara el canal real (SMS), no FB-MSGR');

// ------------------------------------------------------------------------------
// 4. ANTI-CONTAMINACION DEL CEREBRO
// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Anti-contaminacion del vocabulario del Cerebro');

// El bug: el Cerebro aprendio que "your" significaba Potencia
const vocab = learningBrain.memory.vocabularyWeights;
assert(!('your' in vocab), 'La palabra funcional "your" NO esta en el vocabulario (causa raiz del falso Potencia)');
assert(!('opportunity' in vocab), 'El ruido de plataforma "opportunity" NO esta en el vocabulario');
assert('potencia' in vocab, 'El vocabulario clinico legitimo se conserva');
assert('muestra gratis potencia' in vocab, 'Las semillas clinicas de alto valor se conservan');

// El extractor de n-gramas ya no aprende ruido
const ngramsRuido = learningBrain.extractNgrams('Your WhatsApp code 825 319 please reply', 3);
assert(!ngramsRuido.includes('your'), 'extractNgrams descarta palabras funcionales en ingles');
assert(!ngramsRuido.includes('code'), 'extractNgrams descarta ruido de plataforma');
const ngramsClinicos = learningBrain.extractNgrams('me duele la rodilla y tengo artritis', 3);
assert(ngramsClinicos.includes('rodilla') || ngramsClinicos.includes('artritis'), 'extractNgrams conserva el vocabulario clinico real');

// Un termino desconocido no contamina el catalogo
const antesAprendidas = learningBrain.getMetrics().stats.learnedFromSales;
learningBrain.learnFromVtigerSale({ treatment: 'ProductoDesconocidoXYZ' });
assert(learningBrain.getMetrics().stats.learnedFromSales === antesAprendidas, 'Un tratamiento no reconocido no entrena el Cerebro');
assert(!learningBrain.memory.treatments.includes('ProductoDesconocidoXYZ'), 'Un valor arbitrario no entra al catalogo de tratamientos');

// La prediccion ya no contamina con el OTP
const predOtp = learningBrain.predictTreatment(incidente, '', '');
assert(predOtp.primaryTreatment === null, 'El Cerebro ya no clasifica el OTP como Potencia');

console.log('\n==========================================================');
console.log(` [METRICS] ${passed} pasadas, ${failed} fallidas`);
console.log('==========================================================\n');

process.exit(failed > 0 ? 1 : 0);
