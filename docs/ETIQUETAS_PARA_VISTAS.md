# ETIQUETAS PARA CREAR VISTAS DE CHAT (GHL)

**Fecha:** 27-nov-2026 · **Fuente:** inventario real de las 4 subcuentas + 1.000 contactos auditados

---

## 1. Las 4 familias que sirven para vistas

| Familia | Ejemplo | Para qué sirve en una vista |
| :--- | :--- | :--- |
| `canal-…` | `canal-messenger` | separar Messenger / formulario / WhatsApp / TikTok |
| `prov-…` | `prov-ernesto` | **vista por proveedor** (lo que pediste) |
| `pagina-…` | `pagina-naturales-bionatural` | vista por fanpage |
| `producto-…` | `producto-diabetes` | vista por padecimiento |

En GHL: **Conversaciones → Filtros → Etiquetas**. Se pueden combinar (Y / O).

---

## 2. Etiquetas canónicas por subcuenta (las que el motor escribe hoy)

### PALACIOS

| Familia | Etiquetas |
| :--- | :--- |
| Canal | `canal-messenger` · `canal-forms` · `canal-whatsapp` · `canal-sms` · `canal-tiktok` |
| Proveedor | `prov-ernesto` · `prov-in-house` · `prov-click2ring` · `prov-en-casa-g` · `prov-enzo` · `prov-up-ideas` |
| Página | `pagina-naturales-bionatural` · `pagina-laboratorios-naturales-bio` · `pagina-bionatural-ultra` · `pagina-bio-vida-natural` · `pagina-biohealth-natural` · `pagina-bionatural-salud` |
| Producto | `producto-diabetes` · `producto-potencia` · `producto-artritis` · `producto-colageno` · `producto-gastro` · `producto-gummies` · `producto-prostata` · `producto-testosterona` · `producto-vision` · `producto-general` |

### BENAVIDES

| Familia | Etiquetas |
| :--- | :--- |
| Canal | `canal-messenger` · `canal-forms` · `canal-whatsapp` · `canal-sms` · `canal-tiktok` |
| Proveedor | `prov-ernesto` · `prov-in-house` · `prov-click2ring` · `prov-redes-2-benavides` · `prov-en-casa-g` |
| Página | `pagina-naturales-bio-corp` · `pagina-bio-natural` · `pagina-bionatural-fuerza` · `pagina-bionatural-testosterona` · `pagina-bionatural-diabetes` |
| Producto | mismas que Palacios |

### ROOSEVELT

| Familia | Etiquetas |
| :--- | :--- |
| Canal | `canal-messenger` · `canal-forms` · `canal-whatsapp` |
| Proveedor | `prov-in-house` |
| Página | `pagina-bio-naturales` · `pagina-bionatural-plus` · `pagina-bio-natural-salud` |
| Producto | las de siempre |

### PIURA

| Familia | Etiquetas |
| :--- | :--- |
| Canal | `canal-messenger` · `canal-forms` · `canal-whatsapp` |
| Proveedor | `prov-in-house` |
| Página | `pagina-natural-bio` · `pagina-bionatural` · `pagina-bionatural-piura-inhouse` |
| Producto | las de siempre |

---

## 3. Uso real medido (1.000 contactos auditados)

| Canal | Contactos | | Proveedor | Contactos |
| :--- | ---: | --- | :--- | ---: |
| `canal-messenger` | 956 | | `prov-ernesto` | 525 |
| `canal-fb-msgr` ⚠️ legado | 19 | | `prov-in-house` | 303 |
| `canal-forms` | 1 | | `prov-click2ring` | 142 |

| Página | Contactos | | Producto | Contactos |
| :--- | ---: | --- | :--- | ---: |
| `pagina-bio-naturales` | 294 | | `producto-potencia` | 667 |
| `pagina-naturales-bionatural` | 272 | | `producto-diabetes` | 256 |
| `pagina-naturales-bio-corp` | 237 | | `producto-desconocido` ⚠️ | 138 |
| `pagina-bio-natural` | 124 | | `producto-prostata` | 6 |
| `pagina-bionatural-ultra` | 18 | | `producto-gummies` | 2 |

---

## 4. Vistas listas para crear

### Vista 1 — Por proveedor (la que necesitás)
```
Etiqueta contiene: prov-ernesto
```
Cambiando la etiqueta se obtiene cada proveedor. **Es la vista que separa el trabajo de cada gestor de redes.**

### Vista 2 — Por canal
```
Etiqueta contiene: canal-messenger
   (agregar con "O": canal-fb-msgr   ← contactos viejos)
```

### Vista 3 — Proveedor + canal (la más limpia)
```
Etiqueta contiene: prov-ernesto
Y  Etiqueta contiene: canal-messenger
```

### Vista 4 — Por página
```
Etiqueta contiene: pagina-naturales-bionatural
```

### Vista 5 — Formularios sin dueño (Cola Forms)
```
Etiqueta contiene: canal-forms
Y  Etiqueta contiene: sin-telefono    (opcional)
```

### Vista 6 — Por producto
```
Etiqueta contiene: producto-diabetes
Y  Etiqueta contiene: canal-messenger
```

---

## 5. Advertencias antes de crear las vistas

| Punto | Detalle | Acción |
| :--- | :--- | :--- |
| `canal-fb-msgr` (19) | variante vieja de `canal-messenger` | al crear la vista de Messenger, incluirla con "O" |
| `canal-form` / `canal-fb-messenger` | variantes que existen pero ya no se escriben | ignorarlas o incluirlas si querés histórico completo |
| `producto-desconocido` (138 = 14%) | leads sin tratamiento identificado | la vista por producto tendrá ese hueco |
| Rutas `vtiger-*`, `vtiger-status-*` | legado de otro flujo | no usar para vistas de redes |
| `revisar-ruteo` | bajó de ~45% a ~2% tras la operación | vista de control de calidad |
| `sin-telefono` | ~50% de los chats nuevos | no sirve para llamadas; sí para Cola Forms |

---

## 6. Verificación rápida de que una etiqueta existe

```bash
node tools/inventario_etiquetas.mjs
```

Lista todas las etiquetas reales por subcuenta, agrupadas por familia.
