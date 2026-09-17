/**
 * 🧪 PRE-FLIGHT SANITY CHECK & REGRESSION TEST (Laboratorios Naturales)
 * Valida automáticamente antes de iniciar el servidor o hacer despliegue:
 * 1. Clasificación correcta de pauta (Potencia, Colágeno, Diabetes, etc.) sin falsos Artritis.
 * 2. Atribución estricta CLICK2RING vs IN_HOUSE.
 * 3. Prohibición de nombres de tratamiento truncados (como '-Ar').
 * 4. Inferencia geográfica desde teléfonos de USA.
 */

import { analyzeSymptoms, inferTreatmentFromCampaignOrUtm, buildVtigerSource, resolveLeadProvider, extractShippingData, isValidMetaAdId } from '../agents/nlp_symptom_engine.js';
import { buildAdHistoryNoteBody } from '../agents/chat_router_agent.js';
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
      name: 'Regla 4: Fuente estructurada para pauta de ULTRA debe ser PALACIOS-CLICK2RING',
      run: () => {
        const prov = resolveLeadProvider({
          pageId: '111906554968800',
          pageName: 'BioNatural - Ultra',
          isPaidAd: true
        });
        if (prov !== 'CLICK2RING') {
          throw new Error(`Proveedor de ULTRA debe ser CLICK2RING, recibido: ${prov}`);
        }
        const source = buildVtigerSource({
          sedeName: 'BioNatural - Ultra',
          provider: prov,
          channel: 'FB-MSGR',
          treatment: 'Potencia'
        });
        if (source !== 'PALACIOS-CLICK2RING-FB-MSGR-Potencia') {
          throw new Error(`Fuente incorrecta para ULTRA: ${source}`);
        }
      }
    },
    {
      name: 'Regla 4B: Pauta de Naturales BioNatural con IN HOUSE debe resolver PALACIOS-IN_HOUSE',
      run: () => {
        const prov = resolveLeadProvider({
          pageId: '566501466542620',
          pageName: 'Naturales BioNatural',
          adsetName: 'TETOSTERONA - IN HOUSE - NO MGRATIS- CBO V1 - 100diario',
          isPaidAd: true
        });
        if (prov !== 'IN_HOUSE') {
          throw new Error(`Proveedor esperado IN_HOUSE, recibido: ${prov}`);
        }
        const trat = inferTreatmentFromCampaignOrUtm('TETOSTERONA - IN HOUSE - NO MGRATIS- CBO V1 - 100diario');
        const source = buildVtigerSource({
          sedeName: 'Naturales BioNatural',
          provider: prov,
          channel: 'FB-MSGR',
          treatment: trat
        });
        if (source !== 'PALACIOS-IN_HOUSE-FB-MSGR-Potencia') {
          throw new Error(`Fuente incorrecta para IN_HOUSE: ${source}`);
        }
      }
    },
    {
      name: 'Regla 4C: Pauta de Naturales BioNatural con ERNESTO debe resolver PALACIOS-ERNESTO',
      run: () => {
        const prov = resolveLeadProvider({
          pageId: '566501466542620',
          pageName: 'Naturales BioNatural',
          adsetName: 'ARTRITIS - ERNESTO - 2pm a 9pm - 300',
          isPaidAd: true
        });
        if (prov !== 'ERNESTO') {
          throw new Error(`Proveedor esperado ERNESTO, recibido: ${prov}`);
        }
        const trat = inferTreatmentFromCampaignOrUtm('ARTRITIS - ERNESTO - 2pm a 9pm - 300');
        const source = buildVtigerSource({
          sedeName: 'Naturales BioNatural',
          provider: prov,
          channel: 'FB-MSGR',
          treatment: trat
        });
        if (source !== 'PALACIOS-ERNESTO-FB-MSGR-Artritis') {
          throw new Error(`Fuente incorrecta para ERNESTO: ${source}`);
        }
      }
    },
    {
      name: 'Regla 4D: Laboratorios Naturales BIO debe resolver IN_HOUSE (reactivacion/organico)',
      run: () => {
        const prov = resolveLeadProvider({
          pageId: '718150351371765',
          pageName: 'Laboratorios Naturales BIO',
          isPaidAd: false
        });
        if (prov !== 'IN_HOUSE') {
          throw new Error(`Proveedor esperado IN_HOUSE para Labs Bio, recibido: ${prov}`);
        }
        const source = buildVtigerSource({
          sedeName: 'Laboratorios Naturales BIO',
          provider: prov,
          channel: 'FB-MSGR',
          treatment: 'General'
        });
        if (source !== 'PALACIOS-IN_HOUSE-FB-MSGR-General') {
          throw new Error(`Fuente incorrecta para Labs Bio: ${source}`);
        }
      }
    },
    {
      name: 'Regla 4E: Regla de Origen Orgánico Universal para TODAS las Páginas (Tráfico por Goteo)',
      run: () => {
        const pagesToTest = [
          { pageName: 'BioNatural - Ultra', expectedSede: 'PALACIOS' },
          { pageName: 'Naturales BioNatural', expectedSede: 'PALACIOS' },
          { pageName: 'Laboratorios Naturales BIO', expectedSede: 'PALACIOS' },
          { pageName: 'Natural Bio Benavides', expectedSede: 'BENAVIDES' },
          { pageName: 'Bio Natural Piura', expectedSede: 'PIURA' },
          { pageName: 'Bio Naturales Roosevelt', expectedSede: 'ROOSEVELT' }
        ];

        for (const p of pagesToTest) {
          const prov = resolveLeadProvider({
            pageName: p.pageName,
            isPaidAd: false
          });
          if (prov !== 'IN_HOUSE') {
            throw new Error(`Proveedor orgánico en ${p.pageName} debe ser IN_HOUSE, recibido: ${prov}`);
          }
          const src = buildVtigerSource({
            sedeName: p.pageName,
            provider: prov,
            channel: 'FB-MSGR',
            treatment: 'General'
          });
          const expectedSrc = `${p.expectedSede}-IN_HOUSE-FB-MSGR-General`;
          if (src !== expectedSrc) {
            throw new Error(`Fuente orgánica en ${p.pageName} debe ser '${expectedSrc}', recibido: '${src}'`);
          }
        }
      }
    },
    {
      name: 'Regla 4F: Amarre Estricto de Ad ID y Actualización Dinámica al Reingresar por Anuncio Diferente',
      run: () => {
        // 1. Validación de formato de Meta Ad ID numérico
        const validAdId = '120226588408570607';
        const invalidAdId = 'PALACIOS-CLICK2RING-FB-MSGR-Potencia';
        if (!isValidMetaAdId(validAdId)) throw new Error('Ad ID numérico debe ser válido');
        if (isValidMetaAdId(invalidAdId)) throw new Error('Cadenas de texto no son Ad IDs válidos');

        // 2. Ingreso inicial por Ad ID A (Ultra - Potencia CLICK2RING)
        const initialAdId = '120226588408570607';
        const initialProv = resolveLeadProvider({
          pageName: 'BioNatural - Ultra',
          isPaidAd: true
        });
        const initialSource = buildVtigerSource({
          sedeName: 'BioNatural - Ultra',
          provider: initialProv,
          channel: 'FB-MSGR',
          treatment: 'Potencia'
        });
        if (initialSource !== 'PALACIOS-CLICK2RING-FB-MSGR-Potencia') {
          throw new Error(`Fuente inicial incorrecta: ${initialSource}`);
        }

        // 3. Reingreso por Ad ID B diferente (Naturales BioNatural - Artritis ERNESTO)
        const newAdId = '120226588408599999';
        const isDifferentAd = Boolean(newAdId && initialAdId && newAdId !== initialAdId);
        if (!isDifferentAd) {
          throw new Error('Debe detectar que el Ad ID es diferente');
        }

        // Se actualiza dinámicamente el origen vinculado al nuevo Ad ID
        const updatedProv = resolveLeadProvider({
          pageName: 'Naturales BioNatural',
          adsetName: 'ARTRITIS - ERNESTO - 2pm a 9pm - 300',
          isPaidAd: true
        });
        const updatedSource = buildVtigerSource({
          sedeName: 'Naturales BioNatural',
          provider: updatedProv,
          channel: 'FB-MSGR',
          treatment: 'Artritis'
        });

        if (updatedSource !== 'PALACIOS-ERNESTO-FB-MSGR-Artritis') {
          throw new Error(`Origen no se actualizó al nuevo anuncio: ${updatedSource}`);
        }
      }
    },
    {
      name: 'Regla 4G: Formato de Nota Histórica ante Mudanza de Sede (Confidencialidad Multisede: OTRA SEDE)',
      run: () => {
        const note = buildAdHistoryNoteBody({
          dateStr: '17/9/2026, 12:10:00',
          source: 'PALACIOS-ERNESTO-FB-MSGR-Artritis',
          treatment: 'Artritis',
          newAdId: '120226588408599999',
          pageName: 'Naturales BioNatural',
          campaign: 'ARTRITIS - ERNESTO',
          oldAdId: '120226588408570607',
          oldAdDate: '10/9/2026',
          isMudanzaDeSede: true,
          isGraceExpired: true,
          previousSede: 'BENAVIDES' // Sede de origen previa que debe enmascararse
        });

        const expectedInteraccion = '- Interacción: DOBLE INGRESO PUBLICITARIO - Anuncio / Campaña Previa: 120226588408570607  10/9/2026  (OTRA SEDE) ("tiempo de gracia expirado")';
        if (!note.includes(expectedInteraccion)) {
          throw new Error(`Interacción no coincide con la regla de confidencialidad de mudanza.\nEsperado:\n${expectedInteraccion}\nRecibido en nota:\n${note}`);
        }
        if (note.includes('BENAVIDES')) {
          throw new Error('Violación de confidencialidad: la sede previa no debe detallarse en la nota de mudanza');
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
      console.error(`[ERROR] FALLÓ TEST PROTOCOLAR: ${test.name}`);
      console.error(`   Detalle: ${err.message}`);
      return false;
    }
  }

  console.log(`[PRE-FLIGHT SANITY CHECK] [SUCCESS] ${passed}/${tests.length} Reglas protocolares validadas al 100%.`);
  return true;
}

// Ejecución directa si se invoca por CLI
if (process.argv[1]?.includes('test_audit_engine.js')) {
  const success = runPreFlightSanityCheck();
  process.exit(success ? 0 : 1);
}
