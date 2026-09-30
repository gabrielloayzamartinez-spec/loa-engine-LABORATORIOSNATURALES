# 📋 INFORME DE ACTUALIZACIÓN TÉCNICA: ACTIVACIÓN BENAVIDES, SINCRONIZACIÓN EN VIVO Y BÓVEDA CENTRAL GHL
**LOA ENGINE 2026 — LABORATORIOS NATURALES**  
**Fecha de Aplicación:** 30 de Septiembre de 2026  
**Rama:** `bionic/fix-seguridad`  
**Commit:** `9e9ee0f`  
**Estado:** ✅ **APTO PARA DEPLOY (13/13 Suites Validadas al 100%)**

---

## 1. RESUMEN EJECUTIVO

Este documento certifica las correcciones de arquitectura, reactivación de sedes y blindaje de sincronización aplicados sobre **LOA Engine**. Se resolvió el bloqueo crítico que impedía la sincronización de ventas de la sede **Benavides** en GoHighLevel, se integró el catálogo oficial de **Proveedores de Pauta**, se ratificó la regla de **Solo Compradores** para sedes operativas y se diseñó la estructura de **Listas Inteligentes** para la **Cuenta Empresa Central**.

---

## 2. DIAGNÓSTICO FORENSE: ¿POR QUÉ NO SINCRONIZABA BENAVIDES AYER?

### El Defecto Oculto en Producción
En el archivo `src/config/sedes_gateway.js`, la sede Benavides contenía la siguiente evaluación lógica:
```javascript
// src/config/sedes_gateway.js (Antes)
BENAVIDES: {
  ...
  isPaused: process.env.PAUSE_BENAVIDES !== 'false',
```

* **En el entorno de Render (Producción):** La variable `PAUSE_BENAVIDES` no estaba declarada en `render.yaml`.
* **Consecuencia:** `process.env.PAUSE_BENAVIDES` era `undefined`. La comparación `undefined !== 'false'` evaluaba a **`true`**.
* **Efecto en Cascada:**
  1. El gateway marcaba a Benavides como **pausada** permanentemente en producción.
  2. La función `getActiveSedes()` excluía a Benavides de la lista activa.
  3. El cron de fondo `runVtigerSalesBridge` (que corre cada 10 minutos) solo consultaba Palacios e ignoraba por completo a Benavides.
  4. Por este motivo, las ventas legítimas de Benavides nunca llegaban a su subcuenta de GHL.

---

## 3. PRUEBA FORENSE EN VIVO: VENTAS REALES EN VTIGER

Para descartar fallos en el CRM, se ejecutó una consulta directa contra vTiger (`modifiedtime` de las últimas 48 horas con `spl_num_compras > 0` y `cf_3451 = 'BENAVIDES'`). Se confirmó que **las ventas existen y tienen compradores reales**:

| Contacto | Teléfono (E.164) | Compras | Total Gastado | Fecha Modificación vTiger | Sede |
| :--- | :--- | :---: | :---: | :--- | :---: |
| **Ana Morales** | `+12135070196` | 3 | $1,760.00 | 29-09-2026 21:34:41 | BENAVIDES |
| **Francisca de Magallanes**| `+17196914898` | 4 | $1,280.00 | 30-09-2026 20:01:17 | BENAVIDES |
| **Juanita Garza** | `+19568786429` | 4 | $1,070.00 | 30-09-2026 20:01:17 | BENAVIDES |
| **Maria Lopez** | `+19194138380` | 6 | $970.00 | 29-09-2026 20:22:21 | BENAVIDES |
| **Moises Herless** | `+18302634329` | 2 | $660.00 | 30-09-2026 20:01:17 | BENAVIDES |
| **Rolando Mata** | `+12398773989` | 3 | $600.00 | 30-09-2026 20:05:35 | BENAVIDES |
| **Eladio Gonzalez** | `+12298488540` | 4 | $422.00 | 29-09-2026 21:34:41 | BENAVIDES |
| **Carmen Ventura** | `+19294299708` | 2 | $380.00 | 30-09-2026 20:05:28 | BENAVIDES |
| **Nelly Guerra** | `+16262779836` | 1 | $370.00 | 30-09-2026 20:01:17 | BENAVIDES |

---

## 4. MODIFICACIONES INSTALADAS EN EL CÓDIGO

### A. Reactivación de Benavides por Defecto (`src/config/sedes_gateway.js`)
Se invirtió la lógica para que Benavides **siempre esté activa** salvo que explícitamente se ordene pausarla:
```diff
- isPaused: process.env.PAUSE_BENAVIDES !== 'false',
+ isPaused: process.env.PAUSE_BENAVIDES === 'true',
```

### B. Declaración Explícita en Entorno de Producción (`render.yaml`)
Se agregó la variable en la configuración de despliegue para garantizar que Render nunca pause la sede:
```yaml
      - key: PREFLIGHT_MAX_MS
        value: "5000"
      - key: PAUSE_BENAVIDES
        value: "false"
```

### C. Mapeo Oficial del Campo `Proveedor` (`cf_2572`) (`src/services/dual_sync_service.js`)
Se conectó el campo `cf_2572` en la construcción de payloads (`buildUpsertPayloads`) tanto para la **Cuenta Empresa (Macro)** como para la **Sede Operativa**:
```javascript
if (vContact.cf_2572) {
  let prov = String(vContact.cf_2572).trim().toUpperCase();
  if (/pikalex|pikales/i.test(prov)) prov = 'CLICK2RING';
  push(fieldIdsCentral, 'proveedor', prov);
  pushSede('proveedor', prov);
}
```
* **Opciones canónicas soportadas:** `CLICK2RING`, `ERNESTO`, `UP_IDEAS`, `ENZO`, `IN_HOUSE`, `DIURNAY`.

---

## 5. REGLAS DE NEGOCIO Y GOBERNANZA RATIFICADAS

1. **Regla de Solo Compradores para Sedes Operativas:**
   * Hacia las subcuentas de Palacios y Benavides **SOLO se sincronizan contactos con compras reales (`spl_num_compras > 0`)**.
   * Los leads con 0 compras quedan excluidos de las sedes, evitando saturar a los asesores con registros vacíos.
2. **Rol de la Cuenta Empresa (Central):**
   * Es una réplica de **Solo Lectura / Analítica Macro** (Data Warehouse).
   * **CERO Ruteo:** No atiende chats automáticos ni asigna asesores comerciales.
   * Conecta con su propio PIT (`GHL_API_KEY_CENTRAL` / `GHL_LOCATION_ID_CENTRAL`).
3. **Principio Anti-Alucinación:**
   * Si un campo en vTiger está en blanco (ej. Citas, SMS), en GHL queda **estrictamente vacío**. Cero invención de datos.

---

## 6. ARQUITECTURA DE SMART LISTS PARA LA CUENTA EMPRESA CENTRAL

Para la gestión y auditoría gerencial en la subcuenta Central de GHL, se definieron los siguientes filtros:

### Bloque A: Control Comercial y Facturación
* **`[COM] Compradores Históricos (Convertidos)`**: `vTiger Total Compras > 0`
* **`[COM] Clientes VIP (3+ Compras)`**: `vTiger Total Compras >= 3`
* **`[COM] Recompra Alerta (> 60 Días)`**: `vTiger Total Compras > 0` AND `vTiger Fecha Última Compra < hace 60 días`

### Bloque B: Auditoría por Sedes (Sede-Watch)
* **`[SEDE] Palacios - Clientes`**: `Oficina Origen` = `PALACIOS`
* **`[SEDE] Benavides - Clientes`**: `Oficina Origen` = `BENAVIDES`
* **`[SEDE] Piura - Clientes`**: `Oficina Origen` = `PIURA`
* **`[SEDE] Roosevelt - Clientes`**: `Oficina Origen` = `ROOSEVELT`

### Bloque C: Auditoría de Agencias y Pauta
* **`[PROV] Click2Ring`**: `Proveedor` = `CLICK2RING`
* **`[PROV] Ernesto`**: `Proveedor` = `ERNESTO`
* **`[PROV] In-House / Orgánico`**: `Proveedor` = `IN_HOUSE`

### Bloque D: Segmentación por Tratamiento
* **`[SALUD] Artritis`**: `Tratamiento Comprado` = `Artritis`
* **`[SALUD] Diabetes`**: `Tratamiento Comprado` = `Diabetes`
* **`[SALUD] Potencia / Vigor`**: `Tratamiento Comprado` = `Potencia` (o `Tetosterona`)

---

## 7. CERTIFICACIÓN TÉCNICA Y AUDITORÍA DE PRUEBAS

* **Suites de Pruebas Automatizadas:** 13 de 13 pasadas al 100%.
  1. `test_audit_engine.js` (8/8 reglas protocolares)
  2. `test_commercial_engine.js` (Lógica de compras y cálculo)
  3. `test_cooldown_mudanza.js` (Aislamiento y ventanas de gracia)
  4. `test_doble_ingreso.js` (Detección de reingresos publicitarios)
  5. `test_sede_isolation.js` (Aislamiento estricto de datos de sede)
  6. `test_sede_governance.js` (Sede-Lock y Sede-Shield)
  7. `test_queue_policy.js` (Control de tasa y TokenBucket)
  8. `test_clinical_vocabulary.js` (9 tratamientos oficiales)
  9. `test_security_hardening.js` (Inyección SQL, XSS, Solo Lectura vTiger)
  10. `test_ingress_filter.js` (Filtro temprano y detección de transporte)
  11. `test_dual_upsert.js` (Carga dual Central + Sedes y mapeo de campos)
  12. `test_order_history.js` (Historial detallado de SalesOrder)
  13. `test_contact_collision.js` (Merge SOP y enfrentamiento de teléfonos)
* **Pre-Flight Sanity Gate:** Ejecutado en **22 ms** (Presupuesto: 5,000 ms).
* **Veredicto:** **`APTO PARA DEPLOY`**.

---

*Documento técnico de auditoría generado por LOA Engine.*
