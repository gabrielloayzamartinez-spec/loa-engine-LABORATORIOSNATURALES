# LOA ENGINE - BANCO DE MEMORIA Y CONTEXTO

## Regla de Oro para el Motor de Inteligencia (Antigravity)
**NUNCA OLVIDAR ESTE ARCHIVO.** Antes de hacer cambios en la arquitectura, lee este documento para entender cómo funciona el ecosistema. Si el usuario escribe **"MEMORIA"**, debes leer este archivo para cargar todo el contexto.

## 1. Arquitectura Base
*   **Trigger Principal:** El Poller (`runExpressAssignment` en `server.js`) es el corazón. Escanea GHL cada 20 segundos (`date_updated`). El ruteo es batcheado (5 por vez, con sleep de 1.5s) para evadir Rate Limits (429).
*   **vTiger Reverse Sync:** Manda la verdad absoluta. Si vTiger dice que el contacto tiene `cf_2610` (Artritis), el script limpia en GHL las otras enfermedades y deja solo Artritis (`vtiger_sync_agent.js`).
*   **Gestión de Concurrencia (Mutex):** GHL y vTiger pueden chocar intentando guardar en GHL. Usamos `contactLocks` (Set global) con timeout (15s) para que si el Reverse Sync está editando un contacto, el Radar espere, y viceversa.
*   **Cola de Reintentos de vTiger:** Si vTiger se cae (error 500, timeout), el contacto entra a una cola local en disco (`vtiger_retry_queue.js`). Un cron revisa cada minuto y procesa si el health-check de vTiger da `OK`.
*   **Learning Brain:** Usa N-Grams limitados a 2,000 entradas para no explotar la memoria RAM. Las escrituras en disco se hacen de forma asíncrona usando debounce de 30 segundos.

## 2. Lecciones Aprendidas (Troubleshooting Histórico)
*   **Delay de Indexación GHL (Mensajes Fantasma):** 
    * *Problema:* El webhook/poller detecta contacto actualizado pero al consultar mensajes, vienen vacíos.
    * *Solución:* Se implementó `RETRY_INDEXING` (mapa de memoria con max 2 reintentos por contacto). El Poller no lo marca como procesado hasta confirmar si de verdad no hay mensajes.
*   **Exceso de llamadas a Meta API:** 
    * *Problema:* Cada clic consultaba la API Graph. 
    * *Solución:* Caché local de 1 hora en `meta_api_service.js`.
*   **Dormitar del Servidor:** 
    * *Solución:* Watchdog implementado. Si `lastRadarActivity` supera los 5 minutos, la consola tira alerta crítica.

## 3. Comandos y Endpoints de Mantenimiento
*   `/health`: Panel HTML interactivo que muestra las métricas de ruteo y estado de conexión vTiger.
*   `/api/audit/report`: Devuelve el estatus del watchdog, el tamaño de la cola vTiger y el progreso del script de limpieza masiva (`mass_cleanup.js`).
*   `npm run cleanup` o ejecutar directamente `node src/scripts/mass_cleanup.js` para limpiar y actualizar contactos antiguos paginando suavemente de a 50 leads cada vez.
