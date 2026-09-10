import { analyzeSymptoms } from './src/agents/nlp_symptom_engine.js';

const combinedText = "Has sido elegido para recibir una muestra gratuita de NOPAL PLUS. Regula el azúcar de forma natural! Solo necesitamos tu número y dirección de envío para garantizar una entrega segura y puntual. Cupos limitados. Aprovecha esta oportunidad única de bienestar natural! 635 Allison St Nw Washigton Dc 20011 Perfecto, Yanira! Gracias por tu dirección. Me está faltando tu número de teléfono para hacerte llegar la MUESTRA GRATIS.";
const analysis = analyzeSymptoms(combinedText, null, null);
console.log(analysis);
