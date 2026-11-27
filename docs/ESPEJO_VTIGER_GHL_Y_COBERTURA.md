# ESPEJO vTIGER → GHL Y COBERTURA REAL (medida)

**Fecha:** 27-nov-2026 · **Regla:** vTiger es la fuente de verdad; GHL refleja **su estado actual** y **todo debe poder actualizarse**.

---

## 1. Política: modo espejo (nuevo por defecto)

Antes, el sincronizador aplicaba un filtro "monótono": un contador sólo se escribía si **subía** y una fecha sólo si era **más reciente**. Consecuencia medida: si vTiger corregía algo (una compra anulada de 3 → 1, una fecha mal cargada), **GHL se quedaba con el dato viejo para siempre**. Eso es copiar y pegar, no sincronizar.

Ahora (`GHL_MODO_ESPEJO=true`, por defecto):

| Situación en vTiger | Antes | Ahora |
| :--- | :--- | :--- |
| Compra corregida 3 → 1 | ❌ no se escribía | ✅ se publica 1 |
| Fecha corregida hacia atrás | ❌ se protegía la de GHL | ✅ se publica la de vTiger |
| Estado/etapa/asesor cambiados | ✅ | ✅ |
| Campo vacío en GHL | ✅ se llena | ✅ se llena |
| `spl_num_compras` llega en 0 con GHL en 5 | ✅ (se escribía 0) | ⛔ **no se borra** (0 es centinela de "no calculado" en este CRM) |

Para volver al comportamiento anterior: `GHL_MODO_ESPEJO=false`.

**Por qué es seguro:** el registro **siempre se relee de vTiger** antes de escribir (backfill, sales bridge y Nivel 3), así que el payload nunca es una foto vieja de la cola. El único "vaciado" que viaja es el del Sede-Shield, que existe para que un dato de otra sede no quede pegado.

---

## 2. Cobertura medida hoy (Palacios, 8 compradores recientes)

`node tools/local_sync.mjs cobertura --sede=PALACIOS --muestra=8`

| Campo | Coincide | Vacío en GHL | Difiere |
| :--- | ---: | ---: | ---: |
| Fecha Creación (DATE) | **0%** | **100%** | 0% |
| Estado de Compra | 14% | 29% | 57% |
| Asesor | 17% | 67% | 17% |
| Campaña | 29% | 0% | 71% |
| Etapa | 29% | 43% | 29% |
| Contact No | 29% | 29% | 43% |
| Fecha Última Compra | 29% | 57% | 14% |
| ID Cliente | 29% | 29% | 43% |
| Canal | 43% | 29% | 29% |
| Total Compras | 43% | 29% | 29% |
| Fecha Primera Compra | 43% | 57% | 0% |
| Total Histórico | 43% | 57% | 0% |
| Sexo | 57% | 43% | 0% |
| Estado | 71% | 0% | 29% |
| Proveedor | 86% | 0% | 14% |
| Sede | **100%** | 0% | 0% |
| Tratamiento | **100%** | 0% | 0% |

**Global: 53 de 118 comparaciones coinciden (45%).**

### Qué significa cada hueco

| Hueco | Causa | Estado |
| :--- | :--- | :--- |
| **Fecha Creación (DATE) 0%** | el dual sync sólo escribía el campo TEXT; el DATE (el que filtra por rango en las Listas Inteligentes) lo escribía un backfill aparte | **corregido**: ahora se publican los dos |
| **Estado de Compra 14%** | sólo lo escribía el router; los compradores del backfill quedaron como "No Comprador" | **corregido**: dual sync + order history lo escriben |
| **Campaña 29% / Etapa 29% / Contact No 29% / ID Cliente 29%** | el comprador entró como lead y el bloque comercial nunca viajó | **corregido** (historial siempre + N3 reactivo) |
| **Asesor 17%** | igual que el anterior | corregido |
| **Fecha Última / Primera / Total Histórico 29–43%** | igual | corregido |
| **Sexo 57%** | vTiger lo tiene en ~24% en Palacios; el resto es dato de origen | no es fallo del motor |

> Este 45% es la **línea base antes de desplegar** los cambios de hoy. El objetivo tras desplegar y re-sincronizar es **≥ 95%** en los campos que vTiger sí tiene.

---

## 3. Campos de vTiger SIN destino en GHL (decisión pendiente)

| Campo vTiger | Por qué no se publica | Recomendación |
| :--- | :--- | :--- |
| `email` | el rol de la API perdió el permiso (`Permission to access '.email'`) | pedir el permiso y reactivar la línea del SELECT |
| `cf_2758` (Estado Repartición: "1-SIN REPARTIR") | no existe campo GHL equivalente | crear campo si se usa para asignar cartera |
| `cf_3388` (Semana del año) | no existe campo GHL | se puede derivar de la Fecha de Creación (no hace falta) |
| `spl_reassign_count` (reasignaciones) | no existe campo GHL | crear sólo si se mide esfuerzo comercial |
| `splareacodes_timezone` | **deliberado**: GHL gestiona su propia zona horaria | no publicar |

Todo lo demás de `VTIGER_FIELDS` tiene destino y se escribe.

---

## 4. Reactividad: que la foto no se quede vieja

Tres carriles garantizan que un cambio en el CRM llegue a GHL:

| Carril | Detecta | Cadencia | Efecto |
| :--- | :--- | :--- | :--- |
| **N3 contactos** | `modifiedtime` del contacto | 60 s | re-sincroniza la ficha completa (CF + etiquetas) |
| **N3 órdenes** (`SalesOrder`) | venta nueva o modificada | 60 s | encola el CONTACTO de la orden: compras, fechas, monto, recompra |
| **N2A histórico** | cartera que aún no está en GHL | continuo | cobertura (nuevo → antiguo) |
| **N2B reconciliación** | huecos de lo ya sincronizado | 15–20 min | completitud |

Cada tarea se ejecuta en el **worker de su subcuenta** (`subaccount_controller`), con cuota, cola y libro propios. Idempotencia por `sede:id:modifiedtime`: reenviar el mismo cambio no reescribe nada.

**Prueba de que está vivo:** si mañana se anula una orden en vTiger, `SalesOrder` cambia → N3-órdenes encola el contacto → el dual sync publica el nuevo total (modo espejo) → el order history recalcula `Total Compras`, `Fuente Última Orden` y `Precio venta`. Sin intervención manual.

---

## 5. Cómo verificar y converger

```bash
# 1. Medir la cobertura real por sede
node tools/local_sync.mjs cobertura --sede=PALACIOS --muestra=10

# 2. Ver qué haría el sync con un comprador concreto
node tools/local_sync.mjs sincronizar --sede=PALACIOS --limite=5

# 3. Escribir (sólo cuando no haya otro proceso escribiendo la misma subcuenta)
node tools/local_sync.mjs sincronizar --sede=PALACIOS --limite=5 --ejecutar

# 4. Volver a medir: el objetivo es que "vacío" y "difiere" bajen a ~0
```

**Criterio de aceptación**

| Métrica | Objetivo |
| :--- | :--- |
| Coincidencia por campo (campos que vTiger tiene) | ≥ 95% |
| Fecha Creación (DATE) poblada | ≥ 99% |
| Estado de Compra poblado | 100% |
| Fuente Última Orden en compradores | 100% |
| Precio Venta = última orden | ≥ 95% |

---

## 6. Archivos tocados

| Archivo | Cambio |
| :--- | :--- |
| `src/services/dual_sync_service.js` | modo espejo + centinela de contadores + `fechaCreacionFecha`, `fuenteUltimaOrden`, `estadoCompra` |
| `src/domain/segmentacion.js` | reglas Prospecto / Nuevo / Recompra |
| `src/services/vtiger_order_history_service.js` | publica `fuenteUltimaOrden` y `estadoCompra` con el nº REAL de órdenes |
| `src/services/nivel3_reactive_sync.js` | carril de órdenes (`SalesOrder`) |
| `tools/local_sync.mjs` | comando `cobertura` (comparación campo por campo) |
| `.env.example` | `GHL_MODO_ESPEJO`, límites N3 |

**Pruebas:** 23 suites + 26 aserciones de segmentación + 47 de carriles/N3 + 225 de dual upsert (incluye el modo espejo y su reversión).
