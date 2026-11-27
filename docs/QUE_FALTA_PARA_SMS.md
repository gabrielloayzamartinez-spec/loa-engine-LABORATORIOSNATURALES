# QUÉ FALTA PARA TENER LAS LISTAS INTELIGENTES OPERATIVAS (SMS)

**Fecha:** 27-nov-2026 · **Medición:** compradores de Palacios, muestra de 10 (cobertura campo por campo)

---

## 1. Estado actual de los campos que usa una campaña SMS

| Campo | Coincide con vTiger | Vacío en GHL | ¿Sirve hoy para segmentar? |
| :--- | ---: | ---: | :--- |
| Sede Asignada | **100%** | 0% | ✅ sí |
| Tratamiento comprado | **100%** | 0% | ✅ sí |
| Proveedor | 89% | 0% | ✅ sí |
| Estado Comercial | 78% | 0% | 🟡 parcial |
| Sexo | 67% | 33% | 🟡 parcial |
| Total Compras | 56% | 22% | 🟡 parcial |
| Fecha Primera Compra | 56% | 44% | 🟡 parcial |
| Total Histórico | 56% | 44% | 🟡 parcial |
| Canal Captación | 56% | 22% | 🟡 parcial |
| **Fecha Última Compra** | 44% | **44%** | 🔴 no fiable |
| **Contact No / ID Cliente** | 44% | 22% | 🟡 |
| **Etapa Comercial** | 44% | 33% | 🔴 no fiable |
| **Campaña / UTM** | 44% | 0% | 🟡 |
| **Asesor Asignado** | 25% | 50% | 🔴 |
| **Estado de Compra** | 11% | **33%** | 🔴 **clave para separar comprador/no comprador** |
| **Fecha Creación (DATE)** | **0%** | **100%** | 🔴 **clave para campañas por fecha** |

**Global: 54% de coincidencia.**

---

## 2. Lo que falta (no es código: es datos)

Los tres campos que fallan siempre **ya tienen escritor en el código** (se corrigió esta semana), pero el valor no está en GHL porque ese código **todavía no está desplegado** y, una vez desplegado, los contactos existentes solo se actualizan cuando cambian.

| # | Qué falta | Cómo se cierra | Costo |
| :--- | :--- | :--- | :--- |
| 1 | **Desplegar** los cambios | push a Render | — |
| 2 | **Rellenar los 3 campos nuevos** en la cartera: Fecha Creación (DATE), Estado de Compra, Fuente Última Orden | pasada sobre compradores | ~45.700 contactos · ~183k llamadas · 1,5–2 días |
| 3 | **Completar fechas y montos** del ~44% que está vacío | la misma pasada (relee la ficha y publica todo) | incluido |
| 4 | **Roosevelt y Piura** | agregar `GHL_LOCATION_ID_*` al `.env` | — |
| 5 | **Consentimiento SMS** | no existe campo: hay que decidirlo | — |

> No hace falta sincronizar los 377.000 leads para operar SMS: los compradores son 45.753 y son los que generan ingreso. Los leads se segmentan por etiqueta (`prospecto-vtiger`), que ya se escribe.

---

## 3. Listas que YA se pueden crear (con lo que hay hoy)

| Lista | Filtro en GHL | ¿Funciona hoy? |
| :--- | :--- | :--- |
| **Compradores** | etiqueta `compro` **o** `Estado de Compra = Comprador` | ✅ (la etiqueta ya existe) |
| **No compradores** | etiqueta `prospecto-vtiger` | ✅ |
| **Por sede** | `Sede Asignada = PALACIOS` (o su sede) | ✅ |
| **Por producto** | `Tratamiento comprado = Diabetes` | ✅ |
| **SMS por sede y producto** | Sede + Tratamiento + `Tiene Teléfono = Sí` | ✅ |
| **Recompra** | `Total Compras >= 2` | 🟡 (22% vacío) |
| **Recompra (explícita)** | `Fuente Última Orden = Mi Re-Orden` | 🔴 hasta el relleno |
| **Creados este mes** | `Fecha Creación (Fecha)` entre el 1 y el último día | 🔴 hasta el relleno |
| **Compró últimos 30 días** | `Fecha Última Compra >= hoy − 30` | 🔴 hasta el relleno |

---

## 4. Plan para dejarlas operativas

1. **Desplegar.**
2. **Pasada de compradores por sede** (rellena los 3 campos nuevos + fechas/montos). Se puede hacer:
   - desde producción: el backfill de compradores (ya recorre por sede actual), o
   - desde local: `node tools/historico.mjs sincronizar --sede=PALACIOS --tipo=compradores --ano=2026 --ejecutar` (repetir por año).
3. **Verificar** con `node tools/local_sync.mjs cobertura --sede=PALACIOS --muestra=10`: los campos 🔴 deben pasar a ≥95% de coincidencia.
4. **Crear las 4 listas** que dependen de los campos nuevos.
5. **Definir el consentimiento** antes de lanzar el primer SMS masivo.

**Criterio de "listas operativas"**

| Campo | Objetivo |
| :--- | ---: |
| Sede / Tratamiento | 100% (ya) |
| Estado de Compra | ≥ 99% |
| Fecha Creación (DATE) | ≥ 99% |
| Fecha Última Compra (compradores) | ≥ 95% |
| Total Compras | ≥ 95% |

---

## 5. Advertencia de cumplimiento

GHL exige *opt-in* para SMS masivo. El motor **no registra consentimiento** hoy. Antes de la primera campaña hay que decidir dónde se guarda (campo propio en GHL o etiqueta `sms-optin`) y filtrar por él. Sin eso, la campaña no es defendible aunque los CF estén completos.
