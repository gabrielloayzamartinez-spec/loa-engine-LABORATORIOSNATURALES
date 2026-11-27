# PLAN — SINCRONIZAR CONTACTOS **Y** COMPRADORES HISTÓRICOS

**Fecha:** 27-nov-2026 · **Herramienta:** `tools/historico.mjs` · **Regla:** son dos universos distintos y se sincronizan por separado.

---

## 1. Los dos universos (medidos en vTiger)

| Sede | Total | **Compradores** (`spl_num_compras > 0`) | **Contactos / leads** (`= 0`) |
| :--- | ---: | ---: | ---: |
| Palacios | 337.068 | 36.925 | **300.143** |
| Benavides | 67.606 | 6.008 | 61.598 |
| Roosevelt | 11.448 | 2.151 | 9.297 |
| Piura | 6.938 | 669 | 6.269 |
| **Total** | **423.060** | **45.753** | **377.307** |

- **Comprador** = persona que ya compró. Es el que alimenta recompra y campañas de cliente.
- **Contacto** = lead con teléfono y **sin compra**. Es el que alimenta prospección, reactivación y SMS a no compradores.
- El **teléfono es la llave**: un contacto sin teléfono no es sincronizable (el motor empareja por los últimos 10 dígitos).
- En la muestra de 100 leads por sede, **100% tenía teléfono**; aun así el detector descarta los que no lo tengan.

---

## 2. Qué falta de cada universo (medido por muestreo)

### 2.1 Compradores — Palacios

| Año | Compradores | En GHL | Falta |
| :--- | ---: | ---: | ---: |
| 2026 | 5.044 | 100% | 0 |
| 2025 | 6.921 | ~94% | ~400 |
| 2024 | 5.499 | 83% | ~935 |
| **2023** | 6.741 | **63%** | **~2.500** |
| **2022** | 7.376 | 58% | **~3.100** |
| 2021 | 3.108 | 67% | ~1.026 |
| 2020 | 2.167 | 58% | ~910 |
| 2019 | 69 | 100% | 0 |
| **Total** | | | **~10.100** |

Medición en vivo de hoy: `2023` → 59 faltantes en 160 revisados (**37%**); `2025` → 6 en 100 (**6%**).

### 2.2 Contactos (leads) — Palacios

| Año | Leads | Muestra | Faltan | Estimado faltante |
| :--- | ---: | :--- | ---: | ---: |
| 2026 | 48.061 | 60 revisados → 43 en GHL | **28%** | ~13.400 (incluye rezago de los últimos días) |
| 2025 | 48.834 | 80 revisados → 74 en GHL | **8%** | ~3.900 |
| 2024 | 44.589 | — | ~35% (interpolado) | ~15.600 |
| **2023** | 77.278 | 78 revisados → 38 en GHL | **51%** | **~39.400** |
| 2022 | 47.451 | — | ~50% | ~23.700 |
| 2021 | 19.717 | — | ~50% | ~9.900 |
| 2020 | 13.615 | — | ~50% | ~6.800 |
| 2019 | 598 | — | ~50% | ~300 |
| **Total** | 300.143 | | | **~113.000** |

> **El hueco de contactos es 10 veces el de compradores.** Y no es uniforme: 2023 es el peor año (51%).

### 2.3 Otras sedes

Benavides, Roosevelt y Piura tienen el histórico de compradores ~100%. Sus leads no se han medido aún; se hará con el mismo detector antes de tocarlos.

---

## 3. Costo real (para no prometer lo que no cabe)

Cada contacto sincronizado cuesta **~3–4 llamadas** (búsqueda por teléfono + upsert + historial si aplica + tags).

| Bloque | Contactos | Llamadas estimadas | Días al fondo de 120.000/día |
| :--- | ---: | ---: | ---: |
| Compradores Palacios | ~10.100 | ~40.000 | **0,3 días** |
| Compradores resto de sedes | ~1.100 | ~4.400 | — |
| **Leads Palacios** | **~113.000** | **~400.000** | **3,3 días** |
| Leads resto de sedes (si aplica) | ~30.000 | ~105.000 | ~0,9 días |
| **Total** | **~154.000** | **~550.000** | **~4,6 días de fondo** |

Con la cuota compartida con el Nivel 1 y el backfill automático, en la práctica son **2–3 semanas de trabajo nocturno**, no una noche.

---

## 4. Prioridad propuesta (por valor de marketing)

| Fase | Qué | Por qué | Tiempo |
| :--- | :--- | :--- | :--- |
| **0** | Compradores Palacios 2022–2023 (~5.600) | recompra; los dos huecos más grandes | 1 noche |
| **1** | Resto de compradores (~4.500 + 1.100 Benavides) | cierra el universo de compradores | 1 noche |
| **2** | Leads 2026 y 2025 (~17.300) | prospección/ reactivación reciente | 2 noches |
| **3** | Leads 2024 y 2023 (~55.000) | el hueco grande; sólo si hay campaña prevista | 1 semana |
| **4** | Leads 2022 y anteriores (~40.700) | menor valor comercial | opcional |

Nadie obliga a sincronizar 113.000 leads viejos si no hay campaña para ellos. Los compradores sí: son 45.753 y son los que generan ingreso.

---

## 5. La herramienta (ya soporta los dos universos)

```bash
# COMPRADORES de un año
node tools/historico.mjs detectar    --sede=PALACIOS --ano=2023 --tipo=compradores --limite=100
node tools/historico.mjs sincronizar --sede=PALACIOS --ano=2023 --tipo=compradores --limite=50 --ejecutar

# CONTACTOS (leads sin compra) de un año
node tools/historico.mjs detectar    --sede=PALACIOS --ano=2025 --tipo=contactos --limite=100
node tools/historico.mjs sincronizar --sede=PALACIOS --ano=2025 --tipo=contactos --limite=50 --ejecutar

# Progreso (separa compradores y contactos por archivo)
node tools/historico.mjs estado
```

- Estado en `scratch/historico/<SEDE>_<TIPO>_<AÑO>.json` (compradores y contactos no se mezclan).
- **Dry-run por defecto**; escribe solo con `--ejecutar`.
- **Reanudable** por offset; se detiene si la subcuenta se queda sin cuota.
- **Relee la ficha** antes de escribir (modo espejo: se publica el estado actual de vTiger).

---

## 6. Diferencia al sincronizar cada universo

| Aspecto | Comprador | Contacto (lead) |
| :--- | :--- | :--- |
| Etiquetas | `compro`, `convertido`, `cliente-vtiger` | `prospecto-vtiger` |
| Estado de Compra | `Comprador` | `No Comprador` |
| Fuente Última Orden | `Mi Re-Orden` / `Primera Compra` | vacío |
| Historial de órdenes | sí (se publica) | **no** (no tiene órdenes: se omite para ahorrar cuota) |
| Bloque comercial | completo | sólo identidad + origen |

Ambos reciben **sede, tratamiento, proveedor, canal, campaña, sexo, etapa, estado, contact no, fecha de creación (DATE)** y las etiquetas de vista.

---

## 7. Orden de arranque recomendado

1. **Fase 0**: corre la detección completa de compradores 2022 y 2023 (solo lectura) para tener la lista exacta.
2. Sincroniza esos compradores en 2 tandas.
3. Recién entonces, ataca los leads por año (2026 → 2025 → 2024 → 2023).

**Criterio de cierre por bloque:** `faltan ≤ 2%` del total del año y cobertura de campos ≥ 95% (`tools/local_sync.mjs cobertura`).
