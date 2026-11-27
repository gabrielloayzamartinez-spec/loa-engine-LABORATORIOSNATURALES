# OPERACIÓN AUTOCORRECTIVA N1 — RESULTADO Y AUDITORÍA

**Fecha:** 27-nov-2026 · **Ejecutada en local** (servidor Render apagado) · **Auditoría:** JSON por acción en `scratch/audit_out/`

---

## 1. Resultado de la operación

| Sede | Contactos con `revisar-ruteo` | Limpiados | Mejorados | Siguen marcados | Errores |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Palacios | 291 | **277** | 0 | 14 | 0 |
| Benavides | 180 | **149** | 3 | 31 | 0 |
| Roosevelt | 302 | **281** | 0 | 21 | 0 |
| Piura | 2 | **2** | 0 | 0 | 0 |
| **Total** | **775** | **709 (91,5%)** | **3** | **66 (8,5%)** | **0** |

- **709 contactos** quedaron con su etiqueta corregida (canal/proveedor/página completos y `revisar-ruteo` retirado).
- **3 contactos** además ganaron etiquetas que les faltaban.
- **0 errores** en 775 operaciones.
- Cada acción tiene su registro con el **antes** y el **después** de las etiquetas por familia (`canal-`, `prov-`, `pagina-`, `producto-`).

---

## 2. Verificación posterior

### 2.1 La etiqueta casi desapareció de las páginas visibles

| Sede | Antes (3 páginas) | Después (3 páginas) |
| :--- | ---: | ---: |
| Palacios | ~150 | **6** |
| Benavides | ~150 | **7** |
| Roosevelt | ~150 | **10** |
| Piura | 0 | **0** |

### 2.2 Calidad del ruteo (muestra fresca, 5 contactos por sede)

| Sede | Sin canal | Sin página | Sin proveedor | `revisar-ruteo` | Errores |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Palacios | 0 | 0 | 0 | 0 | 0 |
| Benavides | 0 | 0 | 0 | 0 | 0 |
| Roosevelt | 0 | 0 | 0 | 0 | 0 |
| Piura | 0 | 0 | 0 | 0 | 0 |

**20 de 20 contactos** salen con canal, página, proveedor y sin marca de revisión.

---

## 3. Causas raíz corregidas (la raíz del problema)

| # | Defecto | Qué provocaba | Corrección |
| :--- | :--- | :--- | :--- |
| 1 | `return` cuando no había asesor para la página | el lead se quedaba **sin canal, sin proveedor y sin página** | se registra y **se etiqueta igual** |
| 2 | El fallback asignaba "el primer asesor" y marcaba `revisar-ruteo` | dueño nunca llegaba (se fuerza `null`) y **la única huella era la etiqueta** | ya no asigna ni marca |
| 3 | Página resuelta por etiqueta perdía el `pageId` | `getPageMatrixEntry(null)` → "fanpage no mapeada" | se recupera el `pageId` del mapa inverso |

---

## 4. Los 66 que siguen marcados (no es un fallo)

Son contactos **sin evidencia de Meta**: no tienen ninguna conversación indexada o entraron por SMS/WhatsApp (que el motor delega al workflow nativo de GHL). El router, por diseño, **no los etiqueta** y deja la marca para revisión humana.

**Decisión de negocio pendiente:** ¿se quieren etiquetar igual (asignando sede/canal genérico) o se dejan fuera del trabajo de redes?

---

## 5. Qué falta para subir al servidor

| # | Paso | Estado |
| :--- | :--- | :--- |
| 1 | Corregir los 3 defectos del router | ✅ hecho y probado |
| 2 | Operación autocorrectiva en las 4 sedes | ✅ 775 procesados, 0 errores |
| 3 | Verificación de calidad (20/20) | ✅ |
| 4 | 24 suites de prueba | ✅ en verde |
| 5 | Revisar las **vistas de GHL** (por proveedor y página) | 🟡 pendiente de tu validación visual |
| 6 | Decidir qué hacer con los 66 sin evidencia | 🟡 decisión tuya |
| 7 | Desplegar a Render | 🟡 con tu OK |

---

## 6. Archivos de auditoría

```
scratch/audit_out/n1_autocorrectiva_<SEDE>_<timestamp>.json
```

Cada archivo contiene: resumen, y por cada contacto el `antes`/`despues` de las etiquetas por familia, si se retiró `revisar-ruteo`, el motivo vigente (si quedó), asesor, canal, página y proveedor resultantes.

Registros de ejecución: `logs/n1_op_<SEDE>.log`.
