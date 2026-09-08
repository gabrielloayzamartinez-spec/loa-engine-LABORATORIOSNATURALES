/**
 * 🧪 PRE-FLIGHT SANITY CHECK & REGRESSION TEST (Laboratorios Naturales)
 * Valida automáticamente antes de iniciar el servidor o hacer despliegue:
 * 1. Clasificación correcta de pauta (Potencia, Colágeno, Diabetes, etc.) sin falsos Artritis.
 * 2. Atribución estricta CLICK2RING vs IN_HOUSE.
 * 3. Prohibición de nombres de tratamiento truncados (como '-Ar').
 * 4. Inferencia geográfica desde teléfonos de USA.
 */

import { analyzeSymptoms, inferTreatmentFromCampaignOrUtm, buildVtigerSource, extractShippingData } from '../agents/nlp_symptom_engine.js';
import { learningBrain } from '../services/learning_brain.js';

export function runPreFlightSanityCheck() {
  const tests = [
    {
      name: 'Regla 1: "MUESTRA GRATIS POTENCIA" debe inferir Potencia (No Artritis)',
      run: () => {
        const res = analyzeSymptoms('MUESTRA GRATIS POTENCIA');
        if (res.primaryTreatment !== 'Potencia') {
          throw new Error(`Esperado 'Potencia', recibido '${res.primaryTreatment}'`);
        }
        if (res.productTags.includes('producto-artritis')) {
          throw new Error(`No debe incluir 'producto-artritis'`);
        }
      }
    },
    {
      name: 'Regla 2: "MUESTRA GRATIS GLUCOSA" debe inferir Diabetes',
      run: () => {
        const res = analyzeSymptoms('MUESTRA GRATIS GLUCOSA');
        if (res.primaryTreatment !== 'Diabetes') {
          throw new Error(`Esperado 'Diabetes', recibido '${res.primaryTreatment}'`);
        }
      }
    },
    {
      name: 'Regla 3: UTM "DOMINGOS - COLÁGENO" debe inferir Colageno',
      run: () => {
        const res = inferTreatmentFromCampaignOrUtm('DOMINGOS - COLÁGENO - 9am a 3pm - 150');
        if (res !== 'Colageno') {
          throw new Error(`Esperado 'Colageno', recibido '${res}'`);
        }
      }
    },
    {
      name: 'Regla 4: Fuente estructurada para pauta debe ser CLICK2RING',
      run: () => {
        const source = buildVtigerSource({
          sedeName: 'Naturales BioNatural',
          provider: 'CLICK2RING',
          channel: 'FB-MSGR',
          treatment: 'Potencia'
        });
        if (source !== 'PALACIOS-CLICK2RING-FB-MSGR-Potencia') {
          throw new Error(`Fuente incorrecta: ${source}`);
        }
      }
    },
    {
      name: 'Regla 5: La fuente jamás debe truncarse a códigos de 2 letras (ej: -Ar)',
      run: () => {
        const source = buildVtigerSource({
          sedeName: 'Naturales BioNatural',
          provider: 'CLICK2RING',
          channel: 'FB-MSGR',
          treatment: 'AR'
        });
        if (source.endsWith('-Ar') || source.endsWith('-AR')) {
          throw new Error(`Fuente truncada detectada: ${source}`);
        }
        if (!source.endsWith('-General')) {
          throw new Error(`Fallback incorrecto: ${source}`);
        }
      }
    },
    {
      name: 'Regla 6: Extracción Geográfica USA desde teléfono (479 -> AR, America/Chicago)',
      run: () => {
        const geo = extractShippingData('MUESTRA GRATIS', '+14793101777');
        if (geo.state !== 'AR') {
          throw new Error(`Estado esperado 'AR', recibido '${geo.state}'`);
        }
        if (geo.timezone !== 'America/Chicago') {
          throw new Error(`Timezone esperado 'America/Chicago', recibido '${geo.timezone}'`);
        }
      }
    },
    {
      name: 'Regla 7: Learning Brain aprende dinámicamente de ventas de vTiger',
      run: () => {
        learningBrain.learnFromVtigerSale({
          treatment: 'Potencia',
          chatText: 'vigor masculino prueba de fuego',
          campaignName: 'CAMPANA_TEST_POTENCIA'
        });
        const pred = learningBrain.predictTreatment('vigor masculino');
        if (pred.primaryTreatment !== 'Potencia') {
          throw new Error(`Esperado 'Potencia', recibido '${pred.primaryTreatment}'`);
        }
      }
    },
    {
      name: 'Regla 8: Learning Brain penaliza falsos positivos',
      run: () => {
        learningBrain.penalizeAssociation({
          phrase: 'prueba dolor rodilla falsa',
          incorrectTreatment: 'Artritis',
          correctTreatment: 'Potencia'
        });
        const m = learningBrain.getMetrics();
        if (m.stats.falsePositivesPenalized < 1) {
          throw new Error('No se registró la penalización de falso positivo');
        }
      }
    }
  ];

  let passed = 0;
  for (const test of tests) {
    try {
      test.run();
      passed++;
    } catch (err) {
      console.error(`❌ FALLÓ TEST PROTOCOLAR: ${test.name}`);
      console.error(`   Detalle: ${err.message}`);
      return false;
    }
  }

  console.log(`🛡️ [PRE-FLIGHT SANITY CHECK] ${passed}/${tests.length} Reglas protocolares validadas al 100%.`);
  return true;
}

// Ejecución directa si se invoca por CLI
if (process.argv[1]?.includes('test_audit_engine.js')) {
  const success = runPreFlightSanityCheck();
  process.exit(success ? 0 : 1);
}
