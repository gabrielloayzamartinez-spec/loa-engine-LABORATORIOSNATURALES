# 📌 CHECKPOINT — RETOMAR MAÑANA (18-nov-2026)

**Hora de pausa:** 17:32 Lima · **Objetivo final:** Smart Lists óptimas con datos correctos vTiger→GHL.

---

## ✅ YA TERMINADO (no repetir)

### 1. Código del "micromotor reactivo" — COMMITEADO + DESPLEGADO
- **Commit:** `a64f284` — `feat(sync): micromotor reactivo vTiger→GHL ...`
- **Push:** a `main` en GitHub (`gabrielloayzamartinez-spec/loa-engine-LABORATORIOSNATURALES`).
- **Render:** servicio `loa-engine-LABORATORIOSNATURALES` → **LIVE** (deploy `dep-dbv26t8u01pc73cjes2g`).
- **URL producción:** `https://loa-engine-laboratoriosnaturales.onrender.com/api/health` → HTTP 200 OK.

### Archivos de código cambiados (ya en el repo)
- `src/services/dual_sync_service.js` — enrutamiento por `cf_3590` (Oficina Actual) + campos completos.
- `src/services/vtigerClient.js` — campo `SEDE_ACTUAL` (`cf_3590`).
- `src/services/vtiger_order_history_service.js` — reconcilia Total Compras + Estado Comercial contra órdenes reales.
- `src/tests/test_dual_upsert.js` — 3 aserciones nuevas.
- `docs/INFORME_AUDITORIA_BENAVIDES_2026-11-17.md` + `docs/PLAN_DESPLIEGUE_OFICINA_ACTUAL.md`.

### 2. Correcciones de datos YA aplicadas en GHL (no repetir)
- Re-ubicación de convertidos (Palacios↔Benavides): **7 915 movidos**.
- Refill completo de campos de movidos: **7 923**.
- Fill de campos faltantes (Total Histórico, Asesor, Fecha Creación, Tiene Teléfono, UTM, etc.): **34 642**.
- Reconciliación Estado Comercial vs órdenes reales: **154 corregidos**.
- Reconciliación Total Compras vs órdenes reales: **22 corregidos**.

---

## ⏳ PENDIENTE (retomar mañana)

### Tarea principal: terminar la reconciliación completa del backlog
- **Script:** `scratch/reconcile_full.py` (usa `count(*)` en SalesOrder — CORREGIDO).
- **Estado al pausar:** `2 000 / 34 667` procesados (14-18 corregidos por cada 1000).
- **Es idempotente:** re-ejecutarlo es seguro (reescribe los valores correctos).

**Comando para retomar:**
```powershell
python scratch\reconcile_full.py --execute
```
> Tiempo estimado: ~90 min. Corre LOCAL (tu PC encendida).

### Pendiente opcional: extender a Roosevelt y Piura
- El script solo cubre Palacios + Benavides (Roosevelt/Piura tenían Location ID vacío en el `.env` local).
- **Location IDs de producción (ya obtenidos):**
  - Roosevelt: `SETlaGKhBpbqfBSzzpIB`
  - Piura: `9J4pKs5f7OcaokdhyurW`
- Para extender: añadir esas 2 sedes al diccionario `GHL` de `scratch/reconcile_full.py`, resolviendo sus custom field IDs dinámicamente (sus `SEDE_CUSTOM_FIELDS` son `null` en `routing_tables.js`).
- Alternativa: dejar que el motor en Render las llene (lento: ~80/hora).

---

## 🔑 ACCESOS / CREDENCIALES (dónde están)

| Recurso | Dónde |
| :--- | :--- |
| vTiger (URL, usuario, access key) | `.env` (gitignored) |
| GHL Palacios + Benavides (PIT + Location) | `.env` |
| GHL Roosevelt + Piura (PIT sí, Location vacío local) | `.env` + Location IDs arriba |
| **Render API key** | `.env` → `RENDER_API_KEY=rnd_VksqyrrSNJSEcQQ2Epxld59U69lo` |
| GitHub | credenciales en Windows Credential Manager (`git push` funciona) |

---

## 📁 ARCHIVOS CLAVE

| Archivo | Para qué |
| :--- | :--- |
| `scratch/reconcile_full.py` | Reconciliación del backlog (retomar) |
| `scratch/fill_sede.py` | Fill de campos faltantes (ya ejecutado) |
| `scratch/fix_estado_comercial.py` | Reconciliación Estado Comercial (ya ejecutado) |
| `scratch/fix_total_compras_seq.py` | Reconciliación Total Compras (ya ejecutado) |
| `scratch/migrar_convertidos_async.py` | Re-ubicación de convertidos (ya ejecutado) |
| `scratch/audit_out/*.json` / `*.txt` | Listados y logs de avance |
| `docs/PLAN_DESPLIEGUE_OFICINA_ACTUAL.md` | Plan de despliegue |

---

## ⚠️ NOTAS IMPORTANTES (lecciones aprendidas)

1. **`SalesOrder.sodate` está DENEGADO por rol en vTiger.** Usar `count(*)` y `hdnGrandTotal` (sí legibles). El campo de fecha de compra se toma de `spl_fecha_ultima_compra`.
2. **`mailingcity` denegado** → ciudad se toma de `cf_1157`.
3. **vTiger tiene 2 campos de oficina:** `cf_3451` (OFICINA original) y `cf_3590` (OFICINA ACTUAL). El motor ahora enruta por **`cf_3590`**.
4. **Campos de vTiger a veces están desactualizados** (`spl_num_compras`, `cf_1876`, `cf_3392`). La fuente de verdad son las **órdenes reales (SalesOrder)**, que es lo que reconcilia el motor.
5. **Smart Lists óptimas:** usar `Total Compras > 0` (cliente) vs `= 0` (contacto), con `Tiene Teléfono = Sí` para audiencia SMS.

---

*Checkpoint generado automáticamente al pausar la sesión. Para retomar, leer este archivo y ejecutar el comando de la sección PENDIENTE.*
