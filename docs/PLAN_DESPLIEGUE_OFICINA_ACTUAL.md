# 🚀 PLAN DE DESPLIEGUE — Enrutamiento por Oficina Actual (cf_3590)

**Fecha:** 18 de noviembre de 2026
**Rama:** `main`
**Estado previo:** código corregido y probado en local (verde). Migración de re-ubicación ejecutada en local.

---

## 1. Qué cambió (resumen del código)

Corrección de **gobernanza de enrutamiento**: la sede de destino en GHL se determina
ahora por la **Oficina Actual** (`cf_3590` = `ACTUAL_OFICINA`), no por la oficina
original (`cf_3451` = `OFICINA`).

| Archivo | Cambio |
| :--- | :--- |
| `src/services/dual_sync_service.js` | `resolveSedeFromVtiger()` prefiere `cf_3590` (fallback `cf_3451`); Sede-Shield usa `cf_3590` como origen |
| `src/services/vtigerClient.js` | Nuevo campo `SEDE_ACTUAL` (`cf_3590`) + incluido en `VTIGER_CONTACT_SELECT` |
| `src/tests/test_dual_upsert.js` | 3 aserciones nuevas: `cf_3590` gana sobre `cf_3451` |

**Por qué:** vTiger tiene DOS campos de oficina. `cf_3451` (OFICINA) es la oficina
de registro/compra inicial; `cf_3590` (ACTUAL_OFICINA) es a dónde fue **reasignado**
el contacto. Los contactos se reasignan entre sedes (vTiger lleva `Fecha ultima
reasignación` y `Cantidad de Reasignaciones`), y la oficina actual es la que manda
para que el comprador quede en la subcuenta correcta.

---

## 2. Pruebas en verde (antes de desplegar)

```
test_dual_upsert.js         222 aserciones ✅ (incluye las 3 nuevas de cf_3590)
test_clinical_vocabulary.js  42 ✅
test_security_hardening.js   57 ✅
test_sede_governance.js      69 ✅
test_sede_isolation.js      100% ✅
test_contact_collision.js    63 ✅
test_order_history.js        51 ✅
test_commercial_engine.js   SUCCESS ✅
test_audit_engine.js        34/34 reglas ✅
```

---

## 3. Pasos de despliegue

### Paso 1 — Commit (solo los 3 archivos de código)
```bash
git add src/services/dual_sync_service.js src/services/vtigerClient.js src/tests/test_dual_upsert.js
git commit -m "fix(enrutamiento): sincronizar por Oficina Actual (cf_3590) en vez de OFICINA (cf_3451)"
```

> No commitear `scratch/` (está en .gitignore) ni los `.docx`/`.md` de informe salvo
> que quieras versionarlos. Los scripts de migración son de un solo uso (scratch/).

### Paso 2 — Push a GitHub
```bash
git push origin main
```

### Paso 3 — Render (auto-deploy)
- El servicio `ghl-pipeline-maestro-tool` vigila `main` y **redeploya automático**.
- `render.yaml` ya tiene `PAUSE_BENAVIDES=false`, y las credenciales de las 4 sedes
  con `sync: false` (se mantienen en el dashboard de Render, no se sobrescriben).
- **No se requieren variables nuevas**: `cf_3590` ya es leíble por el rol de API de
  vTiger (verificado en vivo).

### Paso 4 — Verificación post-deploy
1. `GET /api/health` → `200 OK`.
2. `node src/scripts/preflight.js` → `APTO PARA DEPLOY`.
3. Confirmar en logs que aparece `[Dual Sync] [FIELDS] ... SEDE_ACTUAL` o que un
   comprador reasignado aterriza en la subcuenta de su Oficina Actual.

---

## 4. Consideraciones operativas importantes

1. **Re-ubicación local ya ejecutada**: se movieron ~7 900 convertidos desfasados
   (Palacios↔Benavides). Roosevelt y Piura quedan **pendientes** porque aún no tienen
   subcuenta GHL (`GHL_LOCATION_ID_ROOSEVELT/PIURA` vacíos). Al configurarlas, el
   backfill las llenará con el nuevo enrutamiento.

2. **Backfill**: tras el deploy, conviene **resetear el cursor de backfill** para que
   re-recorra la cartera con el nuevo criterio (los reasignados que ya se procesaron
   con el criterio viejo se re-sincronizan a su subcuenta correcta).

3. **Alcance del cambio (honesto)**: el cambio cubre el **camino principal de
   sincronización de compradores** (`dual_sync_service` → backfill / sales bridge /
   reverse sync). Existen otros módulos que aún leen `cf_3451` para sus propios flujos
   (`commercial_engine.js`, `chat_router_agent.js`, `vtiger_sync_agent.js`,
   `vtiger_order_history_service.js`, `contact_collision_service.js`). Recomiendo
   alinearlos en un **segundo PR** para consistencia total, pero **no bloquean** la
   corrección principal de compradores.

---

*Plan generado por LOA Engine Auditor tras la corrección local validada.*
