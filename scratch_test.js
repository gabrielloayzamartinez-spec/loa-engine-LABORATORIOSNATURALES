import { buildVtigerSource } from './src/agents/nlp_symptom_engine.js';

console.log(buildVtigerSource({
  sedeName: 'PALACIOS',
  provider: 'CLICK2RING',
  channel: 'FB-MSGR',
  treatment: 'Artritis'
}));

console.log(buildVtigerSource({
  sedeName: 'PALACIOS',
  provider: 'CLICK2RING',
  channel: 'FB-MSGR',
  treatment: 'General'
}));
