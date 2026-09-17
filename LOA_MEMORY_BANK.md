# LOA ENGINE - BANCO DE MEMORIA Y CONTEXTO MAESTRO

> [!IMPORTANT]
> **REGLA DE ORO DE INICIO DE SESIÓN:**  
> Cuando el usuario inicie una sesión nueva o escriba **"MEMORIA"**, debes leer este archivo de inmediato para cargar todo el contexto operativo, el estado del sistema y la lista de tareas pendientes para trabajar.

---

## 1. ESTADO ACTUAL DEL SISTEMA (Logros y Cambios Recientes)

### A. Desbloqueo y Conexión Total con vTiger CRM
- Credenciales validadas con el usuario de API `GABRIEL` (perfil `COORDINATOR`).
- Se verificó acceso `Status 200 OK` a campos críticos: `mobile`, `phone`, `homephone`, `cf_3451` (Sede), `cf_2610` (Padecimiento), `cf_2572` (Proveedor), `spl_num_compras` y `cf_3392` (Monto invertido).
- **Ciudad vTiger (`cf_1157`):** Se descubrió que el campo nativo `mailingcity` estaba restringido por permisos de rol en vTiger, mientras que el campo real que usa la empresa es **`cf_1157`**. Ya está integrado en `chat_router_agent.js` y `background_curator.js`. Desplegado en producción en GitHub/Render ([commit `cd2fa54`](https://github.com/gabrielloayzamartinez-spec/loa-engine-LABORATORIOSNATURALES/commit/cd2fa54)).

### B. Corrección de Meta Ad ID y Purga de Nomenclaturas
- **Causa Raíz Resuelta:** En migraciones históricas, el campo de origen de campaña de vTiger (`cf_3472`, ej. `PALACIOS-ERNESTO-...`) fue mapeado erróneamente al campo de GHL `6w3yMjLgIw6npUKWIosr` ("ID de Anuncio").
- **Solución Implementada:**
  - `isValidMetaAdId(val)`: valida que el Ad ID sea estrictamente una secuencia numérica de 8 a 25 dígitos (`/^\d{8,25}$/`).
  - Recuperación de Meta Ad ID real desde vTiger CRM a través de **`cf_2850`** (ej. caso Jose Amador: recuperó `120226588408570607` y actualizó la campaña real vía Meta Graph API).
  - Purga automática: si un contacto tenía una cadena alfanumérica en el campo de Ad ID, el motor la limpia o la reemplaza por el ID numérico legítimo.

### C. Radar en Vivo de Conversaciones (Detección de Nuevos Chats)
- En `server.js` (`runExpressAssignment`), se incorporó el monitoreo cada 20s de `/conversations/search`.
- Cuando un cliente escribe en Facebook Messenger o Instagram (ej. caso Chago Diaz: "MUESTRA GRATIS POTENCIA"), el motor lo detecta en menos de 20 segundos sin depender de que el contacto sea editado manualmente.
- Se corrigió la lectura de atribuciones para buscar en reversa la atribución que contenga datos de pauta (`attrWithData`), evitando que un reingreso orgánico borre los UTMs del anuncio original.

### D. Estandarización de Logs Corporativos
- Todos los servicios (`chat_router_agent.js`, `learning_brain.js`, `server.js`, `vtiger_sync_agent.js`, etc.) operan bajo el estándar de logging enterprise sin emojis informales (`[SUCCESS]`, `[PROCESSING]`, `[UX-GUARD]`, `[SYNC]`, `[PURGE]`).
- Pre-flight sanity check (`test_audit_engine.js`) validado al 100% (8/8 reglas aprobadas).

---

## 2. ARQUITECTURA OPERATIVA DEL PROYECTO

### Roles de las Herramientas
1. **GoHighLevel (GHL):** Trinchera de atención y chat en vivo.
   - **Misión del Chatter:** Exclusivamente conversar y **extraer el número de teléfono**.
   - No investiga en vTiger ni hace cálculos manuales.
2. **vTiger CRM:** Sistema comercial, facturación, órdenes de venta (*SalesOrder*), compras y logística.
3. **LOA Engine:** Puente autónomo e invisible.
   - Vincula el teléfono extraído con vTiger en 0.2 segundos.
   - Inyecta compras previas, monto invertido, sede original y notas clínicas en GHL.
   - Mueve las oportunidades automáticamente a *Ganado* cuando vTiger confirma la venta.

### Blindaje Hermético vs Robos de Contacto (Tiempo de Gracia)
- **Prospecto Sin Compra (4 Días / 96 horas):** Si el lead le escribe a otra sede dentro de los 4 días, LOA Engine **bloquea el traspaso** y lo mantiene en la sede que pagó la pauta.
- **Prospecto Expirado (+4 días):** Se permite la mudanza legítima a la nueva sede con la etiqueta `mudanza-gracia-expirada`.
- **Cliente Con Compra (30 Días / 1 mes):** Protección total de cartera para el asesor y sede vendedora por 30 días.

---

## 3. PENDIENTES PRIORITARIOS PARA TRABAJAR MAÑANA

### 📌 Tarea 1: Matriz Oficial de Proveedores y Sedes (Nomenclatura Meta)
- **Contexto:** El usuario confirmó que la publicidad de la página *Naturales BioNatural* la gestiona **ERNESTO**, no `CLICK2RING`. En vTiger, el campo `cf_2572` ("Proveedor") contiene: `ERNESTO`, `CLICK2RING`, `IN_HOUSE` (además de `UP_IDEAS`, `ENZO`, `DIURNAY`).
- **Acción:**
  1. Recibir la lista estructurada del usuario con el mapeo:
     - `[Sede, Proveedor, Fanpages Asociadas, Prefijo en Campaña/Anuncio]`.
  2. Eliminar el valor quemado `provider: isPaidAd ? 'CLICK2RING' : 'IN_HOUSE'` en `chat_router_agent.js` y `nlp_symptom_engine.js`.
  3. Mapear dinámicamente según la fanpage y el nombre de la campaña para construir la fuente exacta: `[SEDE]-[PROVEEDOR]-[CANAL]-[PADECIMIENTO]`.

### 📌 Tarea 2: Creación de los 6 Pipelines Dedicados por Producto en GHL
- **Contexto:** El usuario aprobó dividir las oportunidades en GoHighLevel según el desplegable oficial de **PADECIMIENTO** (`cf_2610`) de vTiger:
  1. `🌿 Embudo - Artritis`
  2. `⚡ Embudo - Tetosterona` (Potencia / Vigor / Testosterona)
  3. `🩸 Embudo - Diabetes`
  4. `🍄 Embudo - Hongos`
  5. `🍃 Embudo - Gastro`
  6. `🍬 Embudo - Gummies`
  *(y `🚀 Embudo Comercial (Redes)` como fallback general).*
- **Acción:**
  1. Ejecutar `setupProductPipelines()` en `src/scripts/pipeline_manager.js` para crearlos o descubrirlos en GHL vía API.
  2. Guardar los IDs en `src/config/pipelines_cache.json`.
  3. Ajustar `syncUnifiedPipelineOpportunity` en `ghl_opportunity_service.js` para recibir el padecimiento canónico y enviar la tarjeta al pipeline de producto respectivo.
  4. Nomenclatura de tarjeta: `[PRODUCTO] Nombre Cliente | SEDE | Anuncio`.

### 📌 Tarea 3: Estrategia 0 en `findVTigerContact` (Búsqueda Directa por Teléfono de 10 dígitos)
- **Contexto:** Cuando el chatter extrae el teléfono en GHL, la búsqueda en vTiger debe ser instantánea y no depender de si el nombre de Facebook coincide con vTiger.
- **Acción:**
  - Agregar en `src/services/vtiger_api_service.js`:
    ```javascript
    if (cleanPhone && cleanPhone.length >= 10) {
      const last10 = cleanPhone.slice(-10);
      const q = `SELECT * FROM Contacts WHERE homephone = '${last10}' OR mobile = '${last10}' LIMIT 3;`;
      ...
    }
    ```
  - Probado exitosamente en sandbox: responde en 0.2s devolviendo id, compras y sede original.

### 📌 Tarea 4: Telemetría y Smart Lists en el Dashboard de Admin en GHL
- **Contexto:** El usuario necesita ver en su panel de administración:
  - Nuevas Adquisiciones (Leads 100% Nuevos).
  - Leads vTiger Vinculados (con historial y compras previas).
  - Ventas Sincronizadas en vTiger.
  - Blindajes Activos vs Mudanzas Legítimas por Tiempo de Gracia.
- **Acción:** Configurar/verificar las etiquetas y filtros correspondientes en GHL.

---

## 4. COMANDOS ÚTILES PARA RECORDAR
- **Pruebas de Regresión Rápidas:**
  ```bash
  node src/tests/test_audit_engine.js
  node src/tests/test_commercial_engine.js
  node src/tests/test_cooldown_mudanza.js
  node src/tests/test_doble_ingreso.js
  ```
- **Panel de Monitoreo Local:** `http://localhost:3000/health`
- **Revisión de Métricas:** `http://localhost:3000/api/brain/metrics`
