# CAMPAÑAS SMS A **SIN VENTA** — QUÉ ESTÁ LISTO Y QUÉ FALTA

**Fecha:** 27-nov-2026 · **Medición:** leads (`spl_num_compras = 0`) por sede ACTUAL, muestra de 12

---

## 1. Tu premisa se cumple: la sede ya está correcta

| Campo | Palacios | Benavides | Estado |
| :--- | ---: | ---: | :--- |
| **Sede Asignada = sede actual** | **100%** | **100%** | ✅ listo |
| **Estado de Compra** | **100%** | 86% | ✅ listo para "No Comprador" |
| Tratamiento comprado | **100%** | 86% | ✅ |
| Estado Comercial | 100% | — | ✅ |
| Proveedor | 80% | — | 🟡 |
| Canal Captación | **10%** | 57% | 🔴 muy vacío en Palacios |
| Fecha Creación (DATE) | **0%** | **0%** | 🔴 100% vacío |
| Campaña | 0% coincide (100% difiere) | — | 🟡 diferencia semántica |
| Contact No / ID Cliente | 0–20% | — | 🟡 vTiger no los tiene en leads |

**Conclusión:** cada lead ya está en la subcuenta de **su sede actual** y con la `Sede Asignada` correcta. Eso era lo crítico para trabajar por oficina, y está al 100%.

---

## 2. Lo que YA puedes lanzar hoy

Filtro de Smart List en GHL (Contactos):

```
Sede Asignada = <PALACIOS | BENAVIDES | ROOSEVELT | PIURA>
Y  Estado de Compra = No Comprador
Y  Tiene Teléfono = Sí
[opcional] Y Tratamiento comprado = <Diabetes | Potencia | Artritis …>
```

Eso ya funciona: sede 100%, estado de compra 100% (Palacios) / 86% (Benavides), tratamiento 100% / 86%.

Alternativa equivalente por etiqueta: `prospecto-vtiger` (la escribe el motor en cada lead sincronizado).

---

## 3. Lo que falta para segmentar mejor

| # | Qué falta | Impacto en la campaña | Cómo se cierra |
| :--- | :--- | :--- | :--- |
| 1 | **Fecha Creación (DATE)** vacía al 100% | no se puede hacer "creados este mes" ni "del último trimestre" | **desplegar** + re-sincronizar leads (el campo ya tiene escritor) |
| 2 | **Canal Captación** vacío (Palacios 90%) | no se puede separar formulario vs Messenger | viene vacío de vTiger (`cf_3507`); se puede derivar del origen compuesto `cf_3472` |
| 3 | **Campaña** con semántica distinta | el campo `UTM Campaign` guarda la campaña de Meta; vTiger guarda el origen compuesto | usar `Campaña Meta` para pauta y `Origen Compra` para el origen de vTiger |
| 4 | `Estado de Compra` 86% en Benavides | 14% de leads sin clasificar | el re-llenado de fondo lo corrige |

---

## 4. Plan mínimo para operar SMS a sin venta

1. **Desplegar** (sin esto, `Fecha Creación (DATE)` seguirá vacía).
2. **Re-sincronizar los leads por sede y año** con el runner:
   ```bash
   node tools/historico.mjs sincronizar --sede=PALACIOS --tipo=contactos --ano=2026 --limite=50 --ejecutar
   ```
   Prioridad: 2026 y 2025 (los que van a campaña).
3. **Verificar**:
   ```bash
   node tools/local_sync.mjs cobertura --sede=PALACIOS --tipo=contactos --muestra=12
   ```
   Objetivo: Fecha Creación (DATE) ≥ 95%, Canal ≥ 80%, Sede 100%.
4. **Crear la lista** con el filtro del punto 2 y lanzar.

---

## 5. Volumen y costo de re-sincronizar los leads

| Sede | Leads (sede actual) | Llamadas estimadas | Tiempo a 2/s |
| :--- | ---: | ---: | ---: |
| Palacios | 176.206 | ~530k | ~3 días |
| Benavides | 124.035 | ~370k | ~2 días |
| Roosevelt | 41.474 | ~125k | ~17 h |
| Piura | 35.151 | ~105k | ~15 h |

Por eso conviene hacerlo **por año y por sede**, empezando por 2026–2025 (los que tienen campaña), y no los 377k de golpe.

---

## 6. Recordatorio de cumplimiento

Para SMS masivo GHL exige *opt-in*. Hoy el motor no registra consentimiento. Define el campo o etiqueta (`sms-optin`) y agrégalo al filtro antes de la primera campaña; de lo contrario no es defendible.
