# AUDITORÍA NIVEL 1 + NIVEL 2 — CF y ETIQUETAS vTIGER → GHL

**Fecha:** 27-nov-2026 · **Alcance:** 4 subcuentas (Palacios, Benavides, Roosevelt, Piura) · **Modo:** solo lectura sobre producción + correcciones en código
**Producción auditada:** `https://loa-engine-laboratoriosnaturales.onrender.com` (HTTP 200, uptime 65.250 s al momento de la medición)
**Medición en vivo:** 1.200 contactos recientes (300 por sede) + 60 compradores reales de vTiger (15 por sede) + diccionario de campos de las 4 subcuentas.

---

## 0. Resumen ejecutivo

| Pregunta | Respuesta medida |
| :--- | :--- |
| ¿Existen los campos que el motor escribe? | **Sí, los 42 del contrato existen en las 4 subcuentas** (Palacios 56 CF, Benavides/Roosevelt/Piura 54). No falta ningún campo por crear. |
| ¿Están llenos? | **Nivel 1: 95–100%** en las 4 sedes. **Nivel 2 (compradores): 43–45% de huecos en fechas y precio** en Palacios/Benavides. |
| ¿Las etiquetas son las mismas en N1 y N2? | **No.** Cinco módulos producían cinco vocabularios distintos. Medido: 50 contactos de Piura y 11 de Roosevelt con **dos etiquetas de canal** a la vez; 92,9% de los compradores de Roosevelt con el ruido `vtiger` + `vtiger-sincronizado`. |
| ¿El sistema se curaba solo? | **No.** Los 3 jobs one-shot de Nivel 2 tenían un bug de cursor que les impedía avanzar (ver H-3): el re-etiquetado nunca pasó de las primeras 300 páginas. |
| ¿Se podía validar un cambio? | **No.** La suite de pruebas estaba en rojo por 2 aserciones obsoletas: el checklist "30/30" no era ejecutable. |

**Veredicto:** el contrato de campos estaba bien diseñado pero **no se cumplía de punta a punta**. La causa raíz no era un campo faltante: era que **cada proceso escribía su propio subconjunto con su propio vocabulario**, y los jobs de limpieza no avanzaban. Se corrigió el contrato (módulo único), los cinco escritores y los tres cursores.

---

## 1. Mapa de los trabajos auditados (qué corre y cada cuánto)

### Nivel 1 — atención en vivo (prioridad absoluta)

| Job | Disparo | Servicio | Qué escribe |
| :--- | :--- | :--- | :--- |
| Radar de asignación | cada **5 s** | `src/app.js` → `runExpressAssignment` | Enruta conversaciones nuevas por `chat_router_agent` |
| Trabajo del día | cada **3 min** | `reprocesarConversacionesDesde` | Reprocesa los chats de HOY (UTM, Ad ID, origen) |
| Guardián de bandejas | cada **60 s** | `runUnassignedConversationsGuardian` | Revisa conversaciones sin atender |
| Webhook Meta | evento | `/webhook/meta`, `/webhook/facebook` | Entrada en vivo (referral, ad_id, page_id) |

**Costo real medido del Nivel 1:** 3,9 llamadas GHL por contacto en promedio (último: 11; máximo: 15; 13.517 muestras). Es el dato que hay que proteger cuando se relanza Nivel 2.

### Nivel 2 — trabajo de fondo (cede ante Nivel 1)

| Job | Cadencia | Servicio | Qué escribe hoy |
| :--- | :--- | :--- | :--- |
| Curador forward / backward | 60 s por sede | `curador_bidireccional_service` + `sede_agent` | 14 campos estándar vía `syncVtigerContactDual` |
| Reverse sync (demonio inverso) | **3 min** | `vtiger_sync_agent.js` | Campos comerciales + etiquetas propias |
| Re-llenado comercial | 20 min (20 registros) | `commercial_refill.js` → `syncVtigerContactDual` | Historial del comprador |
| Curador de estándar | 20 min (20 registros) | `standard_curator.js` | Re-sync de incompletos |
| Sales Bridge | 10 min | `vtiger_sales_bridge.js` → `syncVtigerBatchDual` | Crea/actualiza compradores |
| Order History | por contacto | `vtiger_order_history_service.js` | Historial, Precio venta, entrega, tracking |
| Backfills one-shot | manual (`/api/nivel2/*`) | `nivel2_retag`, `nivel2_vtiger_backfill`, `nivel2_leads_rp` | Ver H-3/H-4 |

---

## 2. Matriz de escritura: quién escribe qué (ANTES de la corrección)

Cada ✅ significa "este proceso puede escribir ese dato". **El problema se ve en las columnas que discrepan.**

| Dimensión | Router (N1) | Reverse sync | Dual sync | Order history | N2 retag | N2 backfill fechas | N2 leads RP |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Sede Asignada | ✅ | ✅ | ✅ | — | — | — | ✅ |
| Tratamiento | ✅ | — | ✅ | — | — | — | ✅ |
| Proveedor | ✅ | — | ✅ | — | — | — | ✅ |
| Canal Captación | ❌ **(0%)** | ✅ | ✅ | — | — | — | ✅ |
| Campaña / UTM Campaign | ✅ | ✅ | ✅ | — | — | — | ❌ |
| Ad ID / ID Anuncio | ✅ | ✅ | ✅ | — | — | — | ❌ |
| Sexo | ❌ | ✅ | ✅ | ✅ | — | — | ✅ |
| Etapa / Estado Comercial | ✅ | ✅ | ✅ | ✅ (`CONVERTIDO`) | — | — | ✅ |
| Total Compras | ✅ | ✅ | ✅ | ✅ (nº real de órdenes) | — | — | ✅ |
| Fechas de compra | ✅ | ✅ | ✅ | — | — | ✅ (solo 1 fecha) | ❌ |
| **Precio Venta** | ✅ **(acumulado)** | ✅ **(acumulado)** | ❌ | ✅ **(última orden)** | — | — | ❌ |
| Total Histórico | ❌ | — | ✅ | — | — | — | ❌ |
| Fecha Creación | ✅ **(en campo ajeno)** | ✅ **(en campo ajeno)** | ✅ | — | — | ✅ | ✅ |
| Historial / Entrega / Pago / Tracking | — | — | ❌ | ✅ | — | — | ❌ |
| `vtiger` + `vtiger-sincronizado` | purga | **crea** | debía purgar (no lo hacía) | — | purga | — | **crea** |
| Canal canónico (`canal-*`) | crea y **purga** | crea **crudo** (`canal-fb-msgr`) | crea canónico | — | normaliza | — | crea canónico |

**Diagnóstico de la matriz:** no faltaba un campo: **había tres escritores para el mismo campo con semánticas distintas** (`Precio Venta`), **dos para el canal con vocabularios distintos** y **dos que se purgaban mutuamente** (`vtiger*`, `canal-*`).

---

## 3. Medición en vivo (evidencia)

### 3.1 Etiquetas — 300 contactos recientes por sede

| Sede | canal- | prov- | sede- | pagina- | producto- | Sin etiquetas | 2+ canales | 2+ prov |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Palacios | 95,7% | 95,3% | 95,3% | 94,7% | 95,7% | **4,3%** | **8** | 0 |
| Benavides | 99,3% | 100% | 100% | 99,3% | 100% | 0% | 0 | 0 |
| Roosevelt | **80,3%** | **65%** | **65%** | **64%** | 80,7% | **19,3%** | **11** | **2** |
| Piura | 100% | 100% | 100% | **0,7%** | 100% | 0% | **50** | 0 |

### 3.2 Ruido de etiquetas (residuos de versiones anteriores)

| Sede | `vtiger` | `vtiger-sincronizado` | `vtiger-status-*` | `canal-form` (legado) | `canal-fb-msgr` (legado) |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Palacios | 9 | 9 | 9 | 9 | 0 |
| Benavides | 0 | 0 | 0 | 0 | 0 |
| Roosevelt | **58** | **58** | ~70 | **49** | **9** |
| Piura | **294** | **294** | ~55 | **50** | 0 |

> Piura: **294 de 300** contactos con `vtiger` + `vtiger-sincronizado`. Roosevelt: **92,9% de los compradores**. Son exactamente las etiquetas que el Nivel 1 purga y el Nivel 2 volvía a crear.

### 3.3 Compradores reales de vTiger (15 por sede, emparejados por teléfono)

| Sede | Encontrados en GHL | Hueco: Fecha Última/Primera Compra | Hueco: Precio venta | Hueco: Total Histórico | Hueco: Fecha Creación | Hueco: Asesor | Huérfanos de etiqueta |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Palacios | 14/15 | **42,9%** | **35,7%** | 35,7% | 35,7% | 33,3% | `vtiger*` 35,7% |
| Benavides | **11/15** | **45,5%** | **45,5%** | — | — | — | 27,3% |
| Roosevelt | 14/15 | 0% | 0% | 7,1% | 7,1% | 0% | **92,9%** |
| Piura | 12/15 | 0% | 0% | 0% | 0% | 0% | 33,3% |

**Lectura:** el Nivel 2 sí funciona cuando corre (Roosevelt y Piura están al 100% en comercial), pero **en Palacios y Benavides no alcanza a toda la cartera**: 27% de los compradores recientes de Benavides **no existen en GHL** y ~44% de los que sí existen tienen las fechas de compra vacías aunque vTiger las tiene.

Casos concretos (comprador con TODO el bloque comercial vacío en GHL):

- `ONORIO FRIAS` (Palacios): faltan canal, sexo, etapa, contact no, total compras, fechas, precio, ID cliente, asesor, historial.
- `JOSE VILLANUEVA` (Palacios): entró por Messenger y quedó con `revisar-ruteo`; sin ningún campo comercial.
- `TITO PANESSO` (Benavides): etiquetas `producto-desconocido` + `revisar-ruteo`; sin campos comerciales.
- `FREDY FERNANDEZ` (Benavides): tiene `convertido` pero **no** `cliente-vtiger`, y una etiqueta de página sin prefijo (`naturales-bio-corp`).
- `RODOLFO ROMERO` (Benavides): conserva `cola-redes-1` (etiqueta de cola que el contrato ya no usa).

### 3.4 Cobertura de campos del contrato (Palacios, 200 contactos recientes)

| Bloque | Cobertura medida |
| :--- | :--- |
| Identidad / enrutamiento (sede, tratamiento, proveedor, canal, tiene teléfono) | 94–99% |
| Atribución (Ad ID, UTM, conjunto, anuncio) | 74–95% |
| Comerciales (fechas, precio, historial, entrega) | **0,5–2% en la cohorte completa** → se explica porque son leads nuevos; medido sobre compradores sube a 75–100% (§3.3) |

> Esta diferencia es la razón por la que la auditoría nueva separa cohortes: medir campos comerciales sobre leads recién llegados produce "huecos" falsos.

---

## 4. Hallazgos

### CRÍTICOS

**H-1 · Guerra de etiquetas entre N1 y N2**
`chat_router_agent.js` calculaba `canal-*`, lo agregaba al set… y 270 líneas después **borraba todas las etiquetas `canal-*`** cuando el contacto existía en vTiger. El Nivel 2 (`vtiger_sync_agent`) volvía a escribir el canal **crudo** desde `cf_3507` (`canal-fb-msgr`, `canal-form`). Resultado: dos etiquetas de canal por contacto (50 en Piura, 11 en Roosevelt, 8 en Palacios), Smart Views parpadeando y cuota gastada en reescribir lo mismo cada 3 minutos.
**Corregido:** el router conserva el canal; el reverse sync lo normaliza con el contrato.

**H-2 · `Precio Venta` con dos dueños y dos significados**
`commercial_engine.js` (N1 + reverse sync) escribía el **gasto acumulado** (`cf_3392`) en "Precio venta"; `vtiger_order_history_service.js` escribía el **total de la última orden** en el mismo campo. El valor visible dependía de qué ciclo corriera último.
En el mismo archivo, `createdtime` se publicaba en **"Fecha Ultima Asignacion"** (Palacios) o **"Ultima Interaccion"** (Benavides), pisando campos con otra semántica.
**Corregido:** `Precio venta` = última orden (solo order history) y `Total Historico Gastado USD` = acumulado. `Fecha Creacion` usa su propio campo; si la sede no lo declara, no se escribe.

**H-3 · Los 3 jobs one-shot de N2 nunca avanzaban**
En `nivel2_retag.js`, `nivel2_vtiger_backfill.js` y `nivel2_leads_rp.js`:
1. `if (terminado) saveCursor(...); cursorPorSede.clear();` → el `clear()` corría **siempre**: una pasada parcial borraba el cursor y la siguiente volvía a la página 1. Con 49.656 contactos en Palacios, el re-etiquetado **jamás pasó de las primeras 300 páginas**.
2. `saveCursor(...)` se llamaba **antes** de mutar el `Map` → el archivo quedaba con el offset viejo; cada reinicio del servidor rebobinaba el job.
**Corregido:** llaves en el `if`, y se muta antes de persistir. Ahora el re-etiquetado sí progresa y termina.

**H-4 · El backfill de fechas no sincroniza etiquetas (ni el resto de CF)**
`nivel2_vtiger_backfill.js` hace `POST /contacts/upsert` con **un solo custom field** (la fecha) y **ninguna etiqueta**. Si se usa como mecanismo de sincronización, deja contactos sin etiquetas y sin bloque comercial. Se documenta como *job de una sola columna*: no sustituye al dual sync.

**H-5 · Motor reactivo escribe en la subcuenta equivocada**
`vtiger_reactive_sync.js` tenía el campo de tratamiento **hardcodeado de Palacios** (`5Sci2WhOpJq9kZWsLTrp`) para cualquier sede, y `sede || 'PALACIOS'` como valor por defecto. Un evento sin sede escribía en Palacios (viola el aislamiento de canales/dueños) y, además, no crea ninguna etiqueta.
**Estado:** identificado; requiere decisión de negocio (¿se usa el motor reactivo o se retira?). No se tocó para no alterar el contrato del webhook.

### ALTOS

**H-6 · Ruido de etiquetas que nadie limpiaba.** `TAGS_GESTIONADAS` estaba declarado en `dual_sync_service.js` pero **nunca se usaba**: `vtiger` y `vtiger-sincronizado` sobrevivían a cada sincronización. Corregido: el merge pasa por el contrato y las retira.

**H-7 · 27% de compradores recientes de Benavides no existen en GHL.** El Sales Bridge solo barre las últimas 24 h de compras; los compradores anteriores que nunca chatearon no se crean. Requiere una pasada de reconciliación (ver §7).

**H-8 · Fechas de compra vacías en ~44% de los compradores de Palacios/Benavides.** El dato está en vTiger; el refill comercial avanza a 20 registros cada 20 minutos y un solo sede por turno → ~1.440 registros/día frente a decenas de miles de compradores. No es un bug: es capacidad insuficiente para la deuda histórica.

**H-9 · N1 no escribía "Canal Captación".** El router solo escribía `Origen Lead` (cadena compuesta). Cobertura medida: ~0% en leads de Meta. Corregido: ahora escribe el valor con el mismo vocabulario de vTiger (`FB-MSGR`, `FORM`, …).

**H-10 · Piura sin etiquetas de página (0,7%).** Las 300 muestras tienen canal/sede/proveedor/producto al 100%, pero casi ninguna `pagina-*`: el `pageId` no se resuelve para sus chats. Las Smart Views por página de Piura están vacías.

**H-11 · La suite de pruebas estaba en rojo.** `test_audit_engine` fallaba en la Regla 4I (esperaba `BioNatural Fuerza = REDES 2`, el mapa verificado dice `IN_HOUSE`) y en la Regla 23 (30 CF vs 32 reales). Cualquier cambio quedaba sin validación. Corregido: **34/34 reglas + 20 suites en verde**.

### MEDIOS

**H-12 · `producto-testosterona` (76 en Piura) y `producto-desconocido`.** El contrato canónico normaliza `Tetosterona → producto-potencia`, pero nadie purgaba la etiqueta legada en N2 (solo N1 lo hacía). El retag corregido las retira.

**H-13 · `revisar-ruteo` en 61–66% de los leads recientes.** Es la señal de que la evidencia de Meta no alcanza para confirmar página/proveedor. No bloquea el etiquetado, pero ensucia las vistas y esconde un problema real de resolución de página.

**H-14 · `Fuente Última Orden` es un campo huérfano.** Existe en las 4 subcuentas, está al **0%** de llenado y **ningún servicio lo escribe** (solo scripts Python antiguos de `scratch/`). El plan lo reporta como ✅.

**H-15 · Documentación desalineada.**
- `docs/PAGINAS_ETIQUETAS.md` describe `cola-<canal>` como una de las 4 etiquetas estándar; el router ya no las escribe (solo `canal-*`, `prov-*`, `pagina-*`, `sede-*`, `producto-*`).
- `docs/CAMPOS_PERSONALIZADOS_SUBCUENTAS.md` declara "Precio Venta" como NUMERICAL; en Palacios/Benavides es **TEXT**.
- `routing_tables.js` declara `ROOSEVELT: null` y `PIURA: null`, mientras `nivel2_leads_rp.js` mantiene **mapas completos duplicados** de esas dos sedes (riesgo de deriva: si cambia un ID, solo se actualiza un lugar).

---

## 5. Contrato objetivo (la especificación que ahora sí se cumple)

### 5.1 Semántica de cada campo (una sola verdad)

| Campo GHL | Fuente | Quién escribe | Regla |
| :--- | :--- | :--- | :--- |
| Sede Asignada | `cf_3451` / sede de la subcuenta | N1 + N2 | nunca sede ajena (Sede-Shield) |
| Sede / Tienda Compra | `cf_3451` | N2 | — |
| Tratamiento comprado | `cf_2610` normalizado | N1 + N2 | vocabulario clínico canónico |
| Proveedor | `cf_2572` | N1 + N2 | `prov-*` canónico |
| Canal Captación | `cf_3507` / transporte Meta | **N1 + N2** | `FB-MSGR`/`FORM`/`WHATSAPP`/`SMS`/`TIKTOK`/`INSTAGRAM` |
| Origen Lead | compuesto `SEDE-PROV-CANAL-PADEC` | N1 | chat (Meta) |
| Origen Compra | `cf_3472` | N2 | compra (vTiger) |
| Total Compras | `spl_num_compras` / nº real de órdenes | N2 | si hay órdenes, manda el conteo real |
| **Precio venta** | **última orden (`hdnGrandTotal`)** | **solo Order History** | nunca el acumulado |
| Total Histórico Gastado USD | `cf_3392` | solo Dual Sync | acumulado |
| Fecha Última / Primera Compra | `spl_fecha_*` | N2 | monótono (no retrocede) |
| Fecha Creación | `createdtime` | N1 + N2 | **nunca** en Fecha Asignación/Última Interacción |
| Fecha Ultima Asignación | hoy, solo prospecto | N1 | — |
| Historial / Entrega / Pago / Tracking / Último Producto | órdenes | solo Order History | — |

### 5.2 Taxonomía de etiquetas (cerrada)

| Familia | Valores válidos | Regla |
| :--- | :--- | :--- |
| `canal-` | messenger, forms, whatsapp, sms, tiktok, instagram | **una sola** por contacto |
| `prov-` | ernesto, click2ring, in-house, redes-2-benavides, en-casa-g, enzo, up-ideas | una sola |
| `sede-` | palacios, benavides, roosevelt, piura | una sola (hermetismo) |
| `pagina-` | slug del nombre de la página | una sola (la última) |
| `producto-` | catálogo clínico (potencia, diabetes, artritis, …) | una sola |
| estado | `compro`/`no-compro`, `cliente-vtiger`/`prospecto-vtiger`, `convertido` | coherencia obligatoria |
| **PROHIBIDAS** | `vtiger`, `vtiger-sincronizado`, `vtiger-status-*`, `form`, `organico`, `cola-*` | se retiran |

Implementación: `src/domain/ghl_tags.js` (una sola fuente, con `aplicarContratoEtiquetas()`).

---

## 6. Correcciones aplicadas en código

| Archivo | Cambio | Por qué |
| :--- | :--- | :--- |
| `src/domain/ghl_tags.js` **(nuevo)** | Contrato único: `etiquetaCanal`, `etiquetaProveedor`, `etiquetaSede`, `etiquetaProducto`, `canalVtigerDesdeTag`, `esEtiquetaRuido`, `aplicarContratoEtiquetas` | elimina los 5 vocabularios paralelos |
| `src/agents/chat_router_agent.js` | ya no borra `canal-*`; usa `etiquetaCanal`/`etiquetaProveedor`/`etiquetaSede`; **escribe `Canal Captación`** | H-1, H-9 |
| `src/agents/vtiger_sync_agent.js` | no crea `vtiger*` ni `vtiger-status-*`; canal canónico; purga el ruido con el contrato | H-1, H-6 |
| `src/services/dual_sync_service.js` | `mergeTagsPreservingStatus` aplica el contrato (antes `TAGS_GESTIONADAS` era código muerto); etiquetas del payload desde el contrato | H-6 |
| `src/domain/commercial_engine.js` | deja de escribir `Precio Venta` con `cf_3392`; `Fecha Creación` a su propio campo | H-2 |
| `src/services/nivel2_retag.js` | cursor con llaves + orden de persistencia; normaliza `canal-fb-msgr`/`canal-wsp`; purga ruido; 1 POST + 1 DELETE por contacto | H-3, H-12, cuota |
| `src/services/nivel2_vtiger_backfill.js` | cursor con llaves + orden de persistencia | H-3 |
| `src/services/nivel2_leads_rp.js` | etiquetas por contrato; tags **aditivas** (ya no reemplazan las de N1); cursor corregido; mapas duplicados eliminados | H-3, H-13 |
| `src/services/sync_contract_audit.js` **(nuevo)** | auditoría del contrato con cohortes N1/N2 | medición repetible |
| `src/app.js` | ruta `GET /api/auditoria/contrato-sync` | verificación en caliente |
| `src/tests/test_ghl_tags.js` **(nuevo)** | 52 aserciones del contrato | blindaje |
| `src/tests/test_audit_engine.js` | 2 aserciones obsoletas corregidas (Reglas 4I y 23) | H-11 |

**Pruebas:** `20/20 suites en verde` · `34/34 reglas protocolares` · `222` aserciones en `test_dual_upsert` · `52` en el contrato de etiquetas.

---

## 7. Cómo terminar la sincronización (pasos operativos)

> Las correcciones cambian el comportamiento **hacia adelante**. Los datos ya escritos necesitan las pasadas de limpieza de abajo.

1. **Desplegar** (`git push` a Render) y confirmar `/api/health` 200.
2. **Limpiar etiquetas históricas** — ahora sí avanza (H-3):
   ```
   POST /api/nivel2/retag                  (repetir hasta que "terminado": true)
   GET  /api/nivel2/retag/estado
   ```
   Retira `vtiger*`, `vtiger-status-*`, `cola-*` y normaliza `canal-form`/`canal-fb-msgr`. **No añade** etiquetas que falten: eso lo hacen N1 y el dual sync.
3. **Reconciliar compradores ausentes** (H-7): ejecutar el Sales Bridge con ventana amplia o el backfill de compradores por sede, y verificar con
   `GET /api/auditoria/campos-comerciales?sede=BENAVIDES&muestra=50`.
4. **Rellenar el bloque comercial** (H-8): subir temporalmente el lote del refill comercial (de 20 a 200 por turno) **fuera del horario pico**, con `hayCuotaRealDeFondo` como freno.
5. **Verificar el contrato** en las 4 sedes:
   ```
   GET /api/auditoria/contrato-sync?todas=true&paginas=3
   ```
   Objetivo: `saludN1 ≥ 95`, `saludN2 ≥ 95`, `conflictos = 0`, `etiquetasRuido = []`.
6. **Piura (H-10):** revisar por qué no llega `pageId` en sus chats (mapeo de páginas en `page_matrix.js` / webhook). Es el único bloque que requiere diagnóstico adicional.
7. **Documentación:** actualizar `PAGINAS_ETIQUETAS.md` (quitar `cola-*`) y `CAMPOS_PERSONALIZADOS_SUBCUENTAS.md` (Precio Venta = TEXT).

### Presupuesto de cuota

- Retag: 2 llamadas por contacto con algo que limpiar (antes hasta 4). Sobre ~117.000 contactos, el peor caso son ~234.000 llamadas → **debe correrse por tandas** (`maxPaginasPorSede`) y de noche; el Nivel 1 tiene prioridad.
- Auditoría de contrato: ~1 llamada por cada 100 contactos + 1 por sede (12 llamadas para 1.000 contactos). Es segura a cualquier hora.
- Nivel 1 medido: 3,9 llamadas/contacto. No lanzar N2 masivo mientras el radar esté procesando > 5 contactos/ciclo.

---

## 8. Riesgos residuales y pendientes

| # | Pendiente | Riesgo si no se atiende |
| :--- | :--- | :--- |
| 1 | `vtiger_reactive_sync` con field ID de Palacios y sede por defecto (H-5) | escritura en subcuenta ajena; viola gobernanza de aislamiento |
| 2 | `revisar-ruteo` en 60%+ de leads (H-13) | vistas sucias; páginas mal resueltas |
| 3 | `Fuente Última Orden` sin escritor (H-14) | Smart List de recompra sobre un campo vacío |
| 4 | Mapas de Roosevelt/Piura duplicados fuera de `routing_tables` (H-15) | deriva de IDs al cambiar una subcuenta |
| 5 | Piura sin `pagina-*` (H-10) | vistas por página vacías en esa sede |
| 6 | `nivel2_vtiger_backfill` no escribe etiquetas (H-4) | contactos tocados solo por él quedan sin etiquetas |

---

## 9. Anexo: cómo se midió (reproducible)

| Script / endpoint | Qué hace |
| :--- | :--- |
| `scratch/audit_n1_n2_contrato.mjs` | 300 contactos por sede: cobertura de CF, familias de etiquetas, conflictos, ruido |
| `scratch/audit_n2_compradores.mjs` | 15 compradores reales por sede desde vTiger, emparejados por teléfono, campo por campo |
| `GET /api/auditoria/contrato-sync` | versión en producción del mismo contrato, con cohortes N1/N2 |
| `GET /api/auditoria/campos-comerciales` | comparación vTiger ↔ GHL de los campos comerciales (ya existía) |

Salidas crudas: `scratch/audit_out/n1_n2_contrato_2026-11-27.json` y `scratch/audit_out/n2_compradores_2026-11-27.json`.
