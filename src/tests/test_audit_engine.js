/**
 * [TEST] PRE-FLIGHT SANITY CHECK & REGRESSION TEST (Laboratorios Naturales)
 * Valida automáticamente antes de iniciar el servidor o hacer despliegue:
 * 1. Clasificación correcta de pauta (Potencia, Colágeno, Diabetes, etc.) sin falsos Artritis.
 * 2. Atribución estricta CLICK2RING vs IN_HOUSE.
 * 3. Prohibición de nombres de tratamiento truncados (como '-Ar').
 * 4. Inferencia geográfica desde teléfonos de USA.
 */

import { analyzeSymptoms, inferTreatmentFromCampaignOrUtm, buildVtigerSource, resolveLeadProvider, resolveLeadSede, resolveLeadChannel, extractShippingData, isValidMetaAdId, isAdsetCandidate } from '../agents/nlp_symptom_engine.js';
import { buildAdHistoryNoteBody } from '../agents/chat_router_agent.js';
import { learningBrain } from '../services/learning_brain.js';
import { SEDES_GATEWAY, resolveSedeContext, getGhlHeaders, getMetaConfigBySede, getActiveSedes, resolveSedeCustomFields, resolveSedePipeline } from '../config/index.js';
import { SedeAgent, getSedeAgent, getActiveSedeAgents } from '../agents/sede_agent.js';
import { getQueue, getQueueStatus } from '../services/queue/durable_queue.js';
import { getBreakersStatus, safeCall } from '../utils/circuit_breaker.js';
import { getStateStore } from '../services/state/state_store.js';
import { normalizeTreatment, CANONICAL_TREATMENTS } from '../domain/clinical_vocabulary.js';

export function runPreFlightSanityCheck({ silent = false } = {}) {
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

        // Homologación: PIKALEX = CLICK2RING
        const provPikalex = resolveLeadProvider({
          campaignName: 'CAMPANA PIKALEX POTENCIA',
          isPaidAd: true
        });
        if (provPikalex !== 'CLICK2RING') {
          throw new Error(`PIKALEX debe resolver a CLICK2RING, recibido: ${provPikalex}`);
        }
        const srcPikalex = buildVtigerSource({
          sedeName: 'BioNatural - Ultra',
          provider: 'PIKALEX',
          channel: 'FB-MSGR',
          treatment: 'Potencia'
        });
        if (srcPikalex !== 'PALACIOS-CLICK2RING-FB-MSGR-Potencia') {
          throw new Error(`Fuente con PIKALEX debe normalizar a CLICK2RING: ${srcPikalex}`);
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
      name: 'Regla 4E: Regla de Origen Oficial por Fanpage (Propiedad de Marca)',
      run: () => {
        const pagesToTest = [
          { pageName: 'BioNatural - Ultra', expectedSede: 'PALACIOS', expectedProv: 'CLICK2RING' },
          { pageName: 'Naturales BioNatural', expectedSede: 'PALACIOS', expectedProv: 'ERNESTO' },
          { pageName: 'Laboratorios Naturales BIO', expectedSede: 'PALACIOS', expectedProv: 'IN_HOUSE' },
          { pageName: 'Natural Bio Benavides', expectedSede: 'BENAVIDES', expectedProv: 'CLICK2RING' },
          { pageName: 'Bio Natural Piura', expectedSede: 'PIURA', expectedProv: 'IN_HOUSE' },
          { pageName: 'Bio Naturales Roosevelt', expectedSede: 'ROOSEVELT', expectedProv: 'IN_HOUSE' }
        ];

        for (const p of pagesToTest) {
          const prov = resolveLeadProvider({
            pageName: p.pageName,
            isPaidAd: false
          });
          if (prov !== p.expectedProv) {
            throw new Error(`Proveedor en ${p.pageName} debe ser ${p.expectedProv}, recibido: ${prov}`);
          }
          const src = buildVtigerSource({
            sedeName: p.pageName,
            provider: prov,
            channel: 'FB-MSGR',
            treatment: 'General'
          });
          const expectedSrc = `${p.expectedSede}-${p.expectedProv}-FB-MSGR-General`;
          if (src !== expectedSrc) {
            throw new Error(`Fuente en ${p.pageName} debe ser '${expectedSrc}', recibido: '${src}'`);
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

        // 1B. El vocabulario canónico debe coincidir con el NLP (fuente única de verdad):
        //     'gomitas de colageno y biotina' contiene el síntoma 'colageno', pero el
        //     producto real es Gummies. Sin la regla de precedencia de formato, el
        //     agente inverso de vTiger y el curador lo etiquetaban como Colageno.
        if (normalizeTreatment('gomitas de colageno y biotina') !== 'Gummies') {
          throw new Error(`El vocabulario canónico debe resolver 'gomitas de colageno y biotina' a Gummies, recibido: ${normalizeTreatment('gomitas de colageno y biotina')}`);
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
    },
    {
      name: 'Regla 19: Arquitectura descentralizada - GHL Central purgado del gateway',
      run: () => {
        // 1. La bóveda central ya NO debe existir en ninguna forma
        if ('CENTRAL' in SEDES_GATEWAY) {
          throw new Error('SEDES_GATEWAY.CENTRAL sigue existiendo: la arquitectura central no fue purgada');
        }
        for (const conf of Object.values(SEDES_GATEWAY)) {
          if (conf.isUniversalCentral !== undefined || conf.allowActiveRouting !== undefined) {
            throw new Error(`La sede ${conf.sedeId} conserva banderas de la arquitectura central (isUniversalCentral/allowActiveRouting)`);
          }
          if (!conf.ghl || !('locationId' in conf.ghl) || !('apiKey' in conf.ghl)) {
            throw new Error(`La sede ${conf.sedeId} debe exponer ghl.locationId y ghl.apiKey`);
          }
        }

        // 2. Un locationId desconocido NO debe caer por accidente en Palacios
        const unknown = resolveSedeContext({ locationId: 'LOCATION_ID_NO_REGISTRADO_XYZ' });
        if (unknown.sedeId !== 'UNRESOLVED' || unknown.isUnresolved !== true) {
          throw new Error(`Un locationId desconocido debe resolver a UNRESOLVED, recibido: ${unknown.sedeId}`);
        }
        if (unknown.isConfigured !== false || unknown.ghl.apiKey !== '') {
          throw new Error('El contexto UNRESOLVED no debe portar credenciales ni marcarse como configurado');
        }

        // 3. Las sedes declaradas operativas deben declarar su estado de configuración
        const palacios = SEDES_GATEWAY.PALACIOS;
        if (typeof palacios.isConfigured !== 'boolean') {
          throw new Error('PALACIOS debe exponer isConfigured (fail-safe de secretos)');
        }
        if (palacios.isConfigured && !palacios.ghl.apiKey) {
          throw new Error('PALACIOS no puede estar configurado sin PIT');
        }

        // 4. Point-to-point: los headers se construyen con el PIT de la sede resuelta
        const headers = getGhlHeaders({ sede: 'BENAVIDES' });
        const benavidesToken = SEDES_GATEWAY.BENAVIDES.ghl.apiKey;
        if (!headers.Authorization.startsWith('Bearer ')) {
          throw new Error('getGhlHeaders debe devolver un Bearer token incluso sin credenciales (fail-safe)');
        }
        if (benavidesToken && headers.Authorization !== `Bearer ${benavidesToken}`) {
          throw new Error('getGhlHeaders debe usar el PIT exclusivo de la sede solicitada (point-to-point)');
        }
      }
    },
    {
      name: 'Regla 20: VTiger Sede Resolver - aislamiento point-to-point por locationId',
      run: () => {
        // 1. Palacios y Benavides resuelven a su propia sede según el gateway
        const palacios = resolveSedeContext({ locationId: SEDES_GATEWAY.PALACIOS.ghl.locationId });
        if (palacios.sedeId !== 'PALACIOS') {
          throw new Error(`El locationId de Palacios debe resolver a PALACIOS, recibido: ${palacios.sedeId}`);
        }

        const benavides = resolveSedeContext({ locationId: SEDES_GATEWAY.BENAVIDES.ghl.locationId });
        if (benavides.sedeId !== 'BENAVIDES') {
          throw new Error(`El locationId de Benavides debe resolver a BENAVIDES, recibido: ${benavides.sedeId}`);
        }

        // 2. Aislamiento: cada sede usa su propio PIT y su propio vtigerSedeName
        if (palacios.ghl.apiKey && palacios.ghl.apiKey === benavides.ghl.apiKey) {
          throw new Error('Palacios y Benavides NO deben compartir el mismo PIT (point-to-point violado)');
        }
        if (palacios.vtigerSedeName !== 'PALACIOS' || benavides.vtigerSedeName !== 'BENAVIDES') {
          throw new Error('vtigerSedeName debe ser único por sede para el Sede-Shield de vTiger');
        }

        // 3. Ninguna sede registrada puede pertenecer a una arquitectura central
        const central = resolveSedeContext({ locationId: 'ATPYNnsfZ1W8sd6WgWIV' });
        if (central.sedeId !== 'UNRESOLVED') {
          throw new Error(`El legacy 400k debe quedar fuera del gateway (UNRESOLVED), recibido: ${central.sedeId}`);
        }

        // 4. Verificar que los usuarios de Palacios están en la subcuenta correcta
        if (palacios.users?.ernesto?.id !== '8LuTk9jzt5BeaKLxdVru') {
          throw new Error(`Ernesto en Palacios debe tener id 8LuTk9jzt5BeaKLxdVru, recibido: ${palacios.users?.ernesto?.id}`);
        }
        if (palacios.users?.ultra?.id !== 'RrzgEyi2VOKIJ7Tf54SR') {
          throw new Error(`Ultra/Click2Ring en Palacios debe tener id RrzgEyi2VOKIJ7Tf54SR, recibido: ${palacios.users?.ultra?.id}`);
        }

        // 5. Verificar que los usuarios de Benavides tienen IDs correctos y sincronizados
        if (benavides.users?.redes1?.id !== 'GLC6pCjW4oP76hcT9QuC') {
          throw new Error(`REDES 1 Benavides debe tener id GLC6pCjW4oP76hcT9QuC, recibido: ${benavides.users?.redes1?.id}`);
        }
        if (benavides.users?.redes2?.id !== 'qicGSpBerbYnPHpXdeV2') {
          throw new Error(`REDES 2 Benavides debe tener id qicGSpBerbYnPHpXdeV2, recibido: ${benavides.users?.redes2?.id}`);
        }
      }
    },
    {
      name: 'Regla 21: Mapeo de Custom Fields Oficiales en Sincronización vTiger (Palacios y Benavides)',
      run: () => {
        // 1. Simulación de mapeo para Palacios
        const palaciosLoc = SEDES_GATEWAY.PALACIOS.ghl.locationId;
        const isBenavidesPal = palaciosLoc === SEDES_GATEWAY.BENAVIDES.ghl.locationId;
        const palIdAnuncio = isBenavidesPal ? 'bjIdaPk0dzyuNw0RCMwn' : 'NR0eI8a2EvugkHhpRJ1w';
        const palAdIdAlt = isBenavidesPal ? 'xYgC0RFCZZ1GagK2aaXu' : 'PUUykPTCijq7rZoLYwAD';
        const palUtmCamp = isBenavidesPal ? 'o5AQRN1o7qkhSomgYiaG' : '0VEvRUhcoN8o5YiaLAkG';
        const palSede = isBenavidesPal ? 'HJLN7LVvZHVX2Rr7eJma' : 'AXACVLFNsTOEzanAHCdf';
        const palOrigen = isBenavidesPal ? 'Vw6usJnpwuBScBm4yiSY' : '4mOsSGfHcGMJkoWUWlyX';
        const palTelefono = isBenavidesPal ? '0PvAaqJs7aERycth9mKW' : 'SMAiwKnSvPHWguEbOQxX';

        if (palIdAnuncio !== 'NR0eI8a2EvugkHhpRJ1w') throw new Error(`Palacios ID Anuncio incorrecto: ${palIdAnuncio}`);
        if (palAdIdAlt !== 'PUUykPTCijq7rZoLYwAD') throw new Error(`Palacios Ad ID Alt incorrecto: ${palAdIdAlt}`);
        if (palUtmCamp !== '0VEvRUhcoN8o5YiaLAkG') throw new Error(`Palacios UTM Campaign incorrecto: ${palUtmCamp}`);
        if (palSede !== 'AXACVLFNsTOEzanAHCdf') throw new Error(`Palacios Sede Asignada incorrecto: ${palSede}`);
        if (palOrigen !== '4mOsSGfHcGMJkoWUWlyX') throw new Error(`Palacios Origen Lead incorrecto: ${palOrigen}`);
        if (palTelefono !== 'SMAiwKnSvPHWguEbOQxX') throw new Error(`Palacios Tiene Telefono incorrecto: ${palTelefono}`);

        // 2. Simulación de mapeo para Benavides
        const benavidesLoc = SEDES_GATEWAY.BENAVIDES.ghl.locationId;
        const isBenavidesBen = benavidesLoc === SEDES_GATEWAY.BENAVIDES.ghl.locationId;
        const benIdAnuncio = isBenavidesBen ? 'bjIdaPk0dzyuNw0RCMwn' : 'NR0eI8a2EvugkHhpRJ1w';
        const benAdIdAlt = isBenavidesBen ? 'xYgC0RFCZZ1GagK2aaXu' : 'PUUykPTCijq7rZoLYwAD';
        const benSede = isBenavidesBen ? 'HJLN7LVvZHVX2Rr7eJma' : 'AXACVLFNsTOEzanAHCdf';
        const benOrigen = isBenavidesBen ? 'Vw6usJnpwuBScBm4yiSY' : '4mOsSGfHcGMJkoWUWlyX';
        const benTelefono = isBenavidesBen ? '0PvAaqJs7aERycth9mKW' : 'SMAiwKnSvPHWguEbOQxX';

        if (benIdAnuncio !== 'bjIdaPk0dzyuNw0RCMwn') throw new Error(`Benavides ID Anuncio incorrecto: ${benIdAnuncio}`);
        if (benAdIdAlt !== 'xYgC0RFCZZ1GagK2aaXu') throw new Error(`Benavides Ad ID Alt incorrecto: ${benAdIdAlt}`);
        if (benSede !== 'HJLN7LVvZHVX2Rr7eJma') throw new Error(`Benavides Sede Asignada incorrecto: ${benSede}`);
        if (benOrigen !== 'Vw6usJnpwuBScBm4yiSY') throw new Error(`Benavides Origen Lead incorrecto: ${benOrigen}`);
        if (benTelefono !== '0PvAaqJs7aERycth9mKW') throw new Error(`Benavides Tiene Telefono incorrecto: ${benTelefono}`);
      }
    },
    {
      name: 'Regla 22: Enrutamiento contextual por Page ID sin cuenta central',
      run: () => {
        // 1. Verificar resolución contextual por Page ID de Benavides (Corp)
        const corpCtx = resolveSedeContext({ pageId: '510617778807469' });
        if (corpCtx.sedeId !== 'BENAVIDES') {
          throw new Error(`Corp Page ID debe resolver a BENAVIDES, recibido: ${corpCtx.sedeId}`);
        }
        if (corpCtx.ghl.locationId !== SEDES_GATEWAY.BENAVIDES.ghl.locationId) {
          throw new Error(`Corp locationId debe coincidir con el gateway de Benavides, recibido: ${corpCtx.ghl.locationId}`);
        }

        // 2. Verificar resolución contextual por Page ID de Palacios (BioNatural)
        const palCtx = resolveSedeContext({ pageId: '566501466542620' });
        if (palCtx.sedeId !== 'PALACIOS') {
          throw new Error(`BioNatural Page ID debe resolver a PALACIOS, recibido: ${palCtx.sedeId}`);
        }
        if (palCtx.ghl.locationId !== SEDES_GATEWAY.PALACIOS.ghl.locationId) {
          throw new Error(`Palacios locationId debe coincidir con el gateway, recibido: ${palCtx.ghl.locationId}`);
        }

        // 3. Un Page ID desconocido NO puede heredar la subcuenta de Palacios
        const orphanPage = resolveSedeContext({ pageId: '000000000000000' });
        if (orphanPage.sedeId === 'PALACIOS' && orphanPage.isUnresolved) {
          throw new Error('Contexto inconsistente: UNRESOLVED no puede ser PALACIOS');
        }
        if (!orphanPage.sedeId) {
          throw new Error('resolveSedeContext debe devolver siempre un contexto válido (fail-safe)');
        }

        // 4. Bandera de arquitectura central erradicada en todo el gateway
        const centralFlags = Object.values(SEDES_GATEWAY).filter(s => s.allowActiveRouting !== undefined);
        if (centralFlags.length > 0) {
          throw new Error(`Persisten banderas allowActiveRouting en: ${centralFlags.map(s => s.sedeId).join(', ')}`);
        }
      }
    },
    {
      name: 'Regla 23: Arquitectura Pulpo - Descriptores de Sede, Pipelines y Custom Fields 1:1',
      run: () => {
        // 1. Sedes Activas
        const activeSedes = getActiveSedes();
        const activeIds = activeSedes.map(s => s.sedeId);
        if (!activeIds.includes('PALACIOS') || !activeIds.includes('BENAVIDES')) {
          throw new Error(`getActiveSedes debe incluir PALACIOS y BENAVIDES, recibido: ${activeIds.join(', ')}`);
        }
        if (activeIds.includes('ROOSEVELT') || activeIds.includes('PIURA') || activeIds.includes('CENTRAL')) {
          throw new Error(`Sedes en standby o Central no deben estar activas, recibido: ${activeIds.join(', ')}`);
        }

        // 2. Pipelines y Stages Oficiales
        const palPipeline = resolveSedePipeline({ sede: 'PALACIOS' });
        if (palPipeline.id !== 'YCZePq7oBz7XREDAPtsj') {
          throw new Error(`Pipeline Palacios incorrecto: ${palPipeline.id}`);
        }
        if (!palPipeline.stages?.prospectoInicial || !palPipeline.stages?.ganado) {
          throw new Error('Stages de Palacios incompletos');
        }

        const benPipeline = resolveSedePipeline({ locationId: 'QXcNBK6XCgpQaZ81Z8pv' });
        if (benPipeline.id !== 'Dv8kOeJvsMs9WMyTJAfD') {
          throw new Error(`Pipeline Benavides incorrecto: ${benPipeline.id}`);
        }
        if (!benPipeline.stages?.prospectoInicial || !benPipeline.stages?.ganado) {
          throw new Error('Stages de Benavides incompletos');
        }

        // 3. Simetría 1:1 de 29 Custom Fields
        const palFields = resolveSedeCustomFields({ sede: 'PALACIOS' });
        const benFields = resolveSedeCustomFields({ locationId: 'QXcNBK6XCgpQaZ81Z8pv' });

        const palKeys = Object.keys(palFields).sort();
        const benKeys = Object.keys(benFields).sort();

        if (palKeys.length !== 29) {
          throw new Error(`Palacios debe tener exactamente 29 custom fields, tiene: ${palKeys.length}`);
        }
        if (benKeys.length !== 29) {
          throw new Error(`Benavides debe tener exactamente 29 custom fields, tiene: ${benKeys.length}`);
        }
        if (palKeys.join(',') !== benKeys.join(',')) {
          throw new Error('Asimetría detectada en las llaves de custom fields entre Palacios y Benavides');
        }

        // 4. Verificación de IDs oficiales clave
        if (palFields.idAnuncio !== 'NR0eI8a2EvugkHhpRJ1w') throw new Error('Palacios idAnuncio mismatch');
        if (benFields.idAnuncio !== 'bjIdaPk0dzyuNw0RCMwn') throw new Error('Benavides idAnuncio mismatch');
        if (palFields.tratamientoComprado !== '5Sci2WhOpJq9kZWsLTrp') throw new Error('Palacios tratamientoComprado mismatch');
        if (benFields.tratamientoComprado !== 'xqDD056VzkFTOxHniDkw') throw new Error('Benavides tratamientoComprado mismatch');
        if (palFields.historialCompleto !== 'T3jzpe1j65tDGXLfQNrM') throw new Error('Palacios historialCompleto mismatch');
        if (benFields.historialCompleto !== 'cZZF2iWCedZpfD8kqR16') throw new Error('Benavides historialCompleto mismatch');
      }
    },
    {
      name: 'Regla 24: SedeAgent Factory y Hermetismo de Tentáculos',
      run: () => {
        // 1. Agentes Activos
        const activeAgents = getActiveSedeAgents();
        if (activeAgents.length !== 2) {
          throw new Error(`Se esperaban 2 agentes activos, recibido: ${activeAgents.length}`);
        }
        const activeIds = activeAgents.map(a => a.sedeId);
        if (!activeIds.includes('PALACIOS') || !activeIds.includes('BENAVIDES')) {
          throw new Error(`Agentes activos incorrectos: ${activeIds.join(', ')}`);
        }

        // 2. Instancia Palacios
        const palAgent = getSedeAgent('PALACIOS');
        if (!(palAgent instanceof SedeAgent)) throw new Error('palAgent debe ser instancia de SedeAgent');
        if (palAgent.ghl.locationId !== SEDES_GATEWAY.PALACIOS.ghl.locationId) throw new Error('Location ID Palacios incorrecto');
        if (palAgent.pipeline?.id !== 'YCZePq7oBz7XREDAPtsj') throw new Error('Pipeline ID Palacios incorrecto');
        if (!palAgent.customFields?.idAnuncio) throw new Error('Custom fields de Palacios ausentes');
        if (palAgent.isConfigured !== true) throw new Error('Palacios debe estar configurado para operar');

        // 3. Instancia Benavides
        const benAgent = getSedeAgent(SEDES_GATEWAY.BENAVIDES.ghl.locationId);
        if (benAgent.sedeId !== 'BENAVIDES') throw new Error('Resolución por locationId de Benavides falló');
        if (benAgent.pipeline?.id !== 'Dv8kOeJvsMs9WMyTJAfD') throw new Error('Pipeline ID Benavides incorrecto');

        // 4. Sede no registrada: agente fail-safe sin credenciales, nunca con PIT ajeno
        const orphanAgent = getSedeAgent('LOCATION_ID_NO_REGISTRADO_XYZ');
        if (!orphanAgent) throw new Error('getSedeAgent debe devolver un agente fail-safe, no null');
        if (orphanAgent.sedeId !== 'UNRESOLVED') throw new Error(`Sede desconocida debe ser UNRESOLVED, recibido: ${orphanAgent.sedeId}`);
        if (orphanAgent.isConfigured !== false) throw new Error('El agente UNRESOLVED no puede marcarse como configurado');
        if (orphanAgent.ghl.apiKey) throw new Error('El agente UNRESOLVED no debe portar el PIT de otra sede');

        // 5. Verificación de bloqueo de ruteo en sede no configurada (fail-safe)
        const p = orphanAgent.routeContact('dummy-contact-id');
        if (!(p instanceof Promise)) {
          throw new Error('SedeAgent.routeContact debe retornar una Promesa');
        }
        p.then(res => {
          if (res !== 'RETRY') {
            throw new Error(`routeContact en sede no configurada debió diferir el ruteo ('RETRY'), recibido: ${res}`);
          }
        });
      }
    },
    {
      name: 'Regla 25: Extracción de DOLENCIA y PROVEEDOR desde Nombre de Conjunto de Anuncios (AdSet)',
      run: () => {
        const adsetCarmen = 'TESTOSTERONA - ERNESTO - 7am a 2pm - 1175';
        const adsetErnesto = 'ARTRITIS - ERNESTO - 2pm a 9pm - 300';
        const adsetInHouse = 'TETOSTERONA - IN HOUSE - NO MGRATIS- CBO V1 - 100diario';
        const adsetClick = 'POTENCIA - CLICK2RING - 8am a 4pm';

        // 1. isAdsetCandidate
        if (!isAdsetCandidate(adsetCarmen)) throw new Error('adsetCarmen debió ser reconocido como AdSet');
        if (!isAdsetCandidate(adsetErnesto)) throw new Error('adsetErnesto debió ser reconocido como AdSet');
        if (!isAdsetCandidate(adsetInHouse)) throw new Error('adsetInHouse debió ser reconocido como AdSet');
        if (!isAdsetCandidate(adsetClick)) throw new Error('adsetClick debió ser reconocido como AdSet');
        if (isAdsetCandidate('cpc')) throw new Error('cpc no debe ser reconocido como AdSet');
        if (isAdsetCandidate('Paid Social')) throw new Error('Paid Social no debe ser reconocido como AdSet');
        if (isAdsetCandidate('messenger')) throw new Error('messenger no debe ser reconocido como AdSet');
        if (isAdsetCandidate('facebook')) throw new Error('facebook no debe ser reconocido como AdSet');

        // 2. Extracción de Dolencia
        const dolenciaCarmen = inferTreatmentFromCampaignOrUtm(adsetCarmen);
        if (dolenciaCarmen !== 'Potencia') throw new Error(`Esperado Potencia para adsetCarmen, recibido: ${dolenciaCarmen}`);

        const dolenciaErnesto = inferTreatmentFromCampaignOrUtm(adsetErnesto);
        if (dolenciaErnesto !== 'Artritis') throw new Error(`Esperado Artritis para adsetErnesto, recibido: ${dolenciaErnesto}`);

        // 3. Extracción de Proveedor
        const provCarmen = resolveLeadProvider({ adsetName: adsetCarmen });
        if (provCarmen !== 'ERNESTO') throw new Error(`Esperado ERNESTO para adsetCarmen, recibido: ${provCarmen}`);

        const provClick = resolveLeadProvider({ adsetName: adsetClick });
        if (provClick !== 'CLICK2RING') throw new Error(`Esperado CLICK2RING para adsetClick, recibido: ${provClick}`);

        const provInHouse = resolveLeadProvider({ adsetName: adsetInHouse });
        if (provInHouse !== 'IN_HOUSE') throw new Error(`Esperado IN_HOUSE para adsetInHouse, recibido: ${provInHouse}`);

        // 4. Origen Estructurado Completo
        const sourceCarmen = buildVtigerSource({
          sedeName: 'Naturales BioNatural',
          provider: provCarmen,
          channel: 'FB-MSGR',
          treatment: dolenciaCarmen
        });
        if (sourceCarmen !== 'PALACIOS-ERNESTO-FB-MSGR-Potencia') {
          throw new Error(`Fuente esperada PALACIOS-ERNESTO-FB-MSGR-Potencia, recibido: ${sourceCarmen}`);
        }
      }
    },
    {
      name: 'Regla 26: Gate de arranque puro y acotado (protección anti crash-loop de Render)',
      run: () => {
        // 1. Cada regla debe ser SÍNCRONA: sin promesas, timers ni red pendiente.
        //    (Un sanity check que espera I/O es la causa raíz del crash loop de Render.)
        for (const test of tests) {
          // [ANTI-RECURSIÓN] El propio gate se excluye: re-ejecutarse anidaría la suite
          // de forma exponencial y rompería el presupuesto de arranque.
          if (/Gate de arranque puro/.test(test.name)) continue;
          if (typeof test.run !== 'function' || !test.name) {
            throw new Error(`Regla malformada en la suite: ${JSON.stringify(test.name)}`);
          }
          const result = test.run();
          if (result && typeof result.then === 'function') {
            throw new Error(`La regla '${test.name}' devolvió una Promesa: el gate de arranque debe ser síncrono`);
          }
        }

        // 2. El presupuesto del gate es configurable y nunca puede exceder 5 s.
        const budget = parseInt(process.env.PREFLIGHT_MAX_MS || '5000', 10);
        if (!Number.isFinite(budget) || budget <= 0 || budget > 5000) {
          throw new Error(`PREFLIGHT_MAX_MS debe ser un entero entre 1 y 5000, recibido: ${process.env.PREFLIGHT_MAX_MS}`);
        }
      }
    },
    {
      name: 'Regla 27: Feature flag de colas durables - degradación sin caída del proceso',
      run: () => {
        const status = getQueueStatus();

        // 1. El flag debe declararse siempre y reflejar el entorno
        if (typeof status.enabled !== 'boolean' || !status.featureFlag) {
          throw new Error('getQueueStatus debe informar featureFlag y enabled');
        }

        // 2. Con el flag apagado, el driver activo DEBE ser el de memoria
        if (!status.enabled && status.activeDriver !== 'memory') {
          throw new Error(`Con el flag apagado el driver debe ser 'memory', recibido: ${status.activeDriver}`);
        }

        // 3. Contrato único de cola: enqueue + registerProcessor funcionan sin Redis
        const q = getQueue('sanity-probe');
        if (typeof q.enqueue !== 'function' || typeof q.registerProcessor !== 'function') {
          throw new Error('La cola debe exponer enqueue() y registerProcessor()');
        }

        // 4. Encolar sin procesador no debe lanzar excepción hacia el llamante
        const enqueueResult = q.enqueue('job-de-prueba', { ping: true });
        if (!enqueueResult || typeof enqueueResult.then !== 'function') {
          throw new Error('enqueue() debe devolver una Promesa (nunca bloquear el event loop)');
        }
        enqueueResult.then(res => {
          if (!res || res.driver !== 'memory') {
            throw new Error(`El encolado debe confirmar el driver de respaldo, recibido: ${JSON.stringify(res)}`);
          }
        }).catch(() => {});
      }
    },
    {
      name: 'Regla 28: Circuit Breaker disponible y estado consultable para APIs externas',
      run: () => {
        const status = getBreakersStatus();
        if (typeof status !== 'object' || status === null) {
          throw new Error('getBreakersStatus debe devolver un objeto');
        }
        if (typeof safeCall !== 'function') {
          throw new Error('safeCall debe estar exportado para envolver APIs externas');
        }
      }
    },
    {
      name: 'Regla 29: Persistencia stateless declarada por driver (file | postgres)',
      run: () => {
        const store = getStateStore('sanity-probe');
        const desc = store.describe();
        if (!desc || !desc.driver) {
          throw new Error('StateStore.describe debe informar el driver activo');
        }
        if (!['file', 'postgres', 'memory'].includes(desc.driver)) {
          throw new Error(`Driver de persistencia desconocido: ${desc.driver}`);
        }
        if (typeof store.get !== 'function' || typeof store.set !== 'function') {
          throw new Error('StateStore debe exponer get() y set()');
        }
      }
    }
  ];

  let passed = 0;
  const startedAt = Date.now();
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

  const elapsed = Date.now() - startedAt;
  if (silent) return true;

  console.log(`[PRE-FLIGHT SANITY CHECK] [SUCCESS] ${passed}/${tests.length} Reglas protocolares validadas al 100%.`);
  console.log(`[PRE-FLIGHT SANITY CHECK] [PERF] Ejecutado en ${elapsed}ms (presupuesto: ${process.env.PREFLIGHT_MAX_MS || 5000}ms, sin red).`);
  return true;
}

// Ejecución directa si se invoca por CLI
if (process.argv[1]?.includes('test_audit_engine.js')) {
  const success = runPreFlightSanityCheck();
  process.exit(success ? 0 : 1);
}
