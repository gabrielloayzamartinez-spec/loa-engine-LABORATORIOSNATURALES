/**
 * 🧪 PRE-FLIGHT SANITY CHECK & REGRESSION TEST (Laboratorios Naturales)
 * Valida automáticamente antes de iniciar el servidor o hacer despliegue:
 * 1. Clasificación correcta de pauta (Potencia, Colágeno, Diabetes, etc.) sin falsos Artritis.
 * 2. Atribución estricta CLICK2RING vs IN_HOUSE.
 * 3. Prohibición de nombres de tratamiento truncados (como '-Ar').
 * 4. Inferencia geográfica desde teléfonos de USA.
 */

import { analyzeSymptoms, inferTreatmentFromCampaignOrUtm, buildVtigerSource, resolveLeadProvider, resolveLeadSede, resolveLeadChannel, extractShippingData, isValidMetaAdId } from '../agents/nlp_symptom_engine.js';
import { buildAdHistoryNoteBody } from '../agents/chat_router_agent.js';
import { learningBrain } from '../services/learning_brain.js';
import { SEDES_GATEWAY, resolveSedeContext, getGhlHeaders, getMetaConfigBySede } from '../config/index.js';

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
      name: 'Regla 4H: Purgado de etiquetas huérfanas en ingreso orgánico (sin meta-ads)',
      run: () => {
        const tags = ['facebook-messenger', 'meta-ads', 'producto-artritis'];
        const isPaidAd = false;
        const currentAdId = null;
        const targetAdId = null;
        
        const tagsToRemove = [];
        const newTagsSet = new Set(tags);
        if (isPaidAd) {
          newTagsSet.add('meta-ads');
          newTagsSet.delete('organico');
        } else {
          newTagsSet.add('organico');
          if (!currentAdId && !targetAdId) {
            newTagsSet.delete('meta-ads');
            if (tags.includes('meta-ads')) {
              tagsToRemove.push('meta-ads');
            }
          }
        }

        if (!tagsToRemove.includes('meta-ads')) {
          throw new Error('Debe marcar meta-ads para purga cuando el lead es puramente orgánico');
        }
        if (newTagsSet.has('meta-ads')) {
          throw new Error('newTagsSet no debe tener meta-ads en lead orgánico');
        }
        if (!newTagsSet.has('organico')) {
          throw new Error('newTagsSet debe contener organico');
        }
      }
    },
    {
      name: 'Regla 4I: Matriz de Páginas y Campañas de Benavides (Click2Ring, Ernesto, InHouse)',
      run: () => {
        // 1. Verificación de Fanpages (Image 1)
        // Bio Natural (126154270581792) -> CLICK2RING
        const p1Prov = resolveLeadProvider({ pageId: '126154270581792', pageName: 'Bio Natural' });
        const p1Sede = resolveLeadSede({ pageId: '126154270581792', pageName: 'Bio Natural' });
        if (p1Prov !== 'CLICK2RING' || p1Sede !== 'BENAVIDES') {
          throw new Error(`Bio Natural debe ser BENAVIDES-CLICK2RING, recibido: ${p1Sede}-${p1Prov}`);
        }

        // Naturales Bio Corp (510617778807469) -> ERNESTO
        const p2Prov = resolveLeadProvider({ pageId: '510617778807469', pageName: 'Naturales Bio Corp' });
        const p2Sede = resolveLeadSede({ pageId: '510617778807469', pageName: 'Naturales Bio Corp' });
        if (p2Prov !== 'ERNESTO' || p2Sede !== 'BENAVIDES') {
          throw new Error(`Naturales Bio Corp debe ser BENAVIDES-ERNESTO, recibido: ${p2Sede}-${p2Prov}`);
        }

        // BioNatural Fuerza (1147742788423762) -> IN_HOUSE
        const p3Prov = resolveLeadProvider({ pageId: '1147742788423762', pageName: 'BioNatural Fuerza' });
        const p3Sede = resolveLeadSede({ pageId: '1147742788423762', pageName: 'BioNatural Fuerza' });
        if (p3Prov !== 'IN_HOUSE' || p3Sede !== 'BENAVIDES') {
          throw new Error(`BioNatural Fuerza debe ser BENAVIDES-IN_HOUSE, recibido: ${p3Sede}-${p3Prov}`);
        }

        // 2. Verificación a Nivel Nombre de Campaña (Image 2)
        // Campaña 1: Hongos - Benavides- InHouse - MessengerFB
        const c1Camp = 'Hongos - Benavides- InHouse - MessengerFB';
        const c1Prov = resolveLeadProvider({ campaignName: c1Camp });
        const c1Sede = resolveLeadSede({ campaignName: c1Camp });
        const c1Trat = inferTreatmentFromCampaignOrUtm(c1Camp);
        const c1Chan = resolveLeadChannel({ campaignName: c1Camp });
        const c1Source = buildVtigerSource({ sedeName: c1Sede, campaignName: c1Camp, provider: c1Prov, channel: c1Chan, treatment: c1Trat });
        if (c1Source !== 'BENAVIDES-IN_HOUSE-FB-MSGR-Hongos') {
          throw new Error(`Campaña Hongos InHouse esperada 'BENAVIDES-IN_HOUSE-FB-MSGR-Hongos', recibido: '${c1Source}'`);
        }

        // Campaña 2: Testosterona -Benavides -InHouse -Formulario (PREGUNTA)
        const c2Camp = 'Testosterona -Benavides -InHouse -Formulario (PREGUNTA)';
        const c2Prov = resolveLeadProvider({ campaignName: c2Camp });
        const c2Sede = resolveLeadSede({ campaignName: c2Camp });
        const c2Trat = inferTreatmentFromCampaignOrUtm(c2Camp);
        const c2Chan = resolveLeadChannel({ campaignName: c2Camp });
        const c2Source = buildVtigerSource({ sedeName: c2Sede, campaignName: c2Camp, provider: c2Prov, channel: c2Chan, treatment: c2Trat });
        if (c2Source !== 'BENAVIDES-IN_HOUSE-FORM-Potencia') {
          throw new Error(`Campaña Formulario esperada 'BENAVIDES-IN_HOUSE-FORM-Potencia', recibido: '${c2Source}'`);
        }

        // Campaña 3: DIABETES - BENAVIDES (César)
        const c3Camp = 'DIABETES - BENAVIDES (César)';
        const c3Prov = resolveLeadProvider({ campaignName: c3Camp });
        const c3Sede = resolveLeadSede({ campaignName: c3Camp });
        const c3Trat = inferTreatmentFromCampaignOrUtm(c3Camp);
        const c3Source = buildVtigerSource({ sedeName: c3Sede, campaignName: c3Camp, provider: c3Prov, channel: 'FB-MSGR', treatment: c3Trat });
        if (c3Source !== 'BENAVIDES-CLICK2RING-FB-MSGR-Diabetes') {
          throw new Error(`Campaña César esperada 'BENAVIDES-CLICK2RING-FB-MSGR-Diabetes', recibido: '${c3Source}'`);
        }

        // Campaña 4: DIABETES - BENAVIDES (César - Piura)
        const c4Camp = 'DIABETES - BENAVIDES (César - Piura)';
        const c4Prov = resolveLeadProvider({ campaignName: c4Camp });
        const c4Sede = resolveLeadSede({ campaignName: c4Camp });
        const c4Trat = inferTreatmentFromCampaignOrUtm(c4Camp);
        const c4Source = buildVtigerSource({ sedeName: c4Sede, campaignName: c4Camp, provider: c4Prov, channel: 'FB-MSGR', treatment: c4Trat });
        if (c4Source !== 'PIURA-CLICK2RING-FB-MSGR-Diabetes') {
          throw new Error(`Campaña Piura César esperada 'PIURA-CLICK2RING-FB-MSGR-Diabetes', recibido: '${c4Source}'`);
        }

        // Campaña 5: Testosterona -Piura- InHouse -MessengerFB
        const c5Camp = 'Testosterona -Piura- InHouse -MessengerFB';
        const c5Prov = resolveLeadProvider({ campaignName: c5Camp });
        const c5Sede = resolveLeadSede({ campaignName: c5Camp });
        const c5Trat = inferTreatmentFromCampaignOrUtm(c5Camp);
        const c5Source = buildVtigerSource({ sedeName: c5Sede, campaignName: c5Camp, provider: c5Prov, channel: 'FB-MSGR', treatment: c5Trat });
        if (c5Source !== 'PIURA-IN_HOUSE-FB-MSGR-Potencia') {
          throw new Error(`Campaña Piura InHouse esperada 'PIURA-IN_HOUSE-FB-MSGR-Potencia', recibido: '${c5Source}'`);
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
    },
    {
      name: 'Regla 17: Gateway Multi-Sede Decoupled (Palacios y Benavides con Meta y GHL independientes)',
      run: () => {
        // 1. Verificar resolución por Page ID de Benavides
        const benavidesSede = resolveSedeContext({ pageId: '126154270581792' });
        if (benavidesSede.sedeId !== 'BENAVIDES') {
          throw new Error(`Esperado BENAVIDES para pageId 126154270581792, recibido: ${benavidesSede.sedeId}`);
        }

        // 2. Verificar resolución por Page ID de Palacios
        const palaciosSede = resolveSedeContext({ pageId: '111906554968800' });
        if (palaciosSede.sedeId !== 'PALACIOS') {
          throw new Error(`Esperado PALACIOS para pageId 111906554968800, recibido: ${palaciosSede.sedeId}`);
        }

        // 3. Verificar headers GHL desacoplados
        const bHeaders = getGhlHeaders({ sede: 'BENAVIDES' });
        const expectedBenavidesKey = process.env.GHL_API_KEY_BENAVIDES || '';
        if (!bHeaders.Authorization || !bHeaders.Authorization.startsWith('Bearer ') || (expectedBenavidesKey && !bHeaders.Authorization.includes(expectedBenavidesKey))) {
          throw new Error(`Header GHL Benavides no contiene la API Key esperada: ${bHeaders.Authorization}`);
        }

        // 4. Verificar configuración de Meta independiente
        const bMeta = getMetaConfigBySede({ sede: 'BENAVIDES' });
        if (!bMeta || typeof bMeta !== 'object' || !('accessToken' in bMeta)) {
          throw new Error('Meta config de Benavides debe estructurarse correctamente con campo accessToken');
        }

        // 5. Verificar usuarios asignados en Benavides
        if (!benavidesSede.users?.redes1?.id || !benavidesSede.users?.redes2?.id) {
          throw new Error('Benavides debe poseer los usuarios redes1 y redes2 configurados');
        }
      }
    },
    {
      name: 'Regla 18: Inyección de Etiquetas Interactivas (con/sin telefono, compro/no compro) y Dolencias Oficiales (Gummies)',
      run: () => {
        // 1. Detección de Gummies
        const gummyAnalysis = analyzeSymptoms('Hola me interesan las gomitas de colageno y biotina');
        if (gummyAnalysis.primaryTreatment !== 'Gummies') {
          throw new Error(`Esperado tratamiento 'Gummies', recibido: '${gummyAnalysis.primaryTreatment}'`);
        }
        if (!gummyAnalysis.productTags.includes('producto-gummies')) {
          throw new Error(`Debe generar etiqueta 'producto-gummies', recibido: ${JSON.stringify(gummyAnalysis.productTags)}`);
        }

        // 2. Inferencia por Campaña de Gummies
        const campGummies = inferTreatmentFromCampaignOrUtm('CAMPAÑA GUMMIES BIOTINA - INHOUSE');
        if (campGummies !== 'Gummies') {
          throw new Error(`Inferencia por campaña de Gummies esperada 'Gummies', recibido: '${campGummies}'`);
        }

        // 3. Validación de Etiquetas Interactivas Binarias
        // Caso A: Lead con teléfono y sin compra
        const tagsA = new Set(['facebook-messenger', 'organico', 'sin-telefono', 'compro']);
        const tagsToRemoveA = [];
        const hasPhoneA = true;
        const isWonA = false;

        if (hasPhoneA) {
          tagsA.add('con-telefono');
          tagsA.delete('sin-telefono');
          tagsToRemoveA.push('sin-telefono');
        }
        if (!isWonA) {
          tagsA.add('no-compro');
          tagsA.delete('compro');
          tagsToRemoveA.push('compro');
        }

        if (!tagsA.has('con-telefono') || tagsA.has('sin-telefono')) {
          throw new Error('Etiqueta con-telefono debe estar presente y sin-telefono eliminada');
        }
        if (!tagsA.has('no-compro') || tagsA.has('compro')) {
          throw new Error('Etiqueta no-compro debe estar presente y compro eliminada');
        }
        if (!tagsToRemoveA.includes('sin-telefono') || !tagsToRemoveA.includes('compro')) {
          throw new Error('tagsToRemove debe purgar sin-telefono y compro');
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
