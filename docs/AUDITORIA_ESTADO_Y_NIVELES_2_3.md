# AUDITORÍA DE ESTADO — ¿DÓNDE NOS QUEDAMOS? + NIVEL 2 PARTIDO EN 2 + NIVEL 3 REACTIVO

**Fecha:** 27-nov-2026 · **Medición:** solo lectura sobre producción y vTiger · **Alcance:** 4 subcuentas

---

## 0. Respuesta corta

| Sede | Estado del histórico | Compradores en vTiger | Presencia estimada en GHL | Falta (estimado) |
| :--- | :--- | ---: | ---: | ---: |
| **PALACIOS** | En curso (cursor en 2025-10-02) | 36.925 | **~71%** | **~10.500** (2020–2025) |
| **BENAVIDES** | En curso (cursor en 2026-04-15) | 6.008 | ~100% histórico | ~1.100 recientes |
| **ROOSEVELT** | **Terminado** | 2.151 | 100% | 0 |
| **PIURA** | **Terminado** | 669 | 100% | 0 |

**Lo que falta no es un campo: son fichas.** En Palacios falta sobre todo la cartera **2020–2025** (los años viejos), y en las cuatro sedes los **compradores de los últimos días** existen pero llegan **incompletos** (sin fechas de compra ni precio).

---

## 1. ¿Dónde se quedó cada job? (estado real de producción)

`GET /api/sync/estado` + `/api/vtiger/buyers-backfill/status` al 27/11 14:57 UTC:

| Job | Palacios | Benavides | Roosevelt | Piura |
| :--- | ---: | ---: | ---: | ---: |
| Backfill de compradores (cursor) | **6.480 / 36.652 (17,7%)** | 3.240 / 5.301 (61,1%) | 2.153 / 1.908 (**completo**) | 667 / 603 (**completo**) |
| Último id procesado | 12x2472438 (fecha 2025-10-02) | 12x2664649 (2026-04-15) | 12x215060 | 12x2646902 |
| Re-llenado comercial | 840 revisados (id 12x2831596) | — | — | — |
| Curador bidireccional | 2.770 escaneados | 2.750 escaneados | — | — |
| Ritmo medido | **249 contactos/hora** | | | |
| ETA del backfill | **128 horas (5,3 días)** | | | |

**Conteos de vTiger recalculados hoy** (los del panel estaban congelados desde el 05/10):
Palacios 36.925 · Benavides 6.008 · Roosevelt 2.151 · Piura 669 **compradores**.
Totales de contactos: Palacios 337.059 · Benavides 67.570 · Roosevelt 11.408 · Piura 6.938.

### Dato clave: el % del cursor NO es el hueco real

El backfill avanzó 6.480 fichas en Palacios, pero muchas **ya estaban** en GHL por la migración de noviembre. La presencia **medida** es ~71%, no 17,7%. El cursor mide *trabajo recorrido*, no *datos faltantes*. Por eso la auditoría se hizo midiendo presencia real, no el contador.

---

## 2. ¿Qué fichas faltan? (de lo más nuevo a lo más antiguo)

Muestra representativa del **medio de cada año** (12 compradores por año y sede), emparejados por teléfono con la prioridad real del motor (`homephone` → `mobile` → `phone` → `otherphone`):

### PALACIOS — 36.925 compradores

| Año | Compradores | En GHL | Completo (14 campos) | Falta (estimado) |
| :--- | ---: | ---: | ---: | ---: |
| 2026 | 5.044 | 100% | 100% | 0 |
| 2025 | 6.921 | **75%** | 100% | **~1.730** |
| 2024 | 5.499 | **83%** | 100% | **~935** |
| 2023 | 6.741 | **58%** | 100% | **~2.831** |
| 2022 | 7.376 | **58%** | 100% | **~3.098** |
| 2021 | 3.108 | **67%** | 100% | **~1.026** |
| 2020 | 2.167 | **58%** | 100% | **~910** |
| 2019 | 69 | 100% | 83% | 0 |

> **El hueco de Palacios está en 2020–2025 (~10.530 fichas).** Lo que sí existe está completo: la migración histórica llenó bien los 14 campos.

### BENAVIDES — 6.008 compradores

| Año | Compradores | En GHL | Completo | Falta |
| :--- | ---: | ---: | ---: | ---: |
| 2026 | 4.364 | 100% | 100% | 0 |
| 2025 | 1.642 | 100% | 100% | 0 |
| 2024–2023 | 2 | 100% | 100% | 0 |

### ROOSEVELT — 2.151 y PIURA — 669

| Año | Roosevelt | Piura |
| :--- | ---: | ---: |
| 2026 | 1.508 (**100%**) | 669 (**100%**) |
| 2025 | 642 (100%) | 0 |
| 2021 | 1 (100%) | 0 |

> Roosevelt y Piura están **completos**: presencia 100% y 14 campos al 100%.

### Lectura correcta de esta tabla

- **Presencia histórica:** Palacios 58–83% en 2020–2025; las demás sedes ~100%.
- **Completitud de lo que existe:** 100% en casi todos los casos (la migración hizo bien su trabajo).
- **La excepción es lo recién llegado:** en la muestra de los **15 compradores más nuevos** (auditoría previa) Palacios tenía **42,9%** sin fechas de compra y Benavides **45,5%**; además **4 de 15** compradores de Benavides y **3 de 15** de Piura **no existían** en GHL todavía. Eso no es histórico: es el flujo diario que entra más rápido de lo que el Nivel 2 lo alcanza.

---

## 3. ¿Todo lo que está en GHL está completo y sincronizado?

| Dimensión | Resultado |
| :--- | :--- |
| Contactos en GHL | **480.592** (Palacios 220.831 · Benavides 159.953 · Roosevelt 59.509 · Piura 40.304) |
| Contactos en vTiger | 422.975 → GHL tiene **más** contactos que vTiger (leads de Meta que nunca existieron en el CRM) |
| Duplicados por teléfono (muestra de 120 por sede, normalizado a 10 dígitos) | **0%** — no hay duplicación masiva |
| Campos del contrato presentes | **42/42 en las 4 subcuentas** |
| Nivel 1 (leads recientes): sede/proveedor/canal | 95–100% (Palacios 95,7 · Benavides 99,3 · Roosevelt 80,3/65 · Piura 100) |
| Etiquetas con conflicto (dos canales) | Palacios 8 · Roosevelt 11 · **Piura 50** |
| Ruido `vtiger` + `vtiger-sincronizado` | Roosevelt **92,9%** de compradores · Piura 33% |
| Compradores históricos | Completos **donde existen** |
| Compradores recientes (últimos días) | **Incompletos**: fechas, precio y total histórico vacíos en Palacios/Benavides |

**Conclusión:** lo que está en GHL **no está roto**, pero **no está completo en el flujo reciente** y arrastra etiquetas en conflicto. No hay que "rehacer" la base: hay que **cerrar la brecha histórica de Palacios** y **completar lo nuevo**.

---

## 4. Por qué se quedó ahí (causas medidas)

1. **Siete jobs de Nivel 2 con un solo turno.** El re-llenado y el curador (revisar lo hecho) le robaban el turno al backfill (traer lo que falta).
2. **El cursor no es la verdad.** El backfill avanzaba sobre fichas que ya estaban en GHL; el panel mostraba 17,7% cuando la presencia real era ~71%.
3. **Estado en disco efímero.** `PERSISTENCE_DRIVER=file` y Render borra el disco en cada redeploy: `/api/state/status` avisa *"el progreso se pierde en cada redeploy"*. Los cursores de los jobs one-shot quedaban en cero.
4. **Dos escritores de etiquetas.** El reverse sync creaba `vtiger*` y `canal-fb-msgr`; el router los borraba. Guerra de etiquetas.
5. **Un solo carril para todo.** Sin separación entre cobertura y completitud, el sistema se curaba en círculos mientras la brecha crecía.

---

## 5. Arquitectura nueva (implementada)

```
NIVEL 1  · Meta en vivo            prioridad absoluta · nunca se frena
NIVEL 2A · HISTÓRICO               cobertura    · trae de vTiger lo que falta (nuevo → antiguo)
NIVEL 2B · RECONCILIACIÓN          completitud  · repara y re-etiqueta lo ya sincronizado
NIVEL 3  · REACTIVO vTiger         frescura     · un cambio = una ficha completa en GHL
```

### 5.1 Nivel 2 partido en dos carriles

Archivo: `src/services/ciclo_operativo.js` (+ descriptor en `src/services/nivel2_carriles.js`).

| Carril | Tareas | Objetivo | Prioridad |
| :--- | :--- | :--- | :--- |
| **N2A** | backfill de compradores, leads backfill, sales bridge | cobertura | **manda**: si ambos quieren arrancar, gana A |
| **N2B** | re-llenado comercial, curador de estándar, order history | completitud | cede ante A; lote corto (10 min máx. si A espera) |

Reglas: un carril a la vez; nunca dos jobs escribiendo a la vez; watchdog por carril (A 120 min, B 45 min) para que un cuelgue no congele al otro.
Panel: `GET /api/nivel2/carriles`.

### 5.2 Nivel 3 — sincronización reactiva

Archivo: `src/services/nivel3_reactive_sync.js`.

- **Qué hace:** cada 60 s busca en vTiger los contactos con `modifiedtime` posterior al cursor y los encola; el worker relee la **ficha completa** y la sincroniza con el **mismo contrato** de campos y etiquetas del dual sync (incluye historial de órdenes).
- **Idempotencia:** clave `SEDE:id:modifiedtime` con TTL 15 min. Reenviar el mismo cambio no reescribe nada.
- **Anti-doble-trabajo:** respeta el cooldown del motor reactivo.
- **Sede-Lock:** la lectura de vTiger va filtrada por `cf_3451`; una sede inválida se rechaza.
- **Cuota:** `hayCuotaRealDeFondo(sede)` por contacto + **tope diario** `NIVEL3_MAX_DIA=4000` + cupo por ciclo.
- **Anti-atraso:** si el cambio pendiente más viejo supera `NIVEL3_MAX_ATRASO_MIN=45`, el cursor **salta al presente** (auditado como `NIVEL3_CURSOR_JUMP`). No persigue un backlog que le corresponde a N2A.
- **Volumen medido en vTiger:** **39.359 cambios/día** en las 4 sedes (**9.390 de compradores**). Por eso N3 está topado: sincronizar todo serían ~50.000 llamadas GHL/día y dejaría sin cuota al histórico.

| Endpoint | Uso |
| :--- | :--- |
| `GET /api/nivel3/estado` | cursores, consumo del día, límites, contadores |
| `POST /api/nivel3/tail?limite=10` | fuerza una pasada (prueba) |
| `POST /api/nivel3/contacto?id=12x...&sede=PALACIOS` | sincroniza UNA ficha ahora |
| `POST /api/nivel3/reset` | re-ancla los cursores |

**El demonio inverso antiguo queda apagado** (`VTIGER_REVERSE_SYNC_ENABLED=false` por defecto) porque N3 lo reemplaza con el contrato correcto. Si algo saliera mal: `VTIGER_REVERSE_SYNC_ENABLED=true` lo restaura sin redeploy de código.

### 5.3 Control por subcuenta (4 workers independientes)

Cada sede tiene su **worker, cola, cuota, ración de vTiger y libro de contactos**
(`src/services/subaccount_controller.js`). Si una subcuenta se queda sin cupo, se
pausa **solo ella**. La efectividad se mide **por contacto**:
`(ok + sin_cambios) / (ok + sin_cambios + fallidos)`, con objetivo 100%.

Panel: `GET /api/subcuentas/control` · detalle: `GET /api/subcuentas/control/:sede`.
Documento completo: [`CONTROL_POR_SUBCUENTA.md`](./CONTROL_POR_SUBCUENTA.md).

### 5.4 Presupuesto de cuota (por día)
| Consumidor | Techo | % del día |
| :--- | ---: | ---: |
| Nivel 1 (en vivo) | sin tope, reserva intocable | ~40% reservado |
| N2A histórico | resto del fondo | ~40% |
| N2B reconciliación | lote corto, cede ante A | ~15% |
| N3 reactivo | **4.000 contactos/día** (~32.000 llamadas) | ~16% |
| GHL total disponible | 200.000 llamadas/día | 100% |

---

## 6. Cómo continuar (orden recomendado)

1. **Desplegar** (los cambios están en el repo, no en Render) y verificar `/api/health` 200 + `GET /api/nivel3/estado`.
2. **Cerrar la brecha de Palacios (N2A).** El backfill ya no compite con el refill. Para acelerar sin riesgo, usar la ventana nocturna (23:00–06:00) donde el perfil sube la concurrencia sola. Objetivo: ~10.500 fichas de 2020–2025.
3. **Completar lo reciente (N2B + N3).** Con N3 activo, cada compra nueva entra completa en minutos; el re-llenado deja de perseguir el flujo diario.
4. **Limpiar etiquetas** con `POST /api/nivel2/retag` (repetir hasta `terminado: true`; ahora sí avanza: se corrigió el cursor).
5. **Verificar** con `GET /api/auditoria/contrato-sync?todas=true&paginas=3` y `GET /api/sync/estado`.
6. **Persistencia (recomendado):** `PERSISTENCE_DRIVER=postgres` + `DATABASE_URL` para que cursores y contadores sobrevivan a los redeploys. Mientras siga en `file`, cada deploy reinicia el progreso de los jobs one-shot.

### Semáforo para declarar "terminado"

| Criterio | Umbral |
| :--- | :--- |
| Presencia de compradores por año (Palacios 2020–2025) | ≥ 98% |
| Completitud de los 14 campos en compradores | ≥ 95% |
| Conflictos de etiqueta (dos canales / dos proveedores) | 0 |
| Ruido `vtiger*` | 0 |
| N3 atraso | < 45 min |

---

## 7. Anexo — evidencia y reproducibilidad

| Fuente | Qué contiene |
| :--- | :--- |
| `tools/audit_frontera_sync.mjs` | auditoría por año (presencia + completitud + faltantes estimados) |
| `scratch/audit_out/frontera_sync_2026-11-27.json` | salida cruda de esta medición |
| `scratch/audit_out/n2_compradores_2026-11-27.json` | compradores más nuevos, campo por campo |
| `scratch/audit_out/n1_n2_contrato_2026-11-27.json` | etiquetas y CF de los 300 contactos recientes por sede |
| `GET /api/sync/estado` · `/api/vtiger/buyers-backfill/status` | cursores y ritmo del backfill |
| `GET /api/nivel2/carriles` · `/api/nivel3/estado` | los dos carriles y el reactivo |
| `GET /api/auditoria/contrato-sync` | contrato de CF + etiquetas por subcuenta |

**Pruebas:** 21 suites en verde · 40 aserciones nuevas de carriles/N3 · 34/34 reglas protocolares · boot validado sin red.
