# 🕵️ AUDITORÍA EN VIVO — SUBCUENTA GHL BENAVIDES
**Sede Benavides (vTiger `cf_3451='BENAVIDES'`) ↔ GHL subcuenta `QXcNBK6XCgpQaZ81Z8pv`**
**Fecha de ejecución:** 17 de noviembre de 2026 (14:49 America/Lima)
**Método:** Reconciliación directa contra las APIs reales de vTiger y GoHighLevel (accesos locales de operación).

---

## 1. VEREDICTO EJECUTIVO

| Pregunta del negocio | Respuesta | Detalle |
| :--- | :--- | :--- |
| ¿Están TODOS los datos de Benavides sincronizados? | ⚠️ **NO al 100%** | **26 compradores faltan** en GHL (0.44% de la cartera). 99.5% sí está. |
| ¿Se filtraron contactos que NO corresponden? | ✅ **NO** | Cero contactos de otra sede (Palacios/Roosevelt/Piura). Solo 3 registros mal etiquetados y 37 "esqueleto". |

**Conclusión:** La subcuenta Benavides está **sana en cuanto a aislamiento** (no hay contaminación cruzada de sedes), pero tiene un **rezago real de sincronización**: 26 compradores legítimos de Benavides no han llegado a GHL, concentrados en proveedor `IN_HOUSE` + canal `FORM`.

---

## 2. VOLÚMENES MEDIDOS EN VIVO

| Fuente | Métrica | Valor |
| :--- | :--- | ---: |
| vTiger | Contactos totales | 418 040 |
| vTiger | Contactos sede **BENAVIDES** (`cf_3451`) | 65 419 |
| vTiger | **Compradores** Benavides (`spl_num_compras > 0`) | **5 890** |
| vTiger | Contactos sede Palacios (referencia) | 335 662 |
| GHL | Contactos subcuenta Benavides (`QXcNBK6...`) | **36 051** |

---

## 3. RESPUESTA 1 — COMPLETITUD DE LA SINCRONIZACIÓN

Reconciliación por **teléfono normalizado (E.164 / últimos 10 dígitos)**, la llave única de negocio:

| Estado | Cantidad | % |
| :--- | ---: | ---: |
| Compradores vTiger Benavides | 5 890 | 100 % |
| Presentes en GHL Benavides | 5 863 | **99.54 %** |
| **FALTANTES en GHL** | **26** | **0.44 %** |
| Sin teléfono válido (no sincronizable) | 1 | 0.02 % |

### Perfil de los 26 faltantes
- **22 de 26** son `Proveedor = IN_HOUSE` y `Canal = FORM`.
- Fechas de última compra mezcladas: **12 recientes** (sept–nov 2026) y **14 históricas** (2020–2025), es decir no es solo "lag", hay compradores que **nunca** se sincronizaron.
- Varios con nombres de ficha de prueba/placeholder (ej. `INOCENTA LEAD`, apellido literal "LEAD").

> **Causa raíz operativa (contexto local):** el cursor del backfill
> (`data/state_reverse_sync_cursor.json`) quedó congelado en
> **2026-10-01** (`ultimaEjecucion: 2026-10-01T04:09Z`). Los compradores creados
> después de esa fecha —y un lote histórico de FORM/IN_HOUSE— nunca entraron al
> flujo `vtiger_sales_bridge` → GHL.

---

## 4. RESPUESTA 2 — CONTAMINACIÓN (¿entraron contactos que no corresponden?)

**No se detectó contaminación cruzada de sedes.** Ningún contacto de la subcuenta
Benavides tiene otra sede en sus campos de origen:

| Campo GHL | BENAVIDES | (vacío) | PALACIOS | Otras sedes |
| :--- | ---: | ---: | ---: | ---: |
| **Sede Asignada** | 36 011 | 37 | 3 | 0 |
| **Sede / Tienda Compra** | 13 815 | 22 236 | 0 | 0 |
| **Origen Lead** (prefijo de sede) | 34 614 | 106 | 0 | 0 |

### Los 3 contactos etiquetados `Sede Asignada = PALACIOS` — verificación forense
Se buscaron en vTiger y **los 3 son leads reales de BENAVIDES**, no clientes de Palacios:

| Contacto | Teléfono | vTiger `cf_3451` | Origen Lead en GHL | Veredicto |
| :--- | :--- | :--- | :--- | :--- |
| marta diaz | +18134450370 | **BENAVIDES** | BENAVIDES-… | ❌ etiqueta equivocada, persona correcta |
| emerito rivera | +17873730040 | **BENAVIDES** | BENAVIDES-… | ❌ etiqueta equivocada, persona correcta |
| sonnyge reyna | (sin tel) | — | BENAVIDES-IN_HOUSE-DESCONOCIDO-… | ❌ etiqueta equivocada, persona correcta |

> Los tres comparten el patrón `IN_HOUSE` + atribución `DESCONOCIDO`/`Desconocido`:
> son leads que entraron por una vía donde la sede/proveedor no se resolvió y el
> campo "Sede Asignada" cayó al fallback **PALACIOS**. Es un **bug de etiquetado**,
> no una fuga de clientes de otra sede.

### Los 37 contactos con "Sede Asignada" vacía
Registros sin `proveedor`, sin `origenLead`, sin `canal` y sin `compras`
("esqueleto"), 11 de ellos sin teléfono. Corresponden a altas manuales/CSV ajenas
al flujo LOA. No son contaminación de sede, pero son ruido de higiene de datos.

---

## 5. COMPOSICIÓN DE LA SUBCUENTA (36 051 contactos)

| Bloque | Cantidad | Origen legítimo |
| :--- | ---: | :--- |
| Compradores (`Estado de Compra = Comprador`) | 4 967 | vTiger backfill + curador |
| Leads (`No Comprador`) | 30 399 | Meta webhook Nivel 1 (page matrix Benavides) |
| Sin estado de compra | 685 | pendientes/parciales |

**Proveedores presentes:** ERNESTO 17 361 · CLICK2RING 9 107 · REDES 2 BENAVIDES
7 267 · ENZO 358 · IN_HOUSE 296 · UP_IDEAS 1 · (vacío) 1 661.
**Canales:** FB-MSGR 8 572 · FORM 5 803 · WHATSAPP 184 · TIKTOK 43 · SMS 1.

Los ~30 400 leads son **legítimos de Benavides**: entran en tiempo real por las 3
páginas de Meta de Benavides (`Naturales Bio Corp`, `Bio Natural`, `BioNatural Fuerza`)
con `Sede Asignada = BENAVIDES`. No son contactos "filtrados de más".

---

## 6. ACCIONES RECOMENDADAS

1. **Reanudar el backfill Benavides** y avanzar el cursor de
   `state_reverse_sync_cursor.json` (hoy detenido en 2026-10-01). Recupera los 26
   compradores faltantes en minutos (cada contacto consume ~8.6 llamadas GHL).
2. **Corregir el fallback de "Sede Asignada"** para leads `IN_HOUSE` con atribución
   no resuelta: hoy caen a `PALACIOS` en vez de `UNRESOLVED`/fail-closed (Regla 3
   de gobernanza). Re-etiquetar los 3 contactos afectados.
3. **Depurar los 37 registros "esqueleto"** (sin sede ni atribución) o marcarlos
   para revisión manual.
4. **Depurar fichas de prueba** (ej. `INOCENTA LEAD`, `SANTOS LUNA` con teléfono `.`).
5. Verificar si `PAUSE_CUENTA_EMPRESA=true` es intencional (afecta solo a la cuenta
   Central analítica, no a Benavides).

---

*Informe generado por LOA Engine Auditor a partir de mediciones directas contra las APIs de vTiger y GoHighLevel. Las listas completas (compradores, faltantes, contaminación) quedaron guardadas en `scratch/audit_out/*.json`.*
