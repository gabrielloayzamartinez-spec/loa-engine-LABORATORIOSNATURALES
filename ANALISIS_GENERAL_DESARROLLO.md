# LOA ENGINE — ANÁLISIS GENERAL DEL DESARROLLO

> **Documento de comunicación del trabajo de fondo**
> Sistema de orquestación vTiger CRM → GoHighLevel para Laboratorios Naturales
> Período analizado: ~2 meses de desarrollo (agosto – octubre 2026)
> Estado: **en operación controlada — sincronización masiva en curso**

---

## 1. RESUMEN EJECUTIVO

### Qué es

El **LOA Engine** es un orquestador central (un "pulpo") desplegado en la nube que **conecta dos sistemas que no se hablan entre sí**:

- **vTiger CRM** → donde vive la verdad comercial: compras, montos, órdenes, logística, padecimientos.
- **GoHighLevel (GHL)** → donde trabaja el equipo: chats, asesores, embudos, campañas.

El motor **lee vTiger y espeja la realidad comercial en GHL**, de forma automática, aislada por sede y en tiempo real.

### Por qué existe

Sin el motor, el equipo comercial **trabaja a ciegas**: cuando un cliente escribe por Messenger, el asesor **no sabe** si ese cliente ya compró, cuánto compró, de qué sede viene, qué producto tomó, ni si hay una orden en camino.

**El motor resuelve eso en 0.2 segundos**, en el momento en que el asesor obtiene el teléfono.

### El problema de fondo que se está resolviendo

| Situación encontrada | Magnitud real |
|---|---|
| Compradores de Palacios que **no existían** en su subcuenta de GHL | **98% faltaba** |
| Contactos históricos por sincronizar | **41,879 compradores** |
| Base total que la Cuenta Empresa debe reflejar | **407,032 contactos** |
| Campos comerciales que faltaban crear/renombrar | **27 campos por cuenta** |
| Sincronización de compras → GHL | **funcionando** (526 ciclos verificados) |

### Por qué se pide esperar antes de operar al 100%

Porque **una migración de 41,879 compradores no se hace "encendiendo un botón"**: cada contacto debe:

1. Consultarse en vTiger respetando el aislamiento de sede
2. Resolverse contra GHL por **teléfono** (el único identificador válido)
3. Escribir **27 campos comerciales** + historial de órdenes + datos de compra
4. Aplicar reglas de gobernanza (no contaminar sedes, no escribir en el CRM)

**Operar antes de terminar esta carga es operar con datos incompletos** — exactamente el problema que el motor vino a resolver.

---

## 2. LA META (visión del sistema)

### Arquitectura de tres niveles

```
┌─────────────────────────────────────────────────────────────┐
│                    LOA ENGINE (orquestador)                 │
│              "el pulpo" — Render, 24/7, autónomo            │
└─────────────────────────────────────────────────────────────┘
              │                    │                    │
              ▼                    ▼                    ▼
      ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
      │  PALACIOS    │    │  BENAVIDES   │    │   EMPRESA    │
      │  (sede)      │    │  (sede)      │    │  (BI/análisis)│
      ├──────────────┤    ├──────────────┤    ├──────────────┤
      │ Solo SU data │    │ Solo SU data │    │ TODA la data │
      │ Trabajo      │    │ Trabajo      │    │ Dashboards   │
      │ comercial    │    │ comercial    │    │ Inteligencia │
      │ Embudos,     │    │ Embudos,     │    │ Métricas de  │
      │ asesores,    │    │ asesores,    │    │ ambas sedes  │
      │ remarketing  │    │ remarketing  │    │              │
      └──────────────┘    └──────────────┘    └──────────────┘
           AISLADAS            AISLADAS          UNIFICADA
```

### Los dos roles (decisión de negocio)

| | **Subcuentas de SEDE** | **Cuenta EMPRESA** |
|---|---|---|
| **Rol** | Trinchera comercial | Inteligencia / BI |
| **Ve** | Solo su propia sede | Todas las sedes |
| **Sirve para** | Chats, embudos, asesores, remarketing | Dashboards, analítica, dirección |
| **Aislamiento** | **Hermético** — un asesor de Benavides jamás ve una compra de Palacios | **Unificado** — visión global |
| **Regla de conflicto** | No aplica | **La sede más reciente gana** |

---

## 3. ARQUITECTURA DEL SISTEMA

### Flujo de datos

```
   vTiger CRM                          LOA ENGINE                        GoHighLevel
  (solo lectura)                     (orquestador)                      (trinchera)
        │                                   │                                 │
        │  1. Consulta por teléfono         │                                 │
        │     con filtro de sede            │                                 │
        ├──────────────────────────────────►│                                 │
        │                                   │  2. Resuelve sede, proveedor,   │
        │                                   │     tratamiento, campaña        │
        │                                   │                                 │
        │                                   │  3. Escribe 27 campos           │
        │                                   ├────────────────────────────────►│
        │                                   │                                 │
        │                                   │  4. Historial de órdenes        │
        │                                   ├────────────────────────────────►│
        │                                   │                                 │
        │                                   │  5. Mueve oportunidad a Ganado  │
        │                                   ├────────────────────────────────►│
        │                                   │                                 │
        │  ◄──────── NUNCA SE ESCRIBE ──────┤                                 │
        │         (regla innegociable)      │                                 │
```

### Los 3 principios de diseño

**1. vTiger es un sensor de SOLO LECTURA.**
El motor ve y oye, **jamás altera**. Está impuesto en el código en **3 capas** (método HTTP, operación API, sentencia SQL), no solo documentado. Cualquier intento se audita como violación crítica.

**2. El TELÉFONO es el único factor de vinculación.**
No se usa nombre, ni email, ni ID. Solo el teléfono de 10 dígitos (formato USA/NANP). Es el identificador que el asesor **sí puede obtener** en el chat.

**3. Cada sede es un tentáculo hermético.**
Cada subcuenta tiene su propio token, su propio embudo, sus propios campos. **Cero contaminación cruzada.** Un `locationId` no reconocido **se rechaza** en vez de caer por accidente en otra sede.

---

## 4. INVENTARIO DE LO CONSTRUIDO

### Dimensión del sistema

| Área | Archivos | Líneas | Qué contiene |
|---|---|---|---|
| **Servicios** | 20 | 7,507 | Núcleo: sync, API, colas, atribución, auditoría |
| **Agentes** | 10 | 3,675 | Router de chat, NLP clínico, procesador maestro |
| **Tests** | 14 | 3,059 | Suites de regresión y gobernanza |
| **Scripts** | 27 | 3,267 | Herramientas operativas y de corrección |
| **Utils** | 8 | 1,245 | Saneado, geolocalización, teléfono, reintentos |
| **Config** | 4 | 900 | Secretos, sedes, routing, pipelines |
| **TOTAL** | **88** | **~21,950** | |

### Los servicios clave

| Servicio | Líneas | Responsabilidad |
|---|---|---|
| `dual_sync_service.js` | 1,223 | **Corazón del sistema.** Sincroniza cada contacto a sede + Empresa |
| `vtigerClient.js` | 821 | Cliente vTiger con candado de solo-lectura y aislamiento de sede |
| `vtiger_order_history_service.js` | 597 | Historial de órdenes + datos de compra como campos |
| `ad_attribution_engine.js` | 539 | Atribución publicitaria (de qué anuncio vino el lead) |
| `meta_api_service.js` | 493 | Integración Meta Graph API + validación de credenciales |
| `learning_brain.js` | 485 | Memoria que aprende qué producto corresponde a qué síntoma |
| `vtiger_api_service.js` | 441 | Búsqueda de contactos por teléfono (respuesta 0.2s) |
| `contact_collision_service.js` | 430 | Resolución de colisiones de contacto |
| `token_bucket_queue.js` | 167 | Control de tasa por subcuenta (límite de GHL) |
| `audit_logger.js` | 123 | Log de auditoría estructurado (JSONL) |

### Los agentes clave

| Agente | Líneas | Responsabilidad |
|---|---|---|
| `chat_router_agent.js` | 1,226 | Enruta cada chat: sede, proveedor, tratamiento, atribución |
| `master_processor.js` | 739 | Procesa el contacto maestro (multi-toque) |
| `vtiger_sync_agent.js` | 488 | Sincronización inversa vTiger → GHL (ventas nuevas) |
| `nlp_symptom_engine.js` | 453 | Motor de síntomas: deduce el producto del lenguaje |
| `master_batch_runner.js` | 221 | Ejecución por lotes |

### Las suites de prueba (garantía de calidad)

| Suite | Qué blinda |
|---|---|
| `test_audit_engine.js` | **29 reglas protocolares** (bloquea el deploy si fallan) |
| `test_dual_upsert.js` | 212 aserciones — el corazón del sync |
| `test_sede_governance.js` | 69 aserciones — aislamiento de sedes |
| `test_security_hardening.js` | 57 — saneado y anti-inyección |
| `test_sede_isolation.js` | Aislamiento multi-tenant |
| `test_order_history.js` | 51 — historial de órdenes |
| `test_contact_collision.js` | Colisiones de contacto |
| `test_cooldown_mudanza.js` | Tiempos de gracia en mudanzas |
| `test_doble_ingreso.js` | Reingresos publicitarios |
| `test_ingress_filter.js` | Filtro de entrada |
| `test_queue_policy.js` | Política de colas |
| `test_clinical_vocabulary.js` | Vocabulario clínico canónico |
| `test_curador_bidireccional.js` | Curador bidireccional |
| `test_commercial_engine.js` | Verdad comercial |

---

## 5. LOS PROBLEMAS DIFÍCILES QUE SE RESOLVIERON

Esta es la sección del **trabajo de fondo**. Cada uno de estos fue un bug real, encontrado en producción, que rompía silenciosamente el negocio.

### 5.1. La pérdida silenciosa de ventas por un nombre mal escrito

**El síntoma:** las ventas de testosterona desaparecían sin rastro.

**La causa:** `vtiger_sync_agent.js` emitía `'Tetosterona'` (como lo escribe vTiger), pero el cerebro solo acepta `'Potencia'`. La validación era `if (!treatments.includes(treatment)) return;` **sin log**. Cada venta de testosterona que entraba por el agente inverso **se descartaba sin dejar rastro**.

**La solución:** una única fuente de verdad (`domain/clinical_vocabulary.js`) consumida por **6 módulos**. Ya no puede haber discrepancias.

**Impacto:** se recuperó la capacidad de aprender de **todos** los tratamientos. Además se descubrió que `Hongos` y `Gummies` **no existían** en el catálogo: era imposible que aprendieran, **para siempre**.

---

### 5.2. Fuga de datos entre sedes (el riesgo más grave del negocio)

**El síntoma:** compras, montos y fechas de una sede aparecían en la subcuenta de **otra sede**. Un asesor de Benavides podía ver una compra de Palacios.

**La causa:** 5 bugs independientes:
1. `getSalesHistory()` se llamaba **sin sede**
2. `evaluateCommercialTruth()` **no recibía la sede**
3. `fetchRecentConfirmedSales()` leía la base **completa**
4. Se asumía `PALACIOS` cuando la ubicación no se resolvía
5. La búsqueda por teléfono era **global** y se filtraba después

**La solución:** **Sede-Lock** (toda consulta se parametriza por sede) + **Sede-Shield** (si el historial es de otra sede, se invisibiliza por completo). La puerta única es `evaluateCommercialTruth()`, y si la sede no coincide, el registro **se trata como inexistente** (fail-closed).

**Impacto:** confidencialidad multisede garantizada. Blindado por 69 aserciones.

---

### 5.3. La regla de solo-lectura que estaba escrita pero NO impuesta

**El hallazgo:** el candado de aislamiento solo verificaba que existiera `cf_3451`, así que:

```sql
DELETE FROM Contacts WHERE cf_3451 = 'PALACIOS'
```

**pasaba como "consulta válida"**. La regla de oro ("nunca escribir en el CRM") estaba **documentada pero no impuesta**.

**La solución:** candado en **3 capas** dentro del único punto de salida al CRM:
- Método HTTP: bloquea `PUT`, `PATCH`, `DELETE`
- Operación API: allow-list (`query`, `getchallenge`, `login`)
- Sentencia SQL: bloquea todo lo que no empiece por `SELECT` + verbos peligrosos

**Impacto:** una escritura al CRM es ahora **estructuralmente imposible**. Todo intento se audita como violación crítica.

---

### 5.4. Los límites del parser de vTiger (cada uno causó un bug silencioso)

Se descubrieron **5 restricciones no documentadas** de la API de vTiger:

| # | Límite | Bug que causaba |
|---|---|---|
| 1 | **Sin paréntesis** en el `WHERE` | `Syntax Error: PARENOPEN` |
| 2 | **Sin `WHERE 1=1`** | `Permission to access 1 attribute denied` |
| 3 | `cf_3451` **no existe** en `SalesOrder` | La consulta rompía |
| 4 | `cf_noticias` **denegado** para el rol de API | Fallo silencioso |
| 5 | `contactid` **no es el vínculo** | El correcto es `contact_id` |

**Impacto:** se documentaron y se blindaron. Un `catch` que devuelve `[]` convierte cualquier error en "no hay datos" — y el motor **deja de aprender en silencio**.

---

### 5.5. El "GHL Central" que había que matar

**El riesgo:** existía un hub central que **ruteaba leads**, gestionaba chats y asignaba asesores. Eso contradecía el aislamiento por sede.

**La solución:** se **purgó por completo** (`SEDES_GATEWAY.CENTRAL`, `isUniversalCentral`, `allowActiveRouting`). Hoy la Empresa **solo analiza, no rutea**. Si alguien propone "enrutar desde la Central", está reintroduciendo el hub deprecado.

---

### 5.6. El mismo teléfono, dos personas en vTiger

**El problema:** un mismo número puede tener **dos registros** en vTiger (uno por sede), y el motor podía confundirlos.

**La solución:** `findVTigerContact(ghlContact, targetSede)` filtra con `AND cf_3451 = '<SEDE>'`. **Probado en vivo** con el caso Adolfo (`2094148820`): para Benavides resuelve su registro `12x2816276`, para Palacios `12x2817133`, sin sobreescrituras cruzadas.

---

### 5.7. La atribución publicitaria que se perdía sin avisar

**El problema:** la atribución de anuncios (de qué campaña vino el lead) se perdía sin dejar rastro. El código tenía:

```javascript
} catch (vErr) {
  // Continuar con NLP si vTiger no responde    ← se traga el error
}
```

**El hallazgo clave:** en migraciones históricas, el campo de campaña de vTiger (`cf_3472`, ej. `PALACIOS-ERNESTO-...`) fue **mapeado por error** al campo de "ID de Anuncio" de GHL. Así, el campo de Ad ID contenía **texto**, no un ID numérico.

**La solución:**
- `isValidMetaAdId()` valida estrictamente `/^\d{8,25}$/`
- Recuperación del Ad ID real desde vTiger (`cf_2850`)
- Purga automática de valores inválidos
- Caso real: se recuperó `120226588408570607` y se actualizó la campaña real vía Meta Graph API

---

### 5.8. La caché que envenenaba los campos para siempre

**El problema:** si la resolución de campos de GHL fallaba una vez, se cacheaba un **mapa vacío** de forma **permanente** → pérdida silenciosa de campos para siempre.

**La solución:** solo se cachean mapas **completos**. Los incompletos se reintentan cada 5 minutos y se auditan (`GHL_FIELDS_INCOMPLETE`).

---

### 5.9. El bucle muerto que hacía fallar todo el procesamiento

**El problema:** `master_processor.js` referenciaba una variable **inexistente** (`filteredExplicitTouches`), lo que lanzaba un `ReferenceError` que era **tragado por un try/catch**. Resultado: `processMasterContact` **siempre devolvía `{success:false}`**.

**La solución:** se eliminó el bucle duplicado (el original ya hacía el trabajo).

---

### 5.10. Las carreras del cursor (dos procesos, un cursor)

**El problema:** el scheduler (cada 180s) y el webhook llamaban **al mismo tiempo** a la sincronización inversa, corrompiendo el cursor.

**La solución:** guarda de solapamiento (`reverseSyncCorriendo`) con liberación en `finally`. **Verificado:** 1 ejecuta, 2 se saltan.

---

### 5.11. La Empresa que se congelaba (encontrado hoy, con datos reales)

**El síntoma (detectado en las métricas de producción):**

```
DUAL_SYNC_SEDE_OK ................. 526
DUAL_SYNC_MACRO_OLDER_SEDE_SKIPPED  518   ← 98% OMITIDAS
DUAL_SYNC_MACRO_OK ................   8
```

**La causa:** la regla de merge ("la sede más reciente gana") usaba `<=`, así que **también omitía cuando la fecha era igual** (el mismo contacto re-sincronizado). La Cuenta Empresa **quedaba congelada** y nunca recibía los campos nuevos.

**La solución:** comparación **estricta** (`<`). Solo se protege contra un dato **realmente más antiguo**; si es igual, se escribe y se refrescan los campos.

---

### 5.12. El ritmo de las APIs (el "thundering herd")

**El problema:** las sedes reintentaban **sincronizadas**, saturando vTiger y provocando timeouts (190 abortos).

**La solución:**
- Semáforo de concurrencia (`VTIGER_MAX_CONCURRENT=3`)
- Login "single-flight" (una sola autenticación compartida)
- Backoff exponencial **con jitter** (para desincronizar los reintentos)
- Cola por subcuenta con **cubetas independientes** (cada sede tiene su propio reloj)

---

## 6. LAS REGLAS INNEGOCIABLES (gobernanza)

Estas reglas están **impuestas en el código**, no solo documentadas:

| # | Regla | Dónde se impone |
|---|---|---|
| 1 | **vTiger es SOLO LECTURA** — no se escribe, modifica ni inyecta | 3 capas en `vtigerClient.js` |
| 2 | **El teléfono es el único factor** de vinculación | `pickPhone` / `normalizeToE164` |
| 3 | **Solo COMPRADORES migran** (`spl_num_compras > 0`) | `SOLO_COMPRADORES` en `dual_sync_service.js` |
| 4 | **Sede-Lock** — toda consulta lleva su sede | `sedeClause()` + gate en `query()` |
| 5 | **Sede-Shield** — cero rastro de ventas ajenas | `evaluateCommercialTruth()` |
| 6 | **Fail-closed** — sede no resoluble = se aborta | `resolveSedeContext` |
| 7 | **La Empresa no rutea** — solo analiza | Purga del hub central |
| 8 | **Jerarquía de configuración** (columnas → nombre de campaña → proveedor → fanpage default) | `routing_tables.js` |

### Jerarquía de atribución (de mayor a menor prioridad)

```
1. COLUMNAS del nombre de campaña   (la config vive a nivel de campaña)
2. NOMBRE DE CAMPAÑA               (César→CLICK2RING, InHouse→IN_HOUSE, Ernesto→ERNESTO)
3. PROVEEDOR del anuncio
4. FANPAGE por defecto de la sede
```

---

## 7. ESTADO ACTUAL MEDIDO (evidencia real)

> Datos tomados de producción (`/api/audit/log`, `/api/health`, `/api/empresa/diagnostico`)

### Volumen

| Métrica | Valor |
|---|---|
| Contactos en la Cuenta Empresa | **407,032** |
| Compradores por sincronizar | **41,879** (Palacios 36,629 + Benavides 5,250) |
| Campos personalizados en Empresa | **45** |
| Campos requeridos por sede | **27/27 resueltos** ✅ |

### Eventos de auditoría (1,801 registrados)

| Evento | Cantidad | Significado |
|---|---|---|
| `DUAL_SYNC_SEDE_OK` | 526 | Contactos sincronizados a su sede ✅ |
| `ORDER_HISTORY_SEDE_OK` | 524 | Historiales de órdenes publicados ✅ |
| `DUAL_SYNC_MACRO_OLDER_SEDE_SKIPPED` | 518 | Regla de merge activa (ya corregida) |
| `SEDE_SHIELD_BLOCKED` | 94 | **Aislamiento funcionando** — datos ajenos bloqueados 🛡️ |
| `SYSTEM_MESSAGE_DROPPED` | 62 | Mensajes de sistema filtrados |
| `GHL_FIELDS_INCOMPLETE` | 27 | Detección de cobertura parcial |
| `REVERSE_SYNC_CYCLE` | 21 | Ciclos de sincronización inversa |
| `DUAL_SYNC_MACRO_OK` | 8 | Actualizaciones a la Empresa |

### Garantía de calidad

| Control | Resultado |
|---|---|
| Reglas protocolares | **29/29 al 100%** |
| Suites de prueba | **13 en verde** |
| Aserciones totales | **700+** |
| Gate de despliegue | `preflight` offline **< 5 s** |

---

## 8. POR QUÉ AÚN NO SE OPERA AL 100%

### Lo que YA funciona

✅ Sincronización de compradores → sede (526 ciclos)
✅ Historial de órdenes + datos de compra como campos filtrables
✅ Aislamiento de sedes (94 datos ajenos bloqueados)
✅ Atribución publicitaria (Meta Ad ID → campaña)
✅ Regla de merge en la Empresa
✅ 27/27 campos por sede
✅ Detección de credenciales vencidas

### Lo que FALTA para operar al 100%

| # | Pendiente | Por qué importa | Responsable |
|---|---|---|---|
| 1 | **Carga masiva completa** (41,879 compradores) | Sin esto, la base está incompleta — el 98% faltaba | Motor (en curso) |
| 2 | **Token Meta permanente** (Usuario del Sistema) | Hoy el token es personal y vence cada ~60 días → **la atribución se cae en silencio** | Requiere permiso de PÁGINA (no solo ads) |
| 3 | **Campos de compra en la Empresa** | Los 6 campos de atención no se crearon (decisión: innecesarios para BI) | Decidido — no aplica |
| 4 | **Acelerar la cola** (`GHL_QUEUE_INTERVAL_MS=150`) | Reduce la carga de ~3 días a ~15 horas (4.67×) | Variable en Render |
| 5 | **Smart Lists y Dashboards** | Se configuran manualmente en GHL una vez que los datos estén | Usuario + motor |

### El argumento central para "aguantar"

> **No se puede operar con datos incompletos.**
>
> El motor existe precisamente porque el **98% de los compradores de Palacios no estaba en su subcuenta**. Operar ahora significaría que los asesores sigan trabajando sin ver el historial de compra de sus clientes — **el problema exacto que se está resolviendo**.
>
> Terminar la carga es lo que convierte a GHL en una herramienta **confiable** para el equipo, en vez de una base a medias.

### El riesgo de NO terminar

| Si se opera ahora | Si se termina primero |
|---|---|
| Asesores sin historial de compra | Cada cliente con su compra visible |
| Empresa sin métricas reales | Dashboards confiables |
| Atribución publicitaria incompleta | De qué anuncio vino cada venta |
| Datos de compra en notas (no filtrables) | Smart Lists por estado, pago, producto |

---

## 9. HOJA DE RUTA

### Corto plazo (esta semana)

1. ⏳ **Completar la carga masiva** de 41,879 compradores
2. ⬜ **Activar** `GHL_QUEUE_INTERVAL_MS=150` (acelera 4.67×)
3. ⬜ **Migrar a token permanente** de Meta (Usuario del Sistema)
4. ⬜ **Validar** que los 27 campos se escriben en las 3 cuentas

### Mediano plazo

5. ⬜ **6 Pipelines por producto** (Artritis, Testosterona, Diabetes, Hongos, Gastro, Gummies)
6. ⬜ **Smart Lists** por sede y Empresa
7. ⬜ **Dashboards** de inteligencia (Empresa)
8. ⬜ **Reporte de atribución** (% de leads con ID de Meta resuelto vs DESCONOCIDO)

### Largo plazo

9. ⬜ Sedes Roosevelt y Piura (en standby)
10. ⬜ Matriz de proveedores completa
11. ⬜ Telemetría de mudanzas y blindajes

---

## 10. ANEXOS

### A. Cuentas configuradas

| Cuenta | Location ID | Rol |
|---|---|---|
| **PALACIOS** | `5NqOaPYqWyIw2FPBfoRg` | Sede comercial |
| **BENAVIDES** | `QXcNBK6XCgpQaZ81Z8pv` | Sede comercial |
| **EMPRESA** | `ATPYNnsfZ1W8sd6WgWIV` | Inteligencia / BI |
| ROOSEVELT | *(standby)* | Sede futura |
| PIURA | *(standby)* | Sede futura |

### B. Vocabulario clínico (mapeo oficial)

| vTiger (`cf_2610`) | Interno / producto |
|---|---|
| Artritis | Artritis |
| Tetosterona | **Potencia** |
| Diabetes | Diabetes |
| Hongos | Hongos |
| Gastro | Gastritis |
| Gummies | Colageno |

### C. Campos comerciales por contacto (27)

Compra (total, fechas, monto, histórico) · Sexo · Proveedor · Etapa comercial · Asesor asignado · Fecha de creación · Contact No · ID Cliente · Origen del lead · Campaña · Canal de captación · Tratamiento comprado · Estado comercial · Anotaciones de redes · Historial completo · Estado de entrega · Conformidad · Forma de pago · Transportista · Tracking · Último producto · Sede asignada

### D. Comandos operativos

```bash
npm run preflight      # Gate de despliegue (secretos + 29 reglas, <5s, offline)
npm run verify:boot    # Smoke test de la malla de rutas
npm test               # Suite offline completa (no toca APIs)
node src/tests/test_audit_engine.js   # Reglas protocolares
```

### E. Glosario

| Término | Significado |
|---|---|
| **Sede-Lock** | Toda consulta se parametriza por sede; sin sede válida se aborta |
| **Sede-Shield** | Cero rastro de ventas de otra sede |
| **Mudanza** | Traslado legítimo de un lead de una sede a otra (con tiempos de gracia) |
| **Tiempo de gracia** | 96h (prospecto) / 720h (cliente) de protección de cartera |
| **Cerebro** | Memoria que aprende qué producto corresponde a qué síntoma |
| **Merge** | Regla de la Empresa: la sede más reciente gana |
| **Comprador** | Contacto con `spl_num_compras > 0` (único que migra) |

---

## CONCLUSIÓN

El LOA Engine es un sistema de **~21,950 líneas** que resuelve un problema concreto y medible: **hacer que el equipo comercial vea en GHL la verdad que vive en vTiger**, sin contaminar sedes, sin escribir en el CRM y sin perder atribución.

En ~2 meses se construyeron **88 módulos**, se resolvieron **12 problemas críticos** que rompían el negocio en silencio, y se creó una **red de seguridad de 700+ aserciones** que impide que cualquier cambio futuro degrade el sistema.

**El trabajo de fondo no es "conectar dos sistemas". Es garantizar que los datos sean correctos, aislados, completos y verificables** — porque sobre esos datos el equipo comercial toma decisiones y cobra.

---

*Documento generado a partir del análisis del repositorio y de métricas reales de producción.*
*Powered by LOA Engine — Gabriel Loayza*
