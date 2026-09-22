# LOA ENGINE - BANCO DE MEMORIA Y CONTEXTO MAESTRO

> [!IMPORTANT]
> **REGLA DE ORO DE INICIO DE SESIÓN:**  
> Cuando el usuario inicie una sesión nueva o escriba **"MEMORIA"**, debes leer este archivo de inmediato para cargar todo el contexto operativo, el estado del sistema y la lista de tareas pendientes para trabajar.

---

## 🌍 0. MERCADO Y JURISDICCIÓN OPERATIVA: ESTADOS UNIDOS (USA)
* **País de Operación:** **ESTADOS UNIDOS (USA)** exclusivamente. El negocio atiende al mercado hispanohablante en EE.UU.
* **Moneda:** **Dólares Americanos ($ USD)** para todo valor de oportunidad, montos de facturación (`cf_3392`, `precio_venta`).
* **Formato Telefónico:** **NANP 10 Dígitos** (Código de Área 3 dígitos + 7 dígitos de abonado, ej: `3055551234`). Con código de país es `+1` (11 dígitos, ej: `+13055551234`). La vinculación en vTiger usa estrictamente los 10 dígitos nacionales (`cleanPhone.slice(-10)`).
* **Geografía y Envíos:** Direcciones físicas en EE.UU. (Street, Ave, Blvd, Dr, Apt, Suite, Códigos ZIP de 5 dígitos, Estados como FL, TX, CA, NY, etc.). Descarte automático de países extranjeros.
* **Zona Horaria del Motor:** **America/New_York (EST / EDT)**.
* **Padecimientos Oficiales (vTiger `cf_2610`):** `Artritis`, `Tetosterona`, `Diabetes`, `Hongos`, `Gastro`, `Gummies`.
* **Sedes Operativas:** Multi-tenant aislado entre `PALACIOS` y `BENAVIDES`.

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

### D. Estandarización de Logs Corporativos y Sanity Checks
- Todos los servicios (`chat_router_agent.js`, `learning_brain.js`, `server.js`, `vtiger_sync_agent.js`, etc.) operan bajo el estándar de logging enterprise sin emojis informales (`[SUCCESS]`, `[PROCESSING]`, `[PROPIETARIO]`, `[SYNC]`, `[PURGE]`).
- Pre-flight sanity check (`test_audit_engine.js`) validado al 100% (10/10 reglas aprobadas).

### E. Matriz de Proveedores y Pauta Conectada (Sede PALACIOS)
- **Nueva Subcuenta Palacios (Limpia, Alto Rendimiento):**
  - Location ID: `5NqOaPYqWyIw2FPBfoRg`
  - Token API: `pit-8148816f-fe78-4db8-9b5c-7c6713284b0e`
  - Embudo Maestro: `🚀 Embudo Comercial (Redes - Palacios)` (`YCZePq7oBz7XREDAPtsj`)
- **Regla Oficial ULTRA:** "Todo lo que viene de pauta de ULTRA proviene de CLICK2RING".
  - Fanpage: `BioNatural - Ultra` (`111906554968800`).
  - Responsable: `REDES 2 CLICK2RING` (`RrzgEyi2VOKIJ7Tf54SR` / `fb.palacios.2ultra@gmail.com`).
  - Proveedor: `CLICK2RING`.
  - Origen generado: `PALACIOS-CLICK2RING-FB-MSGR-[PADECIMIENTO]`. Sede fijada canónicamente en `PALACIOS`.
- **Regla Oficial NATURALES BIONATURAL:**
  - Fanpage: `Naturales BioNatural` (`566501466542620`) y `Laboratorios Naturales BIO` (`718150351371765`).
  - Responsable: `REDES 1 ERNESTO` (`8LuTk9jzt5BeaKLxdVru` / `fb.palacios.1@gmail.com`).
  - Si el conjunto/campaña dice `IN HOUSE` (ej: `TETOSTERONA - IN HOUSE - ...`): Proveedor = `IN_HOUSE`, Origen = `PALACIOS-IN_HOUSE-FB-MSGR-[PADECIMIENTO]`.
  - Si dice `ERNESTO` o por defecto en esta fanpage: Proveedor = `ERNESTO`, Origen = `PALACIOS-ERNESTO-FB-MSGR-[PADECIMIENTO]`.
- **Subcuenta Histórica Central Universal (400k Contactos):**
  - Location ID: `ATPYNnsfZ1W8sd6WgWIV` (`pit-4d48784c-23cd-466d-a6b2-4850138e35d0`)
  - Rol: Bóveda histórica universal sin ruteo activo (`allowActiveRouting: false`). Preserva consultas y telemetría histórica sin saturar buffers ni generar colas de ruteo.
- **Captura en Vivo de `adsetName`:** Conectado directamente desde Meta Graph API (`getMetaAdDetails`) hacia `chat_router_agent.js` para detección instantánea de padecimientos y proveedores.

### F. Estrategia 0: Vinculación Inmediata por Teléfono (0.2s)
- **Implementación:** En `vtiger_api_service.js` (`findVTigerContact`), se antepuso la búsqueda por los 10 dígitos directos (`WHERE homephone = '${last10}' OR mobile = '${last10}' OR phone = '${last10}'`).
- **Respaldo para Chat en Vivo:** Conectado con `shippingData.phone` en `chat_router_agent.js`. En cuanto el cliente escribe su teléfono en el chat, el sistema vincula vTiger en el mismo segundo sin depender del nombre de Facebook.

### G. Protocolo de Mudanza de Sede con Tarjeta de Notas Histórica
- **Respeto Estricto a Tiempos de Gracia:**
  - Prospecto sin venta <= 96h (4 días): Bloqueado por escudo de exclusividad.
  - Cliente con venta <= 720h (30 días): Bloqueado por exclusividad de recompra.
- **Mudanza Autorizada (Gracia Expirada):**
  - Si el lead/cliente reingresa por otra sede tras expirar el tiempo de gracia, la mudanza procede automáticamente.
  - **Nuevo Origen Automático:** Se genera al instante el nuevo origen (`[NUEVA_SEDE]-[PROVEEDOR]-[CANAL]-[TRATAMIENTO]`).
  - **Tarjeta de Notas en GHL (`saveMudanzaHistoryNote`):** Inyecta en el perfil del contacto un registro forense completo (Sede anterior, nuevo origen, asesor asignado, fanpage, anuncio, justificación de tiempo de gracia transcurrido e historial de vTiger).
  - **Historial Clínico en vTiger (`cf_noticias` / `VTIGER_NOTAS_FIELD`):** Prepend del registro de mudanza con fecha y sede previa.
  - **Etiquetas de Telemetría:** `mudanza-gracia-expirada`, `mudanza-de-sede`, `mudanza-desde-[sede_previa]`, `sede-[nueva_sede]`.
  - **Rotulado en Pipeline:** `[PRODUCTO] Nombre Cliente | SEDE | Anuncio`.

### H. Regla Universal de Origen Orgánico y Amarre Dinámico de Ad ID
- **Regla Universal Orgánica (Tráfico por Goteo):**
  - Aplica para **todas las páginas en general**: si un contacto no viene de pauta paga (`!isPaidAd`), su proveedor es estrictamente **`IN_HOUSE`** en cualquier sede (`[SEDE]-IN_HOUSE-FB-MSGR-[TRATAMIENTO]`).
  - Medium UTM para orgánico: `messenger` (no `cpc`).
  - Etiquetado inteligente: `organico` y `facebook-messenger` (se purga `meta-ads` erróneo si no tiene pauta previa).
- **Amarre Estricto de Ad ID con su Origen:**
  - Todo ingreso por pauta amarra forzosamente su Meta Ad ID numérico (`/^\d{8,25}$/`) a su campaña y origen estructurado.
  - Inyectado simultáneamente en `contact.id_de_anuncio` (`6w3yMjLgIw6npUKWIosr`) y `contact.ad_id` (`ujLG5Ogp94WfynVubapT`).
- **Actualización Dinámica ("Si es diferente? Se actualiza"):**
  - Si un contacto reingresa con un Ad ID diferente (`latestAdId && currentAdId && latestAdId !== currentAdId`) o transiciona de orgánico a pauta:
    1. Se actualiza su Ad ID en ambos campos custom.
    2. Se consultan detalles de campaña en vivo en Meta Graph API (`getMetaAdDetails`).
    3. Se actualiza `contact.source` al nuevo origen de pauta (`[SEDE]-[PROVEEDOR]-FB-MSGR-[TRATAMIENTO]`).
    4. Se actualizan UTMs (`utm_campaign`, `utm_content`, `utm_medium = 'cpc'`).
    5. Se añade etiqueta `doble-ingreso-publicitario`.
    6. Se inyecta la tarjeta de nota en GHL (`saveAdHistoryNote`) con la estructura canónica oficial:
       - **Caso Misma Sede:**
         ```text
         🚨 [SAVE PROCESS: REINGRESO POR NUEVO ANUNCIO / CAMPAÑA DIFERENTE]
         ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
         - Fecha: [Fecha y Hora Actual] (EST)
         - Origen/Fuente Asignada: [SEDE]-[PROVEEDOR]-FB-MSGR-[TRATAMIENTO]
         - Tratamiento Detectado: [Tratamiento]
         - Nuevo Ad ID: [Nuevo Meta Ad ID]
         - Fanpage de Entrada: [Nombre de Fanpage]
         - Campaña Detectada: [Nombre de Campaña]
         - Interacción: DOBLE INGRESO PUBLICITARIO - Anuncio / Campaña Previa: [Ad ID Anterior]  [Fecha Anterior]  ([SEDE PREVIA] - [CAMPAÑA PREVIA] - [DOLENCIA]) ("tiempo de gracia expirado/ vigencia activa/")
         - Estado de Pauta: ACTUALIZADO (Ad ID y Origen renovados por nuevo anuncio)
         ----------------------------------------
         Powered by LOA Engine - Gabriel Loayza
         ```
       - **Caso Mudanza de Sede (Confidencialidad Multisede Protegida):**
         Cuando ocurre cambio de sede legítimo, **NO se detalla la sede de origen, campaña ni dolencia previa**. Se enmascara estrictamente como `(OTRA SEDE)`:
         ```text
         🚨 [SAVE PROCESS: REINGRESO POR NUEVO ANUNCIO / CAMPAÑA DIFERENTE]
         ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
         - Fecha: 17/9/2026, 12:10:00 (EST)
         - Origen/Fuente Asignada: PALACIOS-ERNESTO-FB-MSGR-Artritis
         - Tratamiento Detectado: Artritis
         - Nuevo Ad ID: 120226588408599999
         - Fanpage de Entrada: Naturales BioNatural
         - Campaña Detectada: ARTRITIS - ERNESTO
         - Interacción: DOBLE INGRESO PUBLICITARIO - Anuncio / Campaña Previa: 120226588408570607  10/9/2026  (OTRA SEDE) ("tiempo de gracia expirado")
         - Estado de Pauta: ACTUALIZADO (Ad ID y Origen renovados por nuevo anuncio)
         ----------------------------------------
         Powered by LOA Engine - Gabriel Loayza
         ```
  - Si el contacto continúa conversando sin un nuevo clic de anuncio, mantiene su Ad ID y origen vinculado sin alteraciones espurias.
- **Batería de Pruebas Protocolares:**
  - Ampliada a **16/16 Reglas protocolares aprobadas (100%)** en `test_audit_engine.js`.

### I. Matriz de Páginas y Campañas Vinculadas (Sede BENAVIDES)
- **1. Fanpages Oficiales y Proveedores Base (Sede BENAVIDES):**
  - `Bio Natural` (`126154270581792`) ➔ Proveedor: **`CLICK2RING`** | Sede: **`BENAVIDES`**
  - `Naturales Bio Corp` (`510617778807469`) ➔ Proveedor: **`ERNESTO`** | Sede: **`BENAVIDES`**
  - `BioNatural Fuerza` (`1147742788423762`) ➔ Proveedor: **`IN_HOUSE`** (`INHOUSE`) | Sede: **`BENAVIDES`**
- **2. Jerarquía de Atribución - Prioridad Máxima al Nombre de Campaña:**
  - Tal como definió la operación (*"ESTA CONFIG ESTA A NIVEL NOMBRE DE CAMPAÑA"*), si el nombre de campaña contiene directivas explícitas, éstas sobreescriben la fanpage de entrada:
    - **Proveedor por Campaña:**
      - Palabras `César`, `Cesar`, `Click2Ring` ➔ **`CLICK2RING`**
      - Palabras `InHouse`, `InHo` ➔ **`IN_HOUSE`**
      - Palabra `Ernesto` ➔ **`ERNESTO`**
    - **Sede por Campaña:**
      - Si la campaña menciona `Piura` (ej. `DIABETES - BENAVIDES (César - Piura)` o `Testosterona -Piura- InHouse -MessengerFB`) ➔ Sede: **`PIURA`**.
      - Si menciona `Benavides` ➔ Sede: **`BENAVIDES`**.
    - **Canal por Campaña:**
      - Palabras `Formulario`, `Form` ➔ Canal: **`FORM`** (ej. `BENAVIDES-IN_HOUSE-FORM-Potencia`).
      - Palabras `MessengerFB`, `FM`, `Messenger` ➔ Canal: **`FB-MSGR`**.
    - **Padecimiento / Tratamiento Oficial:**
      - `Hongos` mapeado canónicamente al catálogo vTiger `cf_2610` (ej. `BENAVIDES-IN_HOUSE-FB-MSGR-Hongos`).
      - `Testosterona` ➔ `Potencia` (vTiger), `Diabetes` ➔ `Diabetes`, `Gastro` ➔ `Gastritis`, `Bio Collagen` ➔ `Colageno`.
- **3. Pre-flight Sanity Check:**
  - Nueva `Regla 4I` validada al 100% cubriendo las 3 fanpages y los 5 patrones de campaña de la imagen.

### J. Arquitectura Multi-Tenant 100% Desacoplada (Palacios y Benavides)
- **1. Orquestador Central (`src/config/sedes_gateway.js`):**
  - Cada sede opera con su propia **Meta Developer App** (App ID, Secret, Token Permanente, Ad Account) para garantizar cuotas de Graph API completamente independientes.
  - Cada sede opera con su propia **Subcuenta de GoHighLevel** (API Key, Location ID) con sus chatters/asesores y WhatsApp/SMS dedicados.
  - Credenciales Benavides registradas: API GHL configurada en variables de entorno (.env), usuarios `REDES 1 BENAVIDES` (`GLC6pCjW4oP76hcT8QuC`) y `REDES 2 BENAVIDES` (`qicGSpBcrbYnPHpXceV2`).
  - Meta API Token Permanente unificado/multicuenta: `EAAUbkNeyC9wBSsq...` (acceso validado a 14 fanpages y 8 ad accounts).
- **2. Omisión de la Regla de Tiempo de Gracia:**
  - Al contar con subcuentas separadas, se eliminó el bloqueo artificial de 4 días / 30 días. Los leads que ingresan a una sede son procesados de inmediato por el equipo y origen de esa sede sin rechazo ni congelamiento.
- **3. Sistema Consultivo Aislado en vTiger CRM:**
  - `findVTigerContact(ghlContact, targetSede)`: Filtra en la consulta directa telefónica con `AND cf_3451 = '${targetSede}'`.
  - Probado y verificado en vivo con el caso Adolfo (`2094148820`): para Benavides resuelve su registro exclusivo `12x2816276`, y para Palacios resuelve su registro exclusivo `12x2817133`, impidiendo sobreescrituras cruzadas.
- **4. Suite Protocolar:** Ampliada a **17/17 Reglas validadas al 100%**.

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

## 3. PENDIENTES PRIORITARIOS

### 📌 Tarea 1: Matriz de Proveedores para Sedes Restantes (Benavides, Roosevelt, Piura)
- **Estado:** Sede PALACIOS completada al 100%.
- **Acción:** Recibir las filas restantes de la hoja de cálculo del usuario para configurar los proveedores de Benavides 1, Benavides 2, Roosevelt y Piura.

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

### 📌 Tarea 3: Estrategia 0 en `findVTigerContact` (Búsqueda Directa por Teléfono de 10 dígitos US)
- **Estado:** ✅ COMPLETADA AL 100%. Implementada en `vtiger_api_service.js` con soporte NANP 10 dígitos (`cleanPhone.slice(-10)`), búsqueda combinada `homephone / mobile / phone` y respuesta en 0.2s.

### 📌 Tarea 4: Telemetría y Smart Lists en el Dashboard de Admin en GHL
- **Contexto:** El usuario necesita ver en su panel de administración:
  - Nuevas Adquisiciones (Leads 100% Nuevos).
  - Leads vTiger Vinculados (con historial y compras previas).
  - Ventas Sincronizadas en vTiger.
  - Blindajes Activos vs Mudanzas Legítimas por Tiempo de Gracia.
- **Acción:** Configurar/verificar las etiquetas y filtros correspondientes en GHL.

---

## 5. 🏁 CHECKPOINT DE GUARDADO (Para continuar mañana)
* **Fecha:** 17 de Septiembre, 2026.
* **Hitos Consolidados:**
  1. **Aprovisionamiento Benavides:** Subcuenta `QXcNBK6XCgpQaZ81Z8pv` creada y mapeada con Pipeline Comercial `Dv8kOeJvsMs9WMyTJAfD` y sus 16 Custom Fields vía API.
  2. **6 Dolencias Oficiales (vTiger `cf_2610`):** Reconocimiento NLP de `Artritis`, `Tetosterona`, `Diabetes`, `Hongos`, `Gastro`, `Gummies` con purga de etiquetas obsoletas.
  3. **Etiquetas Interactivas:** Inyección de `con-telefono`/`sin-telefono` y `compro`/`no-compro` con eliminación mutua forzada.
  4. **Lógica Comercial vTiger:** Ground Truth absoluto para montos ($ USD), purga de falsas compras y sincronización automática bidireccional.
  5. **Jurisdicción USA:** Operación fija en Estados Unidos (USD, 10 dígitos telefónicos NANP, zona horaria EST `America/New_York`).
  6. **Suites de Pruebas:** 18/18 Reglas aprobadas (100% verde en todas las pruebas).
* **Para Mañana:**
  - Desplegar / verificar en Render (`git push origin main`).
  - Configurar las Smart Lists de GHL y revisar el flujo en vivo con leads entrantes.

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
