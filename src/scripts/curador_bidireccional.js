import dotenv from 'dotenv';
dotenv.config();
import { runForwardCure, runBackwardCure, getBiCuratorMetrics } from '../services/curador_bidireccional_service.js';

// Parse command-line args: --sede=BENAVIDES|PALACIOS|ALL --mode=forward|backward|both --limit=N --cycles=N
const args = process.argv.slice(2);
let targetSede = 'BENAVIDES';
let targetMode = 'backward';
let batchLimit = 25;
let maxCycles = 1;
let resetCursor = false;

for (const arg of args) {
  if (arg.startsWith('--sede=')) targetSede = arg.split('=')[1].toUpperCase().trim();
  if (arg.startsWith('--mode=')) targetMode = arg.split('=')[1].toLowerCase().trim();
  if (arg.startsWith('--limit=')) batchLimit = parseInt(arg.split('=')[1], 10) || 25;
  if (arg.startsWith('--cycles=')) maxCycles = parseInt(arg.split('=')[1], 10) || 1;
  if (arg === '--reset') resetCursor = true;
}

async function main() {
  console.log('========================================================================');
  console.log(`🩺 CURADOR BI-DIRECCIONAL MULTI-SEDE - LOA ENGINE`);
  console.log(`   Sede: ${targetSede} | Modo: ${targetMode.toUpperCase()} | Límite por ciclo: ${batchLimit}`);
  console.log('========================================================================\n');

  const sedes = targetSede === 'ALL' ? ['BENAVIDES', 'PALACIOS'] : [targetSede];

  for (const s of sedes) {
    console.log(`\n🏢 >>> Iniciando curación para Sede: [${s}] <<<`);

    if (targetMode === 'forward' || targetMode === 'both') {
      console.log(`\n⏩ [MODO 1: DEL AHORA EN ADELANTE] Escaneando leads y chats recientes en ${s}...`);
      const resForward = await runForwardCure(s, { limit: batchLimit });
      console.log(`✅ Resultado Forward en ${s}:`, resForward);
    }

    if (targetMode === 'backward' || targetMode === 'both') {
      console.log(`\n⏪ [MODO 2: DEL AHORA PARA ATRÁS] Iniciando paginación histórica en ${s} (Ciclos máximos: ${maxCycles})...`);
      for (let cycle = 1; cycle <= maxCycles; cycle++) {
        console.log(`\n--- Ciclo ${cycle}/${maxCycles} en ${s} ---`);
        const resBackward = await runBackwardCure(s, { limit: batchLimit, resetCursor: resetCursor && cycle === 1 });
        console.log(`✅ Resultado Backward (Ciclo ${cycle}):`, resBackward);
        if (resBackward?.isCompleted) {
          console.log(`🎉 ¡Barrido histórico completado al 100% para ${s}!`);
          break;
        }
      }
    }
  }

  console.log('\n========================================================================');
  console.log('📊 MÉTRICAS CONSOLIDADAS DEL CURADOR BI-DIRECCIONAL:');
  console.log(JSON.stringify(getBiCuratorMetrics(), null, 2));
  console.log('========================================================================\n');
}

main().catch(err => console.error('Error fatal en Curador Bi-Direccional:', err));
