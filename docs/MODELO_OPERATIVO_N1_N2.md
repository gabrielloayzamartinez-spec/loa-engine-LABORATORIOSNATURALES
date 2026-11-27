# MODELO OPERATIVO N1 / N2 — LO QUE SE CORRIGIÓ Y CÓMO SE PRUEBA

**Fecha:** 27-nov-2026 · **Contexto:** servidor paralizado; se reconstruye y valida en local.

---

## 1. La regla del negocio (tal como la definiste)

| Momento | Quién | Qué hace |
| :--- | :--- | :--- |
| **HOY** | **Nivel 1** | etiquetado inteligente, reemplazo de etiquetas, y **cuando el lead da su número**: si el número es NUESTRO (existe en vTiger) se cruza y se llenan sus CF = **éxito de sincronización**. Si es lead nuevo, **no se hace nada**. |
| **MAÑANA** | **Nivel 2** | la VENTA de hoy (orden de venta con sus CF nuevos) se sincroniza al día siguiente. Todo lo histórico hasta el día previo. |

Consecuencia de diseño: **el N1 no toca órdenes ni ventas de hoy**; solo calidad de CONTACTO. La venta entra por N2 al día siguiente.

---

## 2. Lo que estaba rompiendo el trabajo de redes (causa raíz encontrada)

### 2.1 El ruteo se ABORTABA cuando no había asesor

```js
if (!targetAdvisorId && targetAdvisorName !== 'Cola Forms') {
  console.log(`No se encontró un asesor asignado para la página ${targetPageName}.`);
  return;   // ← salía sin etiquetar
}
```

Ese corte era coherente cuando el N1 **asignaba dueños**. Pero desde que el dueño se fuerza a `null` (trabajo por etiquetas), cualquier página sin asesor resolvía **sin canal, sin proveedor y sin página**: las vistas del equipo quedaban vacías.

**Corregido:** se registra y se **continúa etiquetando**.

### 2.2 El fallback marcaba `revisar-ruteo` en TODOS los leads nuevos

```js
targetAdvisorId = asesoresPropios[0].id;
routingReviewReason = 'asignado por defecto al primer asesor de la sede';
```

Asignaba el primer asesor y marcaba revisión… pero el payload después fuerza `assignedTo = null`. Resultado: el dueño nunca llegaba y **la única huella era `revisar-ruteo`** en cada lead de Messenger sin teléfono (4 de 6 en la muestra; 45 de 100 en la primera página de GHL).

**Corregido:** no se asigna a nadie y no se marca revisión si la página, el proveedor y el canal están resueltos.

### 2.3 La página resuelta por etiqueta perdía el `pageId`

Si el contacto no tenía mensaje indexado, la página salía de su etiqueta `pagina-*` pero `targetPageId` quedaba `null` → `getPageMatrixEntry(null)` → "fanpage no mapeada" → `revisar-ruteo`.

**Corregido:** se recupera el `pageId` desde el mapa inverso.

---

## 3. Lo que se agregó (tu lógica de "se obtuvo el número")

En el momento en que el teléfono aparece en el chat (o llega por formulario), el router:

1. Reintenta el cruce con vTiger con **2.5 s** (el fast-path normal es 900 ms; este evento ocurre **una vez** por contacto).
2. Si el número **existe en vTiger y es de la misma sede** → trae sus datos y llena sus CF.
   Auditoría: `N1_NUMERO_MATCH_OK` (con `vTigerId` y nº de compras).
3. Si el número **no existe** → lead nuevo: **no se hace nada**.
   Auditoría: `N1_NUMERO_SIN_MATCH`.
4. Si el número es de **otra sede** → no se cruza.
   Auditoría: `N1_NUMERO_MATCH_OTRA_SEDE`.
5. Si vTiger no responde → `N1_NUMERO_MATCH_TIMEOUT` (se reintenta en el próximo ruteo).

Así el "éxito de sincronización" queda **medible** en la auditoría.

---

## 4. Frontera N1 / N2 aplicada al código

| Antes | Ahora |
| :--- | :--- |
| El tail de órdenes procesaba ventas del mismo día | **Corta en la medianoche de Lima**: la venta de hoy la publica N2 mañana |
| N1 podía tocar CF de compra | N1 solo calidad de contacto; los CF de venta los escribe N2 |

---

## 5. Cómo se prueba en local (servidor apagado)

```bash
# 1. Simular un contacto (no escribe)
node tools/lab_n1.mjs --contacto=<idGHL>

# 2. Muestra por sede con conteo de anomalías
node tools/lab_n1.mjs --sede=PALACIOS --muestra=10 --json=scratch/n1.json

# 3. Limpiar la etiqueta heredada (simulación primero)
node tools/limpiar_revisar_ruteo.mjs --sede=PALACIOS --limite=50
node tools/limpiar_revisar_ruteo.mjs --sede=PALACIOS --limite=50 --ejecutar
```

### Resultado medido hoy (Palacios, 6 contactos reales)

| Chequeo | Antes | Después |
| :--- | ---: | ---: |
| `revisar-ruteo` | **4 / 6** | **0 / 6** |
| Sin canal | 0 | 0 |
| Sin página | 0 | 0 |
| Sin proveedor | 0 | 0 |
| Errores | 0 | 0 |

Y en la primera página de GHL: **45 de 100 contactos** arrastran la etiqueta `revisar-ruteo`; la herramienta los limpia re-ruteando (los 5 probados quedaron limpios).

---

## 6. Orden de trabajo para dejarlo operativo

| Paso | Qué | Estado |
| :--- | :--- | :--- |
| 1 | Quitar el aborto por "sin asesor" | ✅ hecho |
| 2 | Quitar el `revisar-ruteo` del fallback | ✅ hecho |
| 3 | Recuperar `pageId` desde la etiqueta | ✅ hecho |
| 4 | Match de "número obtenido" con auditoría | ✅ hecho |
| 5 | Venta de hoy → N2 mañana | ✅ hecho |
| 6 | Limpiar la etiqueta heredada en las 4 sedes | 🟡 pendiente de ejecutar |
| 7 | Revisar las vistas de GHL (por proveedor/página) tras la limpieza | 🟡 |
| 8 | Probar los 8 casos borde del documento de auditoría | 🟡 |

---

## 7. Criterio de aceptación del N1

| Métrica | Objetivo |
| :--- | ---: |
| Contactos con canal | 100% |
| Contactos con proveedor | 100% |
| Contactos con página | ≥ 99% |
| `revisar-ruteo` | ≤ 2% |
| Etiquetas duplicadas de proveedor | 0 |
| Match de número con auditoría registrada | 100% de los que dan número |
