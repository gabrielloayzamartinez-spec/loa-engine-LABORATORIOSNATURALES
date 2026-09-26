#!/usr/bin/env node
/**
 * ==============================================================================
 * LOA ENGINE - EXTRACTOR DE APP EXPRESS (SCRIPT DE MANTENIMIENTO)
 * ==============================================================================
 * Genera `src/app.js` a partir de `src/server.js` para separar:
 *   - app.js    -> malla HTTP pura (sin listen, sin intervalos, sin side effects)
 *   - server.js -> runtime: listen, schedulers, colas, hidratación, shutdown
 *
 * Este script se ejecuta UNA sola vez durante la refactorización. Se conserva
 * en `src/scripts/` como documentación del corte y se elimina en la limpieza
 * posterior (ver AGENT-FIXER: higiene del repositorio).
 *
 * Uso:  node src/scripts/extract_app.js
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SERVER_PATH = path.join(ROOT, 'src', 'server.js');
const APP_PATH = path.join(ROOT, 'src', 'app.js');

const MARKER = "const server = app.listen(PORT, '0.0.0.0', async () => {";

const source = fs.readFileSync(SERVER_PATH, 'utf-8');
const markerIndex = source.indexOf(MARKER);

if (markerIndex === -1) {
  console.error('[extract_app] No se encontró el marcador de app.listen en src/server.js');
  process.exit(1);
}

const head = source.slice(0, markerIndex);
const tail = source.slice(markerIndex);

// ------------------------------------------------------------------------------
// APP.JS: cabecera + registro de rutas (sin ninguna ejecución de red/schedulers)
// ------------------------------------------------------------------------------
const appSource = head
  .replace("import { getQueue, getQueueStatus, shutdownQueues, JOBS, QUEUES } from './services/queue/durable_queue.js';",
           "import { getQueue, getQueueStatus, JOBS, QUEUES } from './services/queue/durable_queue.js';")
  .replace("import { hydrateAllStores, shutdownStateStores } from './services/state/state_store.js';",
           "import { hydrateAllStores } from './services/state/state_store.js';")
  + `\n// ==========================================\n// EXPORT: la malla HTTP no abre puertos por sí sola.\n// El puerto lo abre src/server.js (runtime) o los smoke tests lo omiten.\n// ==========================================\nexport { app, stats, processedContactTimestamps, runExpressAssignment, runUnassignedConversationsGuardian, fetchWithRetry, registerQueueProcessors };\nexport default app;\n`;

fs.writeFileSync(APP_PATH, appSource, 'utf-8');

// ------------------------------------------------------------------------------
// SERVER.JS: runtime delgado (listen + schedulers + shutdown)
// ------------------------------------------------------------------------------
const runtimeSource = `#!/usr/bin/env node
/**
 * ==============================================================================
 * LOA ENGINE - RUNTIME (ENTRY POINT DE PRODUCCIÓN)
 * ==============================================================================
 * Responsabilidades EXCLUSIVAS de este archivo:
 *   1. Abrir el puerto HTTP (Render espera el puerto antes que nada).
 *   2. Auditar secretos y ejecutar el Pre-Flight Sanity Check acotado.
 *   3. Levantar infraestructura diferida (colas durables, estado persistente).
 *   4. Programar los ciclos de fondo (radar, curador, vTiger).
 *   5. Cerrar ordenadamente ante SIGTERM/SIGINT.
 *
 * La malla HTTP y la lógica de webhooks viven en src/app.js.
 * ==============================================================================
 */

${tail
  .replace("const server = app.listen(PORT, '0.0.0.0', async () => {", "const server = app.listen(PORT, '0.0.0.0', async () => {")
}

export { server };
`;

fs.writeFileSync(SERVER_PATH, runtimeSource, 'utf-8');

console.log('[extract_app] Generado src/app.js y reducido src/server.js al runtime.');
console.log(`[extract_app] app.js: ${appSource.split('\n').length} líneas | server.js: ${runtimeSource.split('\n').length} líneas`);
