# 🎯 Vistas Inteligentes de Chat — Referencia Operativa

> **Sistema:** LOA Engine · Laboratorios Naturales
> **Actualizado:** Noviembre 2026
> **Propósito:** guía única para armar las Smart Views de chat en GoHighLevel (GHL) a partir de las etiquetas que inyecta el motor.

---

## 1. Las etiquetas que inyecta el motor

Cada lead de Meta lleva **una etiqueta activa por dimensión**. Cuando reingresa por otro canal/proveedor, las anteriores se **purgan automáticamente** (1 lead = 1 vista activa).

| Dimensión | Prefijo | Valores |
|---|---|---|
| **Canal / cola** | `cola-` | `cola-redes-1` · `cola-redes-2` · `cola-inhouse` · `cola-forms` · `cola-wsp` |
| **Proveedor** | `prov-` | `prov-ernesto` · `prov-click2ring` · `prov-in-house` |
| **Padecimiento** | `producto-` | `producto-potencia` · `producto-diabetes` · `producto-gastro` · `producto-artritis` · `producto-prostata` · `producto-colageno` · `producto-vision` · `producto-hongos` · `producto-gummies` |
| **Sede** | `sede-` | `sede-palacios` · `sede-benavides` · `sede-roosevelt` · `sede-piura` |
| **Formulario** | `form-id-` | `form-id-<id del form>` (solo leads de Lead Ads) |

> **Nota de nomenclatura:** el padecimiento usa el nombre canónico del CRM vTiger (`cf_2610`): "Testosterona" se etiqueta como `producto-potencia` (canónico de "Tetosterona").

---

## 2. Estructura recomendada de vistas (3 niveles)

### Nivel 1 — Simple (3 vistas, por proveedor)

| Vista | Filtro |
|---|---|
| Ernesto | `prov-ernesto` |
| Click2Ring | `prov-click2ring` |
| InHouse | `prov-in-house` |

### Nivel 2 — Operativo (6 vistas, por proveedor + canal) ⭐ recomendado

| Vista | Filtro |
|---|---|
| Redes 1 — Ernesto Messenger | `prov-ernesto` + `cola-redes-1` |
| Forms — Ernesto | `prov-ernesto` + `cola-forms` |
| Redes 2 — Click2Ring Messenger | `prov-click2ring` + `cola-redes-2` |
| InHouse Messenger | `prov-in-house` + `cola-inhouse` |
| Forms — InHouse | `prov-in-house` + `cola-forms` |
| WSP — InHouse | `prov-in-house` + `cola-wsp` |

### Nivel 3 — Fino (por padecimiento, para cruzar)

| Vista | Filtro |
|---|---|
| Testosterona | `producto-potencia` |
| Diabetes | `producto-diabetes` |
| Gastro | `producto-gastro` |

**Combinables** entre niveles. Ejemplos:
- *Forms InHouse de Diabetes* → `prov-in-house` + `cola-forms` + `producto-diabetes`
- *Messenger Ernesto Testo* → `prov-ernesto` + `cola-redes-1` + `producto-potencia`

---

## 3. Cómo crear cada vista en GHL (2 clics)

1. **Contactos → Smart List** (o la vista de conversaciones de chat).
2. Filtrar por **Tag → "contiene" (contains)** → pegar la etiqueta exacta.
3. Para combinar etiquetas: añadir **otra condición con "Y" (AND)**.

**Reglas de oro:**
- Usar **"contiene"**, no "es igual a".
- Escribir la etiqueta **exacta** (con guiones): `cola-redes-1`, no "Redes 1".
- Para Forms usar **AND** (`cola-forms` + `prov-*`), no solo `cola-forms`.

---

## 4. Regla de purga (por qué un lead no se duplica)

Cuando un lead **reingresa por otro canal/proveedor**, el motor:

1. **Elimina** la etiqueta anterior (`cola-*` y `prov-*` viejos).
2. **Agrega** la nueva.
3. Resultado: el lead **sale** de la vista vieja y **entra solo** en la nueva.

Ejemplo:
```
Messenger Ernesto (cola-redes-1 + prov-ernesto)
   ↓ reingresa por un formulario
Forms Ernesto (cola-forms + prov-ernesto)   ← se eliminó cola-redes-1
```

---

## 5. Resumen rápido para el equipo

| Necesidad | Filtro |
|---|---|
| Ver TODO lo de Ernesto | `prov-ernesto` |
| Ver TODO lo de InHouse | `prov-in-house` |
| Ver forms de InHouse Testo | `prov-in-house` + `cola-forms` + `producto-potencia` |
| Ver forms de InHouse Diabetes | `prov-in-house` + `cola-forms` + `producto-diabetes` |
| Ver WhatsApp InHouse | `prov-in-house` + `cola-wsp` |
| Ver solo Testosterona (todos) | `producto-potencia` |

---

*Documento generado a partir del estado verificado del sistema LOA Engine.*
