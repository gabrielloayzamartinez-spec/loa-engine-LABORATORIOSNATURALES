# ✅ CHECKPOINT FINAL — Sincronización vTiger→GHL completada

**Fecha:** 19-nov-2026 · **Estado:** ✅ Objetivo alcanzado (con notas menores)

---

## 1. CÓDIGO (desplegado en Render)

| Commit | Contenido | Estado |
| :--- | :--- | :--- |
| `a64f284` | Micromotor: enrutar por `cf_3590` (Oficina Actual) + campos completos + reconciliación Estado Comercial/Total Compras | ✅ LIVE |
| `d126b1b` | Motor reactivo: preferir `cf_3590` en sede + doc del workflow webhook | ✅ LIVE |

**Producción:** `https://loa-engine-laboratoriosnaturales.onrender.com` (HTTP 200 OK).

---

## 2. DATOS SINCRONIZADOS (4 subcuentas)

| Proceso | Resultado |
| :--- | :--- |
| Reconciliación compradores Palacios+Benavides | ✅ 34 627 (151 corregidos, 19 transitorios) |
| Reconciliación compradores Roosevelt+Piura | ✅ 10 891 (116 transitorios) |
| Fill orden Roosevelt | ✅ 5 960 (130 transitorios) |
| Fill orden Piura | ✅ 4 886 (1 transitorio) |
| Enriquecimiento leads | ✅ 17 964 (717 solo-GHL, 2 transitorios) |

**Contactos en GHL:** Benavides 44 556 · Palacios 49 656 · Roosevelt 17 494 · Piura 5 462 = **117 168**.

---

## 3. OBJETIVO ALCANZADO (resumen)

| Componente | Estado |
| :--- | :--- |
| Contactos + Órdenes de Venta → GHL (campos completos) | ✅ |
| Enrutamiento por Oficina Actual (`cf_3590`) | ✅ |
| Reconciliación contra órdenes reales (Total Compras, Estado Comercial) | ✅ |
| Enriquecimiento de leads (Fecha Creación, Sexo, Etapa, Contacto, ID, Asesor) | ✅ |
| Roosevelt + Piura | ✅ |
| Motor reactivo Nivel 2 | ✅ desplegado |

---

## 4. NOTAS MENORES (no bloqueantes)

1. **~265 fallos transitorios (429/500)** en los procesos → el motor en Render los recupera en sus ciclos (backfills cada 15 min).
2. **717 leads "solo-GHL"** (sin registro en vTiger) → no tienen `createdtime` de vTiger; su "Fecha Creación" puede salir del campo nativo `dateAdded` de GHL si se desea.
3. **Workflow/Webhook en vTiger** (push reactivo) queda por configurar en la UI de vTiger — documentado en `docs/MOTOR_REACTIVO_VTIGER_GHL.md`.

---

## 5. CÓMO MANTENER / RETOMAR

- **Sincronización continua:** el motor en Render corre solo (backfills cada 15 min + dual sync + order history).
- **Re-run de transitorios (opcional):** `python scratch\reconcile_full.py --execute` (idempotente).
- **Scripts de trabajo:** en `scratch/` (reconcile_full.py, reconcile_rp.py, fill_rp_extra.py, enrich_leads_v2.py, etc.).

---

*Checkpoint final generado al completar la sincronización vTiger→GHL de las 4 subcuentas.*
