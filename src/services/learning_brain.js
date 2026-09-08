import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const BRAIN_FILE = path.join(DATA_DIR, 'learning_brain.json');

// Semilla Inicial Inteligente
const INITIAL_SEED = {
  version: '2.0.0',
  stats: {
    totalInferences: 0,
    learnedFromSales: 0,
    learnedFromAdvisors: 0,
    falsePositivesPenalized: 0,
    lastLearnedAt: null
  },
  treatments: [
    'Potencia',
    'Diabetes',
    'Prostata',
    'Colageno',
    'Vision',
    'Gastro',
    'Artritis'
  ],
  vocabularyWeights: {
    // Potencia
    'muestra gratis potencia': { Potencia: 25 },
    'poder interior': { Potencia: 20 },
    'fuerza intima': { Potencia: 20 },
    'salud sexual': { Potencia: 15 },
    'sexual': { Potencia: 8 },
    'vigor': { Potencia: 8 },
    'ereccion': { Potencia: 10 },
    'potencia': { Potencia: 10 },
    'libido': { Potencia: 8 },
    'deseo sexual': { Potencia: 10 },
    'rendimiento': { Potencia: 6 },
    'energia masculina': { Potencia: 10 },
    'testosterona': { Potencia: 10 },

    // Diabetes
    'muestra gratis diabetes': { Diabetes: 25 },
    'azucar alta': { Diabetes: 15 },
    'glucosa': { Diabetes: 15 },
    'diabetes': { Diabetes: 15 },
    'azucar': { Diabetes: 8 },
    'insulina': { Diabetes: 12 },
    'nopal': { Diabetes: 10 },
    'nopal plus': { Diabetes: 15 },
    'hormigueo pies': { Diabetes: 10 },
    'pies hinchados': { Diabetes: 8 },

    // Prostata
    'muestra gratis prostata': { Prostata: 25 },
    'prostata': { Prostata: 15 },
    'chorro debil': { Prostata: 15 },
    'ardor al orinar': { Prostata: 12 },
    'levantarse a orinar': { Prostata: 12 },
    'prostata inflamada': { Prostata: 15 },
    'prostatico': { Prostata: 12 },

    // Colageno
    'muestra gratis colageno': { Colageno: 25 },
    'colageno': { Colageno: 15 },
    'colageno hidrolizado': { Colageno: 20 },
    'arrugas': { Colageno: 10 },
    'caida de cabello': { Colageno: 10 },
    'elasticidad': { Colageno: 8 },
    'regenerador celular': { Colageno: 12 },

    // Vision
    'muestra gratis vision': { Vision: 25 },
    'vision': { Vision: 10 },
    'vista': { Vision: 8 },
    'catarata': { Vision: 15 },
    'cataratas': { Vision: 15 },
    'vista cansada': { Vision: 12 },
    'vision borrosa': { Vision: 15 },
    'ojos rojos': { Vision: 10 },

    // Gastro
    'muestra gratis gastro': { Gastro: 25 },
    'gastritis': { Gastro: 15 },
    'reflujo': { Gastro: 12 },
    'acidez': { Gastro: 10 },
    'colon': { Gastro: 10 },
    'pesadez estomacal': { Gastro: 10 },
    'digestion': { Gastro: 8 },

    // Artritis (Estricta y pura: NUNCA "muestra gratis" sola)
    'muestra gratis artritis': { Artritis: 25 },
    'artritis': { Artritis: 15 },
    'articulaciones': { Artritis: 12 },
    'articulacion': { Artritis: 10 },
    'rodilla': { Artritis: 10 },
    'rodillas': { Artritis: 10 },
    'dolor de rodilla': { Artritis: 15 },
    'cartilago': { Artritis: 12 },
    'crujen': { Artritis: 8 },
    'artrosis': { Artritis: 15 },
    'reuma': { Artritis: 12 }
  },
  campaignWeights: {
    'colageno': { Colageno: 20 },
    'potencia': { Potencia: 20 },
    'diabetes': { Diabetes: 20 },
    'prostata': { Prostata: 20 },
    'vision': { Vision: 20 },
    'gastro': { Gastro: 20 },
    'artritis': { Artritis: 20 }
  }
};

class LearningBrain {
  constructor() {
    this.memory = null;
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      if (fs.existsSync(BRAIN_FILE)) {
        const raw = fs.readFileSync(BRAIN_FILE, 'utf-8');
        this.memory = JSON.parse(raw);
      } else {
        this.memory = JSON.parse(JSON.stringify(INITIAL_SEED));
        this.save();
      }
    } catch (err) {
      console.error('[LearningBrain] Error inicializando memoria, usando semilla:', err.message);
      this.memory = JSON.parse(JSON.stringify(INITIAL_SEED));
    }
  }

  save() {
    try {
      fs.writeFileSync(BRAIN_FILE, JSON.stringify(this.memory, null, 2), 'utf-8');
    } catch (err) {
      console.error('[LearningBrain] Error guardando memoria en disco:', err.message);
    }
  }

  normalize(text) {
    if (!text) return '';
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  extractNgrams(text, maxN = 3) {
    const clean = this.normalize(text);
    if (!clean) return [];
    const tokens = clean.split(' ').filter(t => t.length > 2);
    const ngrams = [];

    // 1-grams
    for (let i = 0; i < tokens.length; i++) {
      ngrams.push(tokens[i]);
      // 2-grams
      if (i + 1 < tokens.length) {
        ngrams.push(`${tokens[i]} ${tokens[i + 1]}`);
      }
      // 3-grams
      if (maxN >= 3 && i + 2 < tokens.length) {
        ngrams.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
      }
    }

    return Array.from(new Set(ngrams));
  }

  /**
   * Predice el tratamiento médico utilizando el cerebro de aprendizaje estadístico.
   */
  predictTreatment(chatText = '', campaignName = '', utmMedium = '') {
    this.memory.stats.totalInferences++;
    const scores = {};
    for (const t of this.memory.treatments) {
      scores[t] = 0;
    }

    const matchedTerms = [];
    const normChat = this.normalize(chatText);

    // 1. Ponderación por N-Gramas aprendidos en el chat
    for (const [phrase, weights] of Object.entries(this.memory.vocabularyWeights)) {
      if (normChat.includes(phrase)) {
        for (const [treatment, weight] of Object.entries(weights)) {
          scores[treatment] = (scores[treatment] || 0) + weight;
          matchedTerms.push({ phrase, treatment, weight });
        }
      }
    }

    // 2. Ponderación por Campaña / Pauta de Meta Ads
    const combinedCampaign = `${campaignName} ${utmMedium}`;
    const normCamp = this.normalize(combinedCampaign);
    if (normCamp) {
      for (const [campKeyword, weights] of Object.entries(this.memory.campaignWeights)) {
        if (normCamp.includes(campKeyword)) {
          for (const [treatment, weight] of Object.entries(weights)) {
            scores[treatment] = (scores[treatment] || 0) + (weight * 1.5);
            matchedTerms.push({ phrase: `campaign:${campKeyword}`, treatment, weight: weight * 1.5 });
          }
        }
      }
    }

    // Ordenar resultados por puntuación descendente
    const sorted = Object.entries(scores)
      .filter(([, sc]) => sc > 0)
      .sort((a, b) => b[1] - a[1]);

    if (sorted.length === 0) {
      return {
        primaryTreatment: null,
        confidence: 0,
        scores,
        matchedTerms: []
      };
    }

    const [topTreatment, topScore] = sorted[0];
    const secondScore = sorted[1] ? sorted[1][1] : 0;
    const confidence = Math.min(100, Math.round((topScore / (topScore + secondScore + 5)) * 100));

    return {
      primaryTreatment: topTreatment,
      confidence,
      scores,
      matchedTerms,
      allMatchedTreatments: sorted.map(([t]) => t)
    };
  }

  /**
   * Retroalimentación de Ground Truth (Venta confirmada en vTiger)
   * Confianza máxima (+10).
   */
  learnFromVtigerSale({ treatment, chatText = '', campaignName = '' }) {
    if (!treatment || !this.memory.treatments.includes(treatment)) return;

    this.memory.stats.learnedFromSales++;
    this.memory.stats.lastLearnedAt = new Date().toISOString();

    // Aprender frases del chat de este cliente
    const ngrams = this.extractNgrams(chatText, 3);
    for (const phrase of ngrams) {
      if (['gratis', 'muestra', 'hola', 'buenas', 'informacion', 'gracias', 'precio'].includes(phrase)) continue;

      if (!this.memory.vocabularyWeights[phrase]) {
        this.memory.vocabularyWeights[phrase] = {};
      }
      const current = this.memory.vocabularyWeights[phrase][treatment] || 0;
      this.memory.vocabularyWeights[phrase][treatment] = current + 10;
    }

    // Aprender campaña publicitaria
    if (campaignName) {
      const normCamp = this.normalize(campaignName);
      if (normCamp.length >= 4) {
        if (!this.memory.campaignWeights[normCamp]) {
          this.memory.campaignWeights[normCamp] = {};
        }
        const currentCamp = this.memory.campaignWeights[normCamp][treatment] || 0;
        this.memory.campaignWeights[normCamp][treatment] = currentCamp + 15;
      }
    }

    this.save();
    console.log(`[LearningBrain] 🧠 Aprendido de vTiger: Venta de [${treatment}] reforzada en memoria.`);
  }

  /**
   * Retroalimentación de Asesor en Vivo (+2)
   */
  learnFromAdvisorChat({ treatment, chatText = '' }) {
    if (!treatment || !this.memory.treatments.includes(treatment)) return;

    this.memory.stats.learnedFromAdvisors++;
    this.memory.stats.lastLearnedAt = new Date().toISOString();

    const ngrams = this.extractNgrams(chatText, 2);
    for (const phrase of ngrams) {
      if (['gratis', 'muestra', 'hola', 'buenas'].includes(phrase)) continue;
      if (!this.memory.vocabularyWeights[phrase]) {
        this.memory.vocabularyWeights[phrase] = {};
      }
      const current = this.memory.vocabularyWeights[phrase][treatment] || 0;
      this.memory.vocabularyWeights[phrase][treatment] = current + 2;
    }

    this.save();
  }

  /**
   * Penalización de Falso Positivo (-5 / +5)
   */
  penalizeAssociation({ phrase, incorrectTreatment, correctTreatment }) {
    if (!phrase) return;
    this.memory.stats.falsePositivesPenalized++;
    this.memory.stats.lastLearnedAt = new Date().toISOString();

    const normPhrase = this.normalize(phrase);
    if (this.memory.vocabularyWeights[normPhrase]) {
      if (incorrectTreatment && this.memory.vocabularyWeights[normPhrase][incorrectTreatment]) {
        this.memory.vocabularyWeights[normPhrase][incorrectTreatment] = Math.max(
          0,
          this.memory.vocabularyWeights[normPhrase][incorrectTreatment] - 5
        );
      }
      if (correctTreatment) {
        const current = this.memory.vocabularyWeights[normPhrase][correctTreatment] || 0;
        this.memory.vocabularyWeights[normPhrase][correctTreatment] = current + 5;
      }
    }

    this.save();
    console.log(`[LearningBrain] ⚖️ Penalización aplicada: [${phrase}] desligado de [${incorrectTreatment}] y vinculado a [${correctTreatment || 'N/A'}].`);
  }

  getMetrics() {
    return {
      version: this.memory.version,
      stats: this.memory.stats,
      vocabularySize: Object.keys(this.memory.vocabularyWeights).length,
      campaignsLearned: Object.keys(this.memory.campaignWeights).length
    };
  }
}

export const learningBrain = new LearningBrain();
