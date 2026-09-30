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

### 0. REFACTOR DE ARQUITECTURA (Servicios Duros, Colas y Fail-Safe) — 2026

- **Purgado total del "GHL Central":** eliminado `SEDES_GATEWAY.CENTRAL`, las banderas `isUniversalCentral` / `allowActiveRouting`, la huella de token del cliente HTTP (`ghl_http_client.js`) y todas las guardas de "bóveda pasiva" en router, curador, oportunidades y agentes. Enrutamiento estrictamente **punto a punto**.
- **PIT de Palacios rotado:** vive únicamente en `process.env.GHL_API_KEY_PALACIOS` (ver `Secrets Rotation Log` más abajo).
- **`src/config/secrets.js` (nuevo):** cargador fail-safe de secretos. Cero fallbacks hardcodeados; clasifica cada variable como crítica u opcional, enmascara valores con `redact()`, y en Render **advierte pero no detiene** el arranque por un secreto opcional.
- **`src/config/routing_tables.js` (nuevo):** pipelines, etapas y los 29 Custom Field IDs de cada sede. Ningún ID de GHL hardcodeado en router/middleware.
- **`src/services/queue/durable_queue.js` (nuevo):** BullMQ + Redis detrás del feature flag `QUEUE_DRIVER` (`memory` | `bullmq`), con reintentos exponenciales, **Dead Letter Queue** y fallback automático a cola en proceso si Redis no responde (el deploy nunca cae).
- **`src/utils/circuit_breaker.js` (nuevo):** Opossum por proveedor externo (GHL / vTiger / Meta). Los 4xx de negocio no abren el circuito; 429 y 5xx sí.
- **`src/services/state/state_store.js` (nuevo):** estado stateless con drivers `postgres` (`DATABASE_URL`, tabla `loa_state`) y `file` (escritura atómica tmp+rename). Migrados el **learning_brain** y los **cursores del curador**.
- **`src/scripts/preflight.js` (nuevo):** gate de arranque offline (secretos + 29 reglas + presupuesto < 5 s). Reemplaza la validación manual antes del merge.
- **`src/scripts/verify_boot.js` (nuevo):** smoke test de la malla de rutas sin abrir puertos ni tocar la red.
- **`src/app.js` (nuevo) / `src/server.js` (runtime):** separación estricta entre malla HTTP y side effects. Importar la app ya no dispara tráfico contra GHL/vTiger.
- **Apagado ordenado:** SIGTERM/SIGINT cierran colas, persisten estado y vuelcan el learning_brain antes de salir.

### 0.1. VOCABULARIO CLÍNICO CANÓNICO Y BUG DE APRENDIZAJE PERDIDO — 2026

**Bug corregido (pérdida silenciosa de datos de venta):**
`vtiger_sync_agent.js` clasificaba el `cf_2610` con su propia cadena de `includes()`
y emitía **`'Tetosterona'`**, mientras `LearningBrain.learnFromVtigerSale()` sólo
acepta nombres canónicos (`'Potencia'`). Como la validación era
`if (!treatments.includes(treatment)) return;` **sin log**, toda venta de
testosterona que entraba por el agente inverso vTiger → GHL se descartaba sin
dejar rastro. Verificado en ejecución antes de corregir.

**Bugs adicionales del mismo origen:**
- `Hongos` y `Gummies` (2 de los padecimientos oficiales) **no existían** en el
  catálogo del cerebro: era imposible que aprendieran, para siempre.
- `vtiger_api_service.js` mapeaba `cf_2610` con otra lista distinta (sin Hongos ni
  Gummies y sin reconocer "Tetosterona").
- `background_curator.js` purgaba etiquetas sobre una lista local que omitía
  Hongos y Gummies → etiquetas huérfanas que nunca se limpiaban.
- `agent4_tag_corrector.js` etiquetaba `rodilla` y `articulaciones` (síntomas de
  Artritis) como **`Colageno`**.
- `'gomitas de colágeno y biotina'` resolvía a `Colageno` en los agentes inversos
  porque el síntoma ganaba a la forma farmacéutica (el NLP ya lo hacía bien).

**Solución:** una única fuente de verdad, `src/domain/clinical_vocabulary.js`
(`normalizeTreatment`, `toProductTag`, `reconcileProductTags`), consumida por el
LearningBrain, el agente inverso, la calibración masiva de vTiger, el curador, el
router y el Agente 4. El descarte de un tratamiento desconocido ahora emite
`[LearningBrain] [SKIP]` en lugar de desaparecer.

**Mapeo oficial vTiger ↔ interno:** `Tetosterona` (vTiger) = `Potencia` (interno).
La etiqueta legada `producto-tetosterona` sigue reconocida para poder **migrarla y
purgarla** hacia `producto-potencia` en los contactos reales.

**Auto-reparación:** una memoria `learning_brain.json` persistida antes de este
cambio se reconcilia al cargar (`reconcileTreatments()`), agregando los canónicos
faltantes **sin perder** el vocabulario aprendido.

**Suites nuevas:** `npm run test:vocab` (23 aserciones) y chequeo en `preflight`
que bloquea el deploy si algún padecimiento oficial deja de ser aprendible.

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
- Pre-flight sanity check (`test_audit_engine.js`) validado al 100% (29/29 reglas aprobadas, ejecución síncrona < 5 s).

### E. Matriz de Proveedores y Pauta Conectada (Sede PALACIOS)
- **Subcuenta Palacios (Limpia, Alto Rendimiento, PIT rotado 2026):**
  - Location ID: `5NqOaPYqWyIw2FPBfoRg`
  - Token API: **exclusivamente en `process.env.GHL_API_KEY_PALACIOS`** (nunca en el repositorio).
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
- **Arquitectura DESCENTRALIZADA (vigente desde 2026):**
  - El modelo de "GHL Central" / Bóveda Universal fue **DEPRECADO y purgado** del gateway, del router, de los servicios y de los tests.
  - Ya no existen `SEDES_GATEWAY.CENTRAL`, `isUniversalCentral` ni `allowActiveRouting`.
  - Cada sede es un tentáculo hermético: **su propio PIT + Location ID + pipeline + custom fields**, con enrutamiento estrictamente punto a punto (`resolveSedeContext`).
  - Un `locationId` no registrado resuelve a `UNRESOLVED` (fail-safe): se rechaza el ruteo en lugar de caer por accidente en la subcuenta de Palacios.
  - La base histórica de 400k contactos queda **fuera del gateway operativo** (referencia de solo lectura vía scripts ad-hoc; no participa del ruteo ni de la curación).
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
  - **Historial de mudanza en GHL (`contact.vtiger_historial_completo`):** Prepend del registro de mudanza con fecha y sede previa. Vive en un **custom field de GHL** (IDs por sede en `routing_tables.js`), NO en vTiger. `cf_noticias` fue eliminado del diccionario: su uso previsto era escribir en vTiger (prohibido) y además está denegado para el rol de API.
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
- **1. Orquestador Descentralizado (`src/config/sedes_gateway.js`):**
  - Cada sede opera con su propia **Meta Developer App** (App ID, Secret, Token Permanente, Ad Account) para garantizar cuotas de Graph API completamente independientes.
  - Cada sede opera con su propia **Subcuenta de GoHighLevel** (PIT, Location ID) con sus chatters/asesores y WhatsApp/SMS dedicados. **No existe subcuenta maestra.**
  - Las tablas de pipeline, etapas y Custom Field IDs viven en `src/config/routing_tables.js` (cero IDs hardcodeados en router y middlewares).
  - Credenciales: **todas** en variables de entorno (`.env` local / dashboard de Render). Cero tokens en el código fuente.
  - Meta API Token Permanente unificado/multicuenta: exclusivamente en `process.env` (nunca versionado; acceso validado a 14 fanpages y 8 ad accounts).
- **2. Omisión de la Regla de Tiempo de Gracia:**
  - Al contar con subcuentas separadas, se eliminó el bloqueo artificial de 4 días / 30 días. Los leads que ingresan a una sede son procesados de inmediato por el equipo y origen de esa sede sin rechazo ni congelamiento.
- **3. Sistema Consultivo Aislado en vTiger CRM:**
  - `findVTigerContact(ghlContact, targetSede)`: Filtra en la consulta directa telefónica con `AND cf_3451 = '${targetSede}'`.
  - Probado y verificado en vivo con el caso Adolfo (`2094148820`): para Benavides resuelve su registro exclusivo `12x2816276`, y para Palacios resuelve su registro exclusivo `12x2817133`, impidiendo sobreescrituras cruzadas.
- **4. Suite Protocolar:** Ampliada a **29/29 Reglas validadas al 100%** (`preflight` offline, < 5 s, sin red).

---

## 2. ARQUITECTURA OPERATIVA DEL PROYECTO

### 2.00. PROTOCOLO DE GOBERNANZA Y AISLAMIENTO DE SEDES (INNEGOCIABLE)

> **NO CONFUNDIR CON EL "GHL CENTRAL" DEPRECADO.** Dos conceptos se llamaron
> igual y NO son lo mismo:
>
> | | **GHL Central (DEPRECADO)** | **Cuenta Empresa (VIGENTE)** |
> | --- | --- | --- |
> | Rol | Hub de enrutamiento y bóveda operativa | **Solo analítica macro** (reportes) |
> | Rutea leads | Sí | **No** |
> | Gestiona chats | Sí | **No** |
> | Asigna asesores | Sí | **No** |
> | Location ID | `ATPYNnsfZ1W8sd6WgWIV` | el mismo, con **otro rol** |
>
> La purga del hub central sigue vigente: no existen `SEDES_GATEWAY.CENTRAL`,
> `isUniversalCentral` ni `allowActiveRouting`, y **ningún ruteo pasa por la
> Empresa**. Si alguien propone "enrutar desde la Central", está reintroduciendo
> el hub deprecado y debe rechazarse.
>
> **Regla de niveles (decidida por el negocio):** la Cuenta Empresa ve el
> historial GLOBAL del cliente (todas las sedes) porque su fin es la analítica de
> empresa; las subcuentas de sede ven **únicamente** lo suyo. Un asesor de
> Benavides jamás ve una compra hecha en Palacios.

> Aplicable a **toda** refactorización de `vtiger_api_service.js`,
> `commercial_engine.js` y las rutas de webhooks. Blindado por
> `src/tests/test_sede_governance.js` (69 aserciones) y por el paso 5 del
> `preflight`, que **bloquea el deploy** si se rompe.

**1. vTiger = sensor de SOLO LECTURA. Regla impuesta, no documentada.**

> **LOA ENGINE NO ESCRIBE, NO MODIFICA Y NO INYECTA DATOS EN EL CRM. NUNCA.**
> vTiger se usa para **ver y oír**: se lee y jamás se altera. Este principio es
> independiente de que la cuenta sea de Administrador con acceso global: el
> privilegio existe para LEER toda la data necesaria, no para escribir.

El candado se aplica en **tres capas** dentro de `src/services/vtigerClient.js`
(`vtigerFetch` es el único punto por el que salen peticiones al CRM):

| Capa | Control | Qué bloquea |
| --- | --- | --- |
| 1. Método HTTP | `assertReadOnlyHttpMethod()` | `PUT`, `PATCH`, `DELETE`. POST sólo para el handshake de `login` |
| 2. Operación API | `assertAllowedOperation()` | allow-list: `query`, `getchallenge`, `login`. Bloquea `create`, `update`, `delete`, `revise`, `save`, `massupdate`, `import` |
| 3. Sentencia SQL | `assertReadOnlyStatement()` | Toda sentencia que no empiece por `SELECT`, y los verbos `UPDATE/DELETE/INSERT/DROP/ALTER/TRUNCATE/REPLACE/MERGE/GRANT/REVOKE/EXEC` + `SELECT ... INTO` |

Todo intento se **audita** como `VTIGER_READ_ONLY_VIOLATION` (severidad
`critical`) en `logs/audit_sync.jsonl` y se contabiliza en `readOnlyGuardStats`.

**Hallazgo que originó el candado:** el gate de aislamiento sólo verificaba la
presencia de `cf_3451`, así que `DELETE FROM Contacts WHERE cf_3451 = 'PALACIOS'`
pasaba como "consulta válida". La regla estaba escrita en la documentación pero
**no impuesta en el código**. Ahora una escritura es estructuralmente imposible.

Único POST legítimo: `operation=login` (autenticación, no modifica datos).

**2. Sede-Lock.** Cada subcuenta de GHL corresponde a una sede física única. Toda
consulta con datos de cliente se parametriza por sede, con **estrategia por módulo**
(verificada contra la API real):

| Módulo | Estrategia | Regla |
| --- | --- | --- |
| `Contacts`, `Leads`, `Potentials` | `direct` | WHERE **debe** incluir `cf_3451 = '<SEDE>'` |
| `SalesOrder`, `Invoice` | `contactLink` | No poseen `cf_3451`: se acotan por `contact_id` y declaran `inheritedSede` |

El **gate** vive en el borde de la API (`query()` en `vtigerClient.js`): una
consulta que viole el protocolo lanza `SedeLockViolation` antes de salir a la red.
Si la sede no es resoluble, la operación **se aborta** — jamás se degrada a una
consulta global.

**3. Sede-Shield (cero rastro de ventas ajenas).** Si el historial de compras de
vTiger pertenece a OTRA sede, queda 100% invisibilizado para el GHL de la sede
actual: sin `precio_venta`, sin fechas de compra, sin `spl_num_compras`. El lead se
cataloga **No Comprador / SIN VENTA**. La puerta única de decisión es
`evaluateCommercialTruth(ghlContact, vContact, sedeActiva)`: si la sede no coincide,
el registro se trata como **inexistente** (fail-closed).

**4. Higiene de datos.** Todo campo heredado por error de otra sede
(`vtiger_sede__tienda_compra`, `contact_no`, `id_cliente`) se purga a vacío en la
subcuenta receptora.

**Bugs reales corregidos al aplicar este protocolo (2026):**
- `getSalesHistory(contactId)` se llamaba **sin sede** desde `historial_healer.js`:
  inyectaba en GHL compras, montos y fechas de la otra sede.
- `evaluateCommercialTruth()` **no recibía la sede**: cualquier llamada directa
  propagaba el historial ajeno (se apoyaba sólo en `buildSanitizedCommercialFields`).
- `fetchRecentConfirmedSales()` leía la base **completa** sin filtro de sede.
- Se asumía `PALACIOS` cuando la ubicación no se resolvía (ahora: fail-closed).
- La búsqueda por teléfono se hacía **global** y se filtraba en JavaScript: los
  registros de la otra sede viajaban por la red hasta el motor.

### 2.0.1. LÍMITES DEL PARSER DE VTIGER (cada uno causó un bug silencioso)

1. **Sin paréntesis** en el `WHERE` → `Syntax Error: PARENOPEN`. Condiciones planas.
2. **Sin `WHERE 1=1`** → `Permission to access 1 attribute denied`.
3. **`cf_3451` no existe en `SalesOrder`/`Invoice`** → el filtro rompe la consulta.
4. **`cf_noticias` denegado** para el rol de API.
5. **`contactid` no es el vínculo**: el correcto es **`contact_id`**.

> Un `catch` que devuelve `[]` convierte cualquier error de la API en "no hay
> datos" y el motor deja de aprender **en silencio**. `query()` audita todo fallo
> antes de propagarlo; nunca tragues errores de vTiger sin registrarlos.


### 2.0. SEGURIDAD, AUTENTICACIÓN CENTRALIZADA Y RESILIENCIA — 2026

**Decisión arquitectónica vigente:** vTiger se consulta con **UNA (1) cuenta de
Administrador con acceso global** (`VTIGER_URL` / `VTIGER_USERNAME` /
`VTIGER_ACCESS_KEY`). El aislamiento multi-sede **no** se hace con credenciales
distintas: lo garantiza el motor condicionando cada consulta por el campo nativo
de sede (`cf_3451`). Un solo token maestro = un solo punto que proteger y rotar.

| Componente | Archivo | Función |
| --- | --- | --- |
| Cliente vTiger centralizado | `src/services/vtigerClient.js` | Sesión Admin global, diccionario nativo de módulos/campos `cf_`, reintentos |
| Saneado estricto | `src/utils/sanitize.js` | Allow-list, anti prototype-pollution, anti XSS, saneado de consultas |
| Log de auditoría | `src/services/audit_logger.js` | JSONL estructurado en `logs/audit_sync.jsonl`, rotación y redacción |
| Cola de reintentos | `src/services/vtiger_retry_queue.js` | Backoff exponencial + jitter, idempotencia, DLQ, estado durable |

**Aislamiento multi-tenant (crítico):** `sedeClause()` valida la sede contra una
allow-list (`PALACIOS`, `BENAVIDES`, `ROOSEVELT`, `PIURA`). Sin sede válida
devuelve un filtro **imposible** (`__SIN_SEDE__`) en lugar de una cláusula vacía:
una consulta sin filtro leería la base completa y filtraría datos entre sedes.
Saneado ≠ validación: `PALACIOS' OR '1'='1` se "limpiaba" a `PALACIOSOR`, un
nombre plausible pero inválido; la allow-list corta el problema de raíz.

**Endpoints de entrada saneados:** `/webhook/ghl-contact` y `/webhook/vtiger`
aplican `sanitizeContactPayload()` / `sanitizeObject()` con allow-list **antes**
de cualquier log, consulta o escritura. Se detecta y audita el payload
sospechoso (`WEBHOOK_TAINT_DETECTED`) sin bloquear silenciosamente al remitente
legítimo.

**Nomenclatura nativa de vTiger:** `VTIGER_MODULES` (`Contacts`, `Leads`,
`Potentials`, `SalesOrder`, `Invoice`, `Accounts`) y `VTIGER_FIELDS`
(`cf_3451` sede, `cf_2610` tratamiento, `cf_1157` ciudad, `cf_2572` proveedor,
`cf_3507` canal, `cf_3472` campaña, `spl_num_compras`, `cf_3392`, `cf_994`,
`cf_2850`). `buildSelect()` rechaza cualquier módulo fuera de esa lista.

**Reintentos:** `query()` reintenta 3 veces con backoff exponencial **acotado por
el máximo** y jitter (evita que las 2 sedes reintenten sincronizadas). Sólo se
reintentan fallos de red/5xx/429; un error de dato (`mandatory field missing`,
`permission denied`) falla rápido y se audita como `VTIGER_QUERY_FAILED`.

**Observabilidad:** `GET /api/health` expone `vtigerConfig` (enmascarado),
`infrastructure.audit` (contadores) y `infrastructure.queue`. El log completo se
consulta en `GET /api/audit/log?limit=50&type=VTIGER_RETRY_DLQ`.

**Suites:** `npm run test:security` (57 aserciones) y `npm run test:vocab` (42).
El `preflight` bloquea el deploy si el saneado, el aislamiento de sede o el
mapeo clínico se rompen.


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
- **Gate de pre-despliegue (OBLIGATORIO antes de merge a `main`):**
  ```bash
  npm run preflight      # secretos + 29 reglas + presupuesto < 5 s (offline)
  npm run verify:boot    # smoke test de la malla de rutas (sin abrir puertos)
  npm test               # suite offline (NO toca APIs externas)
  ```
- **Pruebas de Regresión Rápidas:**
  ```bash
  node src/tests/test_audit_engine.js
  node src/tests/test_commercial_engine.js
  node src/tests/test_cooldown_mudanza.js
  node src/tests/test_doble_ingreso.js
  node src/tests/test_sede_isolation.js
  ```
- **Prueba con MUTACIONES EN VIVO (usar solo con autorización explícita):**
  ```bash
  npm run test:live      # test_curador_bidireccional.js: escribe en GHL real
  ```
- **Panel de Monitoreo Local:** `http://localhost:3000/health`
- **Salud de infraestructura (colas, breakers, sedes):** `http://localhost:3000/api/health`
- **Revisión de Métricas:** `http://localhost:3000/api/brain/metrics`

---

## 5. SECRETS ROTATION LOG (SIN VALORES)

> **REGLA:** este archivo documenta QUÉ rotar y DÓNDE vive la credencial, nunca el valor.

| Credencial | Variable de entorno | Vive en | Estado 2026 |
| --- | --- | --- | --- |
| GHL Palacios (sede primaria) | `GHL_API_KEY_PALACIOS` + `GHL_API_KEY` (alias) | `.env` local / dashboard Render | **ROTADO** — PIT nuevo emitido por la subcuenta de Palacios |
| GHL Benavides | `GHL_API_KEY_BENAVIDES` | `.env` local / dashboard Render | Vigente (sin rotación solicitada) |
| GHL Roosevelt / Piura | `GHL_API_KEY_ROOSEVELT`, `GHL_API_KEY_PIURA` | dashboard Render | Pendiente (sedes en standby) |
| GHL Central (bóveda 400k) | ~~`GHL_API_KEY_CENTRAL`~~ | — | **ELIMINADO** junto con la arquitectura central |
| vTiger API | `VTIGER_ACCESS_KEY` | `.env` local / dashboard Render | **ROTACIÓN RECOMENDADA** (el valor anterior quedó expuesto en `.env` versionado en el pasado) |
| Meta App Secret Palacios | `META_APP_SECRET_PALACIOS` | `.env` local / dashboard Render | **ROTACIÓN RECOMENDADA** por la misma razón |
| Meta Tokens (Palacios/Benavides) | `META_ACCESS_TOKEN_*` | `.env` local / dashboard Render | **ROTACIÓN RECOMENDADA** |
| Meta Webhook Verify Token | `META_WEBHOOK_VERIFY_TOKEN` | dashboard Render | **ROTAR** si el valor antiguo se filtró |

**Procedimiento de rotación (fail-safe, cero downtime):**
1. Actualizar la variable en el dashboard de Render (Environment) — **no** en el repositorio.
2. Actualizar `.env` local (está en `.gitignore`).
3. `npm run preflight` para confirmar que el motor detecta el secreto y no hay regresiones.
4. Redeploy: Render reinicia con SIGTERM; el motor persiste estado y cierra ordenadamente.
5. Verificar `GET /api/health` → `sedes.*.configured: true`.
