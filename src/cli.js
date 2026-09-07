import readline from 'readline';
import { setupAllPipelines } from './scripts/pipeline_manager.js';
import { runDistributeContacts } from './services/distribute_contacts.js';
import { runHistoricalAssignment } from './scripts/historical_assignment.js';
import { auditAdAttribution, runHistoricalAdAttributionSweep } from './services/ad_attribution_engine.js';
import { spawn } from 'child_process';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function startProcess(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('close', () => showMenu());
}

function showMenu() {
  console.log("\n=================================================");
  console.log("   🎯 PANEL DE CONTROL MAESTRO & RADAR MULTI-TOUCH");
  console.log("=================================================");
  console.log("  1. [Setup Pipelines] Crear/Verificar Pipeline Comercial + Pipeline de Auditoría");
  console.log("  2. [Batch Ventas] Distribuir Contactos al Pipeline Maestro (Precalificado / Calificado)");
  console.log("  3. [Batch Auditoría] Peinado Masivo Multi-Touch & Deducciones a Agencias (CSV)");
  console.log("  4. [Batch Sedes] Mudanza Histórica de Asignación a Vendedores");
  console.log("  5. [Live Server] Iniciar Servidor 24/7 y Dashboard en Vivo");
  console.log("  6. [Auditoría Salud] Verificar Estado General del Sistema");
  console.log("  7. [Salir]");
  console.log("=================================================");
  rl.question("Elige una opción (1-7): ", async (ans) => {
    switch (ans.trim()) {
      case '1':
        await setupAllPipelines();
        showMenu();
        break;
      case '2':
        await runDistributeContacts();
        showMenu();
        break;
      case '3':
        await runHistoricalAdAttributionSweep();
        showMenu();
        break;
      case '4':
        await runHistoricalAssignment();
        showMenu();
        break;
      case '5':
        console.log("\n🚀 Iniciando Servidor 24/7 y Dashboard...");
        startProcess('node', ['src/server.js']);
        break;
      case '6':
        startProcess('node', ['src/scripts/audit_system_health.js']);
        break;
      case '7':
        console.log("👋 Saliendo del Panel de Control.");
        process.exit(0);
      default:
        console.log("❌ Opción inválida. Intenta nuevamente.");
        showMenu();
        break;
    }
  });
}

showMenu();
