# PLAN MAESTRO — SUBCUENTA "EMPRESA"
## Centro de Medición, Evaluación y Gestión Estructurada (Copia Fiel de vTiger)

> **Versión:** 1.0 · **Estado:** sincronización de 4 sedes implementada, pendiente de deploy
> **Objetivo prioridad 1:** Empresa = espejo de vTiger para medir y decidir, sin operar.

---

## 1. CONCEPTO (qué es y qué NO es la Empresa)

| | SÍ | NO |
|---|---|---|
| **Rol** | Medición, evaluación, gestión | Atención comercial |
| **Chats** | CERO chats | ❌ no rutea, no asigna asesores |
| **Redes** | sin integración | ❌ no conecta FB/IG/WhatsApp |
| **Datos** | copia fiel de vTiger (4 sedes) | ❌ no captura leads externos |
| **Salida** | Smart Lists + Dashboard + SMS interno | ❌ no automatizaciones sociales |

**Regla de oro:** la Empresa **solo lee** el espejo que produce el motor. Es el "tablero de control" del negocio.

---

## 2. ESTADO DE SINCRONIZACIÓN (las 4 sedes)

| Sede | Compradores en vTiger | Subcuenta propia | Espejo a Empresa |
|---|---|---|---|
| **PALACIOS** | ✅ (36,629) | ✅ Sí | ✅ Sí |
| **BENAVIDES** | ✅ (5,250) | ✅ Sí | ✅ Sí |
| **ROOSEVELT** | ✅ | ❌ No (standby) | ✅ **Sí — solo a Empresa** |
| **PIURA** | ✅ | ❌ No (standby) | ✅ **Sí — solo a Empresa** |

**Cambio implementado** (commit `2389901`): Roosevelt y Piura ya **no se descartan** — se espejan **solo a la Empresa**. El criterio de éxito se toma de la Empresa cuando la sede no tiene subcuenta propia.

**Pendiente:** desplegar en Render para que aplique.

---

## 3. ESTRUCTURA DE ETIQUETAS / PROCESOS (fiel a vTiger)

El motor ya inyecta etiquetas que son la **copia fiel del proceso de vTiger**:

| Etiqueta | Qué representa (de vTiger) |
|---|---|
| `sede-palacios` / `sede-benavides` / `sede-roosevelt` / `sede-piura` | La sede (`cf_3451`) |
| `producto-artritis` / `producto-potencia` / `producto-diabetes` / `producto-hongos` / `producto-gastro` / `producto-colageno` | El tratamiento (`cf_2610`) |
| `compro` / `no-compro` | Si es comprador (`spl_num_compras > 0`) |
| `proveedor-click2ring` / `proveedor-ernesto` / `proveedor-in-house` | El proveedor (`cf_2572`) |
| `con-telefono` / `sin-telefono` | Si tiene teléfono válido |
| `mudanza-de-sede` / `doble-ingreso-publicitario` | Procesos de reingreso/mudanza |

**Acción:** estas etiquetas ya existen y el motor las escribe. Las Smart Lists pueden **segmentar por ellas** directamente (sin crear campos nuevos).

---

## 4. SMART LISTS (Paso 1 prioritario)

> GHL **no tiene API pública** para crearlas — se arman en la UI. Aquí está el diseño exacto, listo para copiar.

### A. Base (todo medible desde aquí)

| Lista | Filtro |
|---|---|
| `EMP · Todos los compradores` | `Total Compras` **>** `0` |
| `EMP · Sede Palacios` | `Sede Asignada` **=** `PALACIOS` |
| `EMP · Sede Benavides` | `Sede Asignada` **=** `BENAVIDES` |
| `EMP · Sede Roosevelt` | `Sede Asignada` **=** `ROOSEVELT` |
| `EMP · Sede Piura` | `Sede Asignada` **=** `PIURA` |

### B. 🎯 MEDICIÓN DE VENTAS DE LA QUINCENA (15 días) POR SEDE

**Este es el entregable clave.** Una lista por sede, independiente:

| Lista | Filtro |
|---|---|
| `EMP · 15na Palacios` | `Sede Asignada` **=** `PALACIOS` **Y** `Fecha Ultima Compra` **en los últimos** `15 días` |
| `EMP · 15na Benavides` | `Sede Asignada` **=** `BENAVIDES` **Y** `Fecha Ultima Compra` **en los últimos** `15 días` |
| `EMP · 15na Roosevelt` | `Sede Asignada` **=** `ROOSEVELT` **Y** `Fecha Ultima Compra` **en los últimos** `15 días` |
| `EMP · 15na Piura` | `Sede Asignada` **=** `PIURA` **Y** `Fecha Ultima Compra` **en los últimos** `15 días` |

*(Opcional, más fino: también por proveedor dentro de la quincena, ej. `EMP · 15na Palacios C2R` = sede + proveedor + 15 días.)*

### C. Por comportamiento de compra

| Lista | Filtro |
|---|---|
| `EMP · Compra reciente (7 días)` | `Fecha Ultima Compra` **en los últimos** `7 días` |
| `EMP · Recompra vencida (30-90 días)` | `Fecha Ultima Compra` **entre** `30` y `90` días atrás |
| `EMP · Alto valor (>500)` | `Total Historico Gastado USD` **>** `500` |
| `EMP · Recompradores` | `Total Compras` **>** `1` |

### D. Por producto / tratamiento

| Lista | Filtro |
|---|---|
| `EMP · Producto Artritis` | `Tratamiento comprado` **contiene** `Artritis` |
| `EMP · Producto Potencia` | `Tratamiento comprado` **contiene** `Potencia` |
| `EMP · Producto Diabetes` | `Tratamiento comprado` **contiene** `Diabetes` |
| `EMP · Producto Hongos` | `Tratamiento comprado` **contiene** `Hongos` |
| `EMP · Producto Gastro` | `Tratamiento comprado` **contiene** `Gastritis` |
| `EMP · Producto Colageno` | `Tratamiento comprado` **contiene** `Colageno` |

### E. Por proveedor (evaluación de performance)

| Lista | Filtro |
|---|---|
| `EMP · Proveedor Click2Ring` | `Proveedor` **=** `CLICK2RING` |
| `EMP · Proveedor Ernesto` | `Proveedor` **=** `ERNESTO` |
| `EMP · Proveedor In House` | `Proveedor` **=** `IN_HOUSE` |

### F. Por etiqueta (copia fiel de vTiger)

| Lista | Filtro (etiqueta) |
|---|---|
| `EMP · Compradores (etiqueta)` | etiqueta `compro` |
| `EMP · Mudanzas` | etiqueta `mudanza-de-sede` |
| `EMP · Doble ingreso publicitario` | etiqueta `doble-ingreso-publicitario` |

---

## 5. DASHBOARD INTERNO (conectado a las listas)

En la **misma subcuenta Empresa** → Dashboards → Nuevo. Widgets sugeridos:

| Widget | Tipo | Fuente |
|---|---|---|
| **Total compradores** | Número | lista `EMP · Todos los compradores` |
| **Ventas de la quincena por sede** | Barras | listas `EMP · 15na *` |
| **Distribución por producto** | Pastel | listas de producto |
| **Distribución por proveedor** | Pastel | listas de proveedor |
| **Valor histórico total** | Número | suma de `Total Historico Gastado USD` |
| **Compras por mes** | Línea | `Fecha Ultima Compra` agrupado por mes |
| **Recompra (mes actual)** | Número | `Total Compras` > 1 y `Fecha Ultima Compra` en el mes |

**El dashboard lee las Smart Lists** — por eso las listas van primero.

---

## 6. PIPELINES / WORKFLOWS (gestión empresarial)

Para la Empresa (que no opera), el pipeline es de **gestión**, no de venta:

| Pipeline/Workflow | Propósito |
|---|---|
| **WF: Detección de recompra vencida** | Cuando un cliente cumple 30 días sin comprar → dispara recordatorio (SMS interno) |
| **WF: Alerta de alto valor** | Contacto con `Total Historico` > 500 → etiqueta `vip` para seguimiento |
| **WF: Mudanza de sede** | Ante etiqueta `mudanza-de-sede` → registro de auditoría |

> **Nota:** los workflows de GHL se configuran en la UI (Automations). Aquí se definen los disparadores y condiciones, no el código.

---

## 7. SMS (canal interno)

El SMS es una función **nativa de GHL** (no requiere código del motor):

- **Configuración:** Settings → Phone Numbers → SMS (o el proveedor A2P 10DLC que tengas contratado).
- **Uso previsto:** notificaciones internas de gestión (recompra vencida, alertas de alto valor), **no** campañas sociales.
- **El motor no bloquea SMS:** es independiente de la sincronización.

**Acción manual en GHL:** activar/verificar el número SMS de la subcuenta Empresa.

---

## 8. LIMPIEZA DE DATOS (sin basura)

La Empresa tiene ~407,000 contactos históricos (parte anterior al motor). Plan de limpieza:

| Paso | Qué se limpia | Método |
|---|---|---|
| 1 | Duplicados (mismo teléfono) | Auditoría + merge por teléfono |
| 2 | Campos viejos "vTiger X" | Ya renombrados (IDs preservados) |
| 3 | Contactos sin dato comercial | Identificar (leads sueltos) vs compradores |
| 4 | Valores vacíos (sede, producto, fecha) | Rellenar con el backfill |

**Pendiente:** ejecutar la auditoría de duplicados (lo hago con un script cuando quieras).

---

## 9. CHECKLIST DE EJECUCIÓN

### Tú (manual, UI de GHL)

- [ ] Desplegar en Render (activa las 4 sedes + aceleración)
- [ ] **Desconectar FB/Instagram** de la subcuenta Empresa (Settings → Integrations)
- [ ] Crear las **Smart Lists** de la sección 4 (incluida la quincena)
- [ ] Crear el **Dashboard** (sección 5)
- [ ] Configurar **SMS** (sección 7)
- [ ] Crear los **Workflows** (sección 6)
- [ ] Confirmar que el campo `Asesor Asignado` existe en Empresa

### Yo (código)

- [x] Sincronizar las 4 sedes → Empresa (hecho)
- [x] Contador real de progreso (hecho)
- [x] Aceleración del ritmo (hecho, pendiente deploy)
- [x] Guardián de cuota diaria (hecho)
- [ ] Auditoría de duplicados (cuando lo pidas)

---

## 10. RESUMEN DE LA MEDICIÓN QUINCENAL

**Cómo se ve:** 4 listas (`EMP · 15na <Sede>`), una por sede, filtradas por `Sede Asignada` + `Fecha Ultima Compra en los últimos 15 días`.

**En el dashboard:** el widget "Ventas de la quincena por sede" compara las 4 barras, una por sede. **Cada sede se mide de forma independiente**, y el total se ve en conjunto.

**Filtros de trabajo claros:** sede → quincena → producto/proveedor → etapa. Todo anclado a las etiquetas y campos que ya escribe el motor como copia fiel de vTiger.
