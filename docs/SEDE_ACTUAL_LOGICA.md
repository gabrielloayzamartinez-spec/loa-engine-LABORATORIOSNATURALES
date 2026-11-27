# LÓGICA DE SEDE ACTUAL (cf_3590) — CORRECCIÓN ESTRUCTURAL

**Fecha:** 27-nov-2026 · **Cambio:** la sincronización se rige por la **Oficina Actual** del contacto, no por la oficina donde se registró.

---

## 1. El problema que resolvía mal

vTiger tiene dos campos de sede:

| Campo | Qué significa | Uso correcto |
| :--- | :--- | :--- |
| `cf_3451` (OFICINA) | donde **nació** la ficha | auditoría / aislamiento histórico |
| `cf_3590` (ACTUAL_OFICINA) | donde el contacto está **hoy** | **destino en GHL** |

El motor ya resolvía el destino con `cf_3590` (desde el 18/11), **pero las consultas seguían filtrando por `cf_3451`**. Resultado: cada carril recorría la cartera equivocada.

### Medición (hoy)

| Sede | Contactos por **registro** | Contactos por **actual** | Compradores registro | Compradores actual |
| :--- | ---: | ---: | ---: | ---: |
| Palacios | 337.068 | **198.036** | 36.925 | **21.830** |
| Benavides | 67.610 | **136.942** | 6.008 | **12.907** |
| Roosevelt | 11.448 | **47.588** | 2.151 | **6.115** |
| Piura | 6.938 | **40.045** | 669 | **4.894** |

- **139.562 fichas de Palacios** fueron reasignadas a otra oficina.
- Benavides tiene **2,1×** más compradores de los que reportaba; Piura **7,3×**.
- Oficina Actual está poblada al **100%**, incluso en 2019 (muestra de 100 por año: 0 vacíos).

**Consecuencia:** el carril de Palacios procesaba 139.562 fichas que ya no eran suyas (y las escribía en la subcuenta correcta, gastando el doble), mientras Benavides/Roosevelt/Piura **nunca veían** su cartera real.

---

## 2. Qué se cambió

| Archivo | Cambio |
| :--- | :--- |
| `src/services/vtigerClient.js` | nueva `sedeActualClause(sede)` → `AND cf_3590 = 'SEDE'`. El **Sede-Lock** ahora acepta `cf_3451` **o** `cf_3590` como cláusula de aislamiento válida (ambas acotan a una sede). |
| `vtiger_buyers_backfill.js` | consulta y conteos por `cf_3590`; `COMPRADORES_POR_SEDE` recalibrado (21.830 / 12.907 / 6.115 / 4.894). |
| `vtiger_leads_backfill.js` | consulta por `cf_3590`. |
| `vtiger_order_history_service.js` | backfill de órdenes por `cf_3590`. |
| `vtiger_sales_bridge.js` | ventas recientes por `cf_3590`. |
| `tools/historico.mjs` | recorre por `cf_3590` por defecto (`--por=original` para comparar). |

El **destino** ya era correcto (`resolveSedeFromVtiger` prefiere `cf_3590`); lo que se corrigió es **qué cartera recorre cada carril**.

---

## 3. Efecto en la medición del faltante (importante)

Los números anteriores de “faltan ~10.100 compradores” y “~113.000 leads” se midieron **por sede de registro**, así que incluían fichas que ya estaban sincronizadas en **otra** subcuenta. Con la lógica correcta:

| Muestra (por sede ACTUAL) | Resultado |
| :--- | :--- |
| Palacios 2022 · compradores (80) | **0 faltantes** |
| Palacios 2023 · compradores (100) | **0 faltantes** |
| Benavides 2023 · compradores (60) | **0 faltantes** |
| Palacios 2023 · leads nuevos del año (80) | **0 faltantes** |
| **Palacios 2023 · leads a mitad de año (60)** | **60 faltantes (100% de ese lote)** |

**Lectura:** la punta de cada año está sincronizada (los procesos siempre avanzan desde lo más nuevo), y **el hueco real está a mitad de año**. El “backlog” no desapareció: cambió de tamaño y de ubicación.

---

## 4. Cómo queda el recorrido

```
vTiger: cf_3590 = 'PALACIOS'          →  subcuenta GHL de Palacios
        cf_3590 = 'BENAVIDES'         →  subcuenta GHL de Benavides
        ...
cf_3451 solo se usa para auditoría histórica ("de dónde vino")
```

- El backfill de compradores, el de leads, el de órdenes y el sales bridge recorren **su** cartera actual.
- El Nivel 1 sigue igual: solo hoy.
- El Nivel 3 sigue igual: publica el cambio de cualquier fecha, en la subcuenta de la oficina actual.

---

## 5. Siguiente paso

Antes de sincronizar en masa hay que **re-medir el faltante con la lógica correcta**:

```bash
# Compradores de un año, por sede ACTUAL (solo lectura)
node tools/historico.mjs detectar --sede=PALACIOS --ano=2023 --tipo=compradores --limite=100

# Contactos (leads) del año
node tools/historico.mjs detectar --sede=PALACIOS --ano=2023 --tipo=contactos --limite=100
```

El detector es secuencial (offset), así que al recorrer el año completo mide también la zona de mitad de año donde está el hueco. Con ese listado se sincroniza por tandas.

**Orden sugerido:** 2023 → 2022 → 2024 → 2021 y anteriores, empezando por los compradores (generan ingreso) y luego los leads.

---

## 6. Verificación

```bash
node src/tests/test_audit_engine.js     # Sede-Lock sigue exigiendo aislamiento
node src/tests/test_sede_isolation.js   # aislamiento entre subcuentas
node src/tests/test_dual_upsert.js      # destino por cf_3590
node src/scripts/verify_boot.js
```

**Pruebas:** 24 suites en verde tras el cambio.
