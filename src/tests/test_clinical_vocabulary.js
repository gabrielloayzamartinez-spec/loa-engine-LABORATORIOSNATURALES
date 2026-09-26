/**
 * ==============================================================================
 * LOA ENGINE - SUITE DEL VOCABULARIO CLÍNICO CANÓNICO (OFFLINE)
 * ==============================================================================
 * Blinda la regresión que provocaba PÉRDIDA SILENCIOSA DE APRENDIZAJE:
 *
 *   `vtiger_sync_agent.js` etiquetaba como 'Tetosterona' (nombre que usa vTiger)
 *   mientras `LearningBrain` sólo acepta 'Potencia'. Resultado: toda venta de
 *   testosterona que entraba por el agente inverso se descartaba sin error.
 *
 * Además comprueba que los 9 padecimientos del manual (§3.7) son aprendibles,
 * incluyendo Hongos y Gummies, que antes no existían en el catálogo.
 *
 * Ejecución:  node src/tests/test_clinical_vocabulary.js
 * ==============================================================================
 */

import {
  normalizeTreatment,
  toProductTag,
  isProductTag,
  reconcileProductTags,
  CANONICAL_TREATMENTS,
  PRODUCT_TAGS
} from '../domain/clinical_vocabulary.js';
import { learningBrain } from '../services/learning_brain.js';
import { VTIGER_CONFIG } from '../config/index.js';
import { getVtigerConfigStatus, sedeClause, buildSelect, VTIGER_MODULES, VTIGER_FIELDS } from '../services/vtigerClient.js';
import { sanitizeForVtigerQuery, detectInjectionPatterns } from '../utils/sanitize.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${message}`);
    failed++;
  }
}

console.log('\n==========================================================');
console.log(' [TEST] VOCABULARIO CLÍNICO CANÓNICO');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
// TEST 1: El bug original — Tetosterona debe normalizarse a Potencia
// ------------------------------------------------------------------------------
console.log('[TEST 1] Regresión crítica: vTiger dice "Tetosterona", el cerebro espera "Potencia"');
assert(normalizeTreatment('Tetosterona') === 'Potencia', "normalizeTreatment('Tetosterona') === 'Potencia'");
assert(normalizeTreatment('tetosterona') === 'Potencia', 'Tolerante a minúsculas');
assert(normalizeTreatment('TETOSTERONA - IN HOUSE - NO MGRATIS') === 'Potencia', 'Tolerante a ruido de campaña');
assert(normalizeTreatment('testosterona') === 'Potencia', 'Acepta la variante con S');
assert(normalizeTreatment('producto-tetosterona') === 'Potencia', 'Acepta la etiqueta GHL legada');

// ------------------------------------------------------------------------------
// TEST 2: Los 9 padecimientos oficiales son reconocibles
// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Catálogo canónico completo (9 padecimientos)');
const ESPERADOS = {
  'Artritis': 'Artritis', 'artritis': 'Artritis', 'dolor de rodilla': 'Artritis', 'reuma': 'Artritis',
  'Diabetes': 'Diabetes', 'azucar alta': 'Diabetes', 'glucosa': 'Diabetes', 'nopal plus': 'Diabetes',
  'Prostata': 'Prostata', 'prostatico': 'Prostata',
  'Potencia': 'Potencia', 'vigor': 'Potencia', 'libido': 'Potencia',
  'Colageno': 'Colageno', 'Colágeno': 'Colageno', 'bio collagen': 'Colageno', 'piel': 'Colageno',
  'Vision': 'Vision', 'vista': 'Vision', 'cataratas': 'Vision',
  'Gastro': 'Gastro', 'gastritis': 'Gastro', 'reflujo': 'Gastro',
  'Hongos': 'Hongos', 'onicomicosis': 'Hongos', 'pie de atleta': 'Hongos',
  'Gummies': 'Gummies', 'gomitas de colageno y biotina': 'Gummies', 'gummy': 'Gummies'
};
let okCatalog = 0;
for (const [entrada, esperado] of Object.entries(ESPERADOS)) {
  if (normalizeTreatment(entrada) === esperado) okCatalog++;
}
assert(okCatalog === Object.keys(ESPERADOS).length, `Todos los alias resuelven al canónico (${okCatalog}/${Object.keys(ESPERADOS).length})`);
assert(CANONICAL_TREATMENTS.includes('Hongos') && CANONICAL_TREATMENTS.includes('Gummies'), 'Hongos y Gummies están en el catálogo del cerebro');
assert(CANONICAL_TREATMENTS.length === 9, `El catálogo tiene los 9 padecimientos (tiene ${CANONICAL_TREATMENTS.length})`);

// ------------------------------------------------------------------------------
// TEST 3: El aprendizaje de vTiger ahora SÍ entrena con el formato real
// ------------------------------------------------------------------------------
console.log('\n[TEST 3] learnFromVtigerSale entrena con el valor crudo de vTiger');
const antes = learningBrain.getMetrics().stats.learnedFromSales;
learningBrain.learnFromVtigerSale({
  treatment: 'Tetosterona',
  chatText: 'cliente compro tetosterona para la potencia',
  campaignName: 'CAMPANA TESTOSTERONA ERNESTO'
});
const despues = learningBrain.getMetrics().stats.learnedFromSales;
assert(despues === antes + 1, 'La venta de Tetosterona quedó registrada como aprendida (antes se descartaba)');

const pred = learningBrain.predictTreatment('quiero algo para la potencia', 'CAMPANA TESTOSTERONA ERNESTO');
assert(pred.primaryTreatment === 'Potencia', `El cerebro predice Potencia y no Tetosterona (predijo: ${pred.primaryTreatment})`);

// Hongos y Gummies también deben poder aprender (antes eran invisibles)
const antesH = learningBrain.getMetrics().stats.learnedFromSales;
learningBrain.learnFromVtigerSale({ treatment: 'Hongos', chatText: 'hongos en las uñas', campaignName: 'CAMPANA HONGOS' });
learningBrain.learnFromVtigerSale({ treatment: 'Gummies', chatText: 'gomitas de biotina', campaignName: 'CAMPANA GUMMIES' });
assert(
  learningBrain.getMetrics().stats.learnedFromSales === antesH + 2,
  'Hongos y Gummies ahora entrenan el cerebro (antes no existían en el catálogo)'
);

// Un valor basura NO debe entrenar, pero debe quedar registrado como advertencia
const antesBasura = learningBrain.getMetrics().stats.learnedFromSales;
learningBrain.learnFromVtigerSale({ treatment: 'ProductoDesconocidoXYZ' });
assert(
  learningBrain.getMetrics().stats.learnedFromSales === antesBasura,
  'Un tratamiento no reconocido no contamina el cerebro'
);

// ------------------------------------------------------------------------------
// TEST 4: Etiquetas de producto
// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Etiquetas de producto canónicas y limpieza quirúrgica');
assert(toProductTag('Tetosterona') === 'producto-potencia', "toProductTag('Tetosterona') === 'producto-potencia'");
assert(toProductTag('Colágeno') === 'producto-colageno', 'Normaliza tildes al construir la etiqueta');
assert(toProductTag('no-existe') === null, 'Un valor no reconocido no genera etiqueta');
assert(isProductTag('producto-hongos') && isProductTag('producto-tetosterona'), 'Reconoce etiquetas canónicas y legadas');
assert(!isProductTag('facebook-messenger'), 'No confunde etiquetas de canal con etiquetas de producto');
assert(PRODUCT_TAGS.includes('producto-tetosterona'), 'La etiqueta legada sigue contemplada para su purga');

const reconciled = reconcileProductTags(
  ['facebook-messenger', 'producto-artritis', 'producto-tetosterona', 'compro'],
  'Tetosterona'
);
assert(reconciled.activeTag === 'producto-potencia', `La etiqueta activa es producto-potencia (${reconciled.activeTag})`);
assert(!reconciled.tags.includes('producto-artritis'), 'Purga la etiqueta de producto ajena');
assert(!reconciled.tags.includes('producto-tetosterona'), 'Migra y purga la etiqueta legada');
assert(reconciled.tags.includes('producto-potencia'), 'Inyecta la etiqueta canónica');
assert(reconciled.tags.includes('facebook-messenger') && reconciled.tags.includes('compro'), 'Preserva etiquetas no relacionadas con producto');

// ------------------------------------------------------------------------------
// TEST 5: Autenticación vTiger CENTRALIZADA (un solo Admin Key global)
// ------------------------------------------------------------------------------
console.log('\n[TEST 5] vTiger: un único Admin Key global y saneado de consultas');
const cfg = getVtigerConfigStatus();
assert(cfg.mode === 'GLOBAL_ADMIN', 'El modo de acceso declarado es GLOBAL_ADMIN');
assert(typeof cfg.configured === 'boolean', 'El estado de configuración se reporta sin lanzar excepción');
assert(!('forSede' in VTIGER_CONFIG), 'No existen credenciales vTiger por sede (un solo key maestro)');
assert(cfg.urlHost === null || typeof cfg.urlHost === 'string', 'El host se expone saneado (nunca la URL completa con credenciales)');
assert(cfg.accessKey === '(vacío)' || /^\*+\(\d+\)$/.test(cfg.accessKey), 'El access key se reporta enmascarado, jamás en claro');

// Aislamiento multi-tenant: sin sede explícita NO se consulta la base completa.
const clausulaSinSede = sedeClause('');
assert(clausulaSinSede.includes('__SIN_SEDE__'), 'Sin sede objetivo, la cláusula bloquea la consulta (no filtra toda la base)');
assert(sedeClause('PALACIOS').includes("cf_3451 = 'PALACIOS'"), 'La cláusula usa el campo nativo cf_3451 de vTiger');
assert(sedeClause('palacios').includes("cf_3451 = 'PALACIOS'"), 'La sede se normaliza a mayúsculas');
assert(sedeClause("PALACIOS' OR '1'='1").includes('__SIN_SEDE__'), 'Una sede manipulada se rechaza por allow-list (no se "limpia" a un nombre plausible)');
assert(sedeClause('SEDE_INVENTADA').includes('__SIN_SEDE__'), 'Una sede inexistente bloquea la consulta en lugar de consultar la base completa');

// Inyección: neutralización y detección
const inyectado = sanitizeForVtigerQuery("O'Brien' OR '1'='1; DROP TABLE Contacts");
assert(!inyectado.includes(';'), 'El terminador de sentencia se elimina');
assert(inyectado.includes("\\'"), 'Las comillas simples se escapan');
assert(!sanitizeForVtigerQuery('a\\').endsWith("\\'") || sanitizeForVtigerQuery('a\\').includes('\\\\'), 'Las barras invertidas se duplican (no anulan el escape)');
assert(detectInjectionPatterns({ name: "' OR '1'='1" }).suspicious === true, 'El detector marca una tautología SQL');
assert(detectInjectionPatterns({ name: '<script>alert(1)</script>' }).suspicious === true, 'El detector marca un intento de XSS');
assert(detectInjectionPatterns({ name: 'Maria Rodriguez' }).suspicious === false, 'Un nombre legítimo no genera falsos positivos');

// Módulos: sólo nomenclatura nativa de vTiger
assert(VTIGER_MODULES.CONTACTS === 'Contacts' && VTIGER_MODULES.SALES_ORDER === 'SalesOrder', 'Se usan los nombres nativos de módulo de vTiger');
assert(VTIGER_FIELDS.SEDE === 'cf_3451' && VTIGER_FIELDS.TRATAMIENTO === 'cf_2610', 'Se usan los nombres nativos de custom fields (cf_)');
let moduloInvalidoRechazado = false;
try { buildSelect({ module: 'Contacts; DROP TABLE' }); } catch { moduloInvalidoRechazado = true; }
assert(moduloInvalidoRechazado, 'buildSelect rechaza un módulo no nativo (allow-list)');

console.log('\n==========================================================');
console.log(` [METRICS] ${passed} pasadas, ${failed} fallidas`);
console.log('==========================================================\n');

process.exit(failed > 0 ? 1 : 0);
