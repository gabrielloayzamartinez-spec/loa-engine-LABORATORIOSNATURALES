# CONTROL POR SUBCUENTA — 4 PROCESOS INDEPENDIENTES Y EFECTIVIDAD POR CONTACTO

**Fecha:** 27-nov-2026 · **Módulo:** `src/services/subaccount_controller.js` · **Panel:** `GET /api/subcuentas/control`

---

## 1. Qué se construyó

Cuatro **workers independientes**, uno por subcuenta. Cada uno tiene:

| Recurso | Propio de cada sede | Efecto |
| :--- | :--- | :--- |
| Cola de contactos | ✅ | una sede con 3.000 pendientes no retrasa a otra con 10 |
| Cuota GHL | ✅ `hayCuotaRealDeFondo(sede)` | si una subcuenta se queda sin cupo, **solo ella** se pausa |
| Ración de vTiger | ✅ `VTIGER_LECTURAS_POR_MIN_SEDE` | ninguna sede puede acaparar el CRM madre |
| Libro de contactos | ✅ | efectividad y fallidos por sede, sin mezclar |
| Pausa / reanudar | ✅ | se opera una sede sin tocar las otras tres |
| Reintentos y fallidos | ✅ | lista propia, reintento propio |

El **gate global de vTiger (3 consultas concurrentes)** sigue existiendo: es el único recurso compartido, y ahora cada worker compite por él con su propia ración.

> **Aislamiento de proceso:** hoy los 4 workers viven en el mismo proceso Node (un servicio de Render). Si se necesita aislamiento a nivel de sistema operativo, se puede desplegar un servicio por sede con las demás pausadas (`PAUSE_*`); la lógica ya está separada y no depende de las otras.

---

## 2. Cómo se mide la efectividad (por contacto)

Cada contacto que entra a la cola termina en **un** estado terminal:

| Estado | Significado | ¿Cuenta como éxito? |
| :--- | :--- | :--- |
| `ok` | se escribió en GHL | ✅ |
| `sin_cambios` | ya estaba igual (idempotencia) | ✅ |
| `omitido` | no aplica: sin teléfono, no existe en vTiger, no es comprador, cooldown | — (no es fallo del motor) |
| `fallido` | error tras agotar reintentos | ❌ |

```
efectividad % = (ok + sin_cambios) / (ok + sin_cambios + fallidos)
```

- **Es por CONTACTO, no por intento.** Si un contacto falla y luego se recupera, se descuenta el fallo y queda como éxito. Un contacto nunca se cuenta dos veces.
- **Objetivo:** `100%` con `cola = 0` y `fallidosPendientes = 0`.
- Los omitidos se reportan **con su motivo** (`omitidosPorMotivo`) para distinguir "no se puede" de "falló".

---

## 3. Endpoints de control

| Método | Ruta | Qué hace |
| :--- | :--- | :--- |
| GET | `/api/subcuentas/control` | consolidado de las 4 sedes + efectividad total |
| GET | `/api/subcuentas/control/:sede` | cuota, cola, libro, efectividad y fallidos de una sede |
| POST | `/api/subcuentas/control/:sede/contacto?id=12x...` | encola un contacto (prioridad 1) |
| POST | `/api/subcuentas/control/:sede/pausar?minutos=5` | pausa SOLO esa subcuenta |
| POST | `/api/subcuentas/control/:sede/reanudar` | la reanuda |
| POST | `/api/subcuentas/control/reintentar?sedes=PALACIOS,BENAVIDES` | reencola los fallidos |

### Ejemplo de lectura

```json
{
  "total": {
    "exitosos": 12480, "fallidos": 3, "omitidos": 61,
    "debianEscribirse": 12483,
    "enCola": 12, "fallidosPendientes": 3,
    "efectividadPct": 99.98
  },
  "sedes": {
    "PALACIOS": { "cola": 0, "cuota": { "consumidas": 18420, "restante": 101580 },
                  "efectividad": { "efectividadPct": 100 }, "libro": { "contactosOk": 6481 } }
  }
}
```

---

## 4. Cómo llegar al 100% (rutina)

1. `GET /api/subcuentas/control` → mirar `fallidosPendientes` y `enCola`.
2. Por cada sede con fallidos: `GET /api/subcuentas/control/:sede` y revisar `muestraFallidos[].motivo`.
   - `sin cuota` / `HTTP 429` → esperar la franja o subir cuota; reintentar.
   - `sin teléfono` / `no existe` → **no es un fallo del motor**: es un dato de origen; va a `omitidos`.
3. `POST /api/subcuentas/control/reintentar?sedes=...` para reprocesar los recuperables.
4. Repetir hasta que `efectividadPct = 100` y `fallidosPendientes = 0`.

### Semáforo

| Métrica | Verde | Ámbar | Rojo |
| :--- | :--- | :--- | :--- |
| Efectividad por sede | 100% | 99–99,9% | < 99% |
| Fallidos pendientes | 0 | 1–20 | > 20 |
| Cola | 0 | < 500 | > 500 |
| Cuota restante de la sede | > 20% | 5–20% | < 5% |

---

## 5. Variables de entorno

| Variable | Default | Para qué |
| :--- | ---: | :--- |
| `CONTROL_MAX_INTENTOS` | 3 | reintentos por contacto antes de marcarlo fallido |
| `CONTROL_MAX_COLA` | 5000 | tope de cola por sede (protege memoria) |
| `CONTROL_PAUSA_MS` | 150 | pausa entre tareas del worker |
| `CONTROL_VIGILANCIA_MS` | 15000 | cada cuánto el worker revisa su cola |
| `VTIGER_LECTURAS_POR_MIN_SEDE` | 60 | racionamiento de vTiger por sede |
| `NIVEL3_MAX_DIA` | 4000 | techo diario de contactos del carril reactivo |

---

## 6. Qué queda conectado automáticamente

- **Nivel 3 (reactivo)** detecta cambios de vTiger y los deposita en la cola de **su** subcuenta (prioridad 1).
- Los **4 workers** arrancan en el boot, después de hidratar el libro guardado.
- Las pausas por cuota son **automáticas y por sede**: si Palacios agota su cupo, Benavides/Roosevelt/Piura siguen trabajando.

**Pruebas:** `src/tests/test_control_subcuentas.js` — 41 aserciones (aislamiento, clasificación, reintentos, pausa independiente, efectividad).
