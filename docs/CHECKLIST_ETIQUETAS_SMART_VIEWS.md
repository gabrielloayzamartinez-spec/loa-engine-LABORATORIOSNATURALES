# Checklist de Etiquetas y Smart Views — Replicación Palacios → demás subcuentas

> El motor ya inyecta las etiquetas automáticamente y de forma **idéntica en las 4
> subcuentas** (Palacios, Benavides, Roosevelt, Piura). Lo único que se replica a mano
> en cada subcuenta GHL son las **Smart Views** (listas filtradas por esas etiquetas).
> Este documento es la fuente para replicar la efectividad de Palacios.

---

## 1. Etiquetas que inyecta el motor (automático, no hay que crearlas)

### De cola y sede (Smart Views operativas)
- `sede-palacios` · `sede-benavides` · `sede-roosevelt` · `sede-piura`
- `cola-redes-1` · `cola-redes-2` · `cola-inhouse` · `cola-forms`

### De producto / padecimiento (canónico)
- `producto-potencia` (testosterona) · `producto-diabetes` · `producto-artritis`
- `producto-prostata` · `producto-colageno` · `producto-vision`
- `producto-gastro` · `producto-hongos` · `producto-gummies`

### De estado comercial y contacto
- `facebook-messenger` · `meta-ads`
- `con-telefono` · `sin-telefono` · `lead-caliente`
- `compro` · `no-compro` · `cliente-vtiger` · `prospecto-vtiger`
- `alerta-duplicado-clic` · `pauta-clic-xN`
- `doble-ingreso-publicitario` · `alerta-reingreso-pauta`
- `revisar-ruteo`
- `form-id-<id>` (formularios de Lead Ads)

---

## 2. Mapa página → etiquetas (fuente única: `PAGE_MATRIX`)

| Sede | Página | Proveedor | Etiquetas de cola/sede |
|------|--------|-----------|------------------------|
| PALACIOS | Naturales BioNatural (566501466542620) | ERNESTO | `sede-palacios` + `cola-redes-1` |
| PALACIOS | Laboratorios Naturales BIO (718150351371765) | IN_HOUSE (sin dueño) | `sede-palacios` + `cola-forms` |
| PALACIOS | BioNatural - Ultra (111906554968800) | CLICK2RING | `sede-palacios` + `cola-redes-2` |
| BENAVIDES | Naturales Bio Corp (510617778807469) | ERNESTO | `sede-benavides` + `cola-redes-1` |
| BENAVIDES | Bio Natural (126154270581792) | CLICK2RING | `sede-benavides` + `cola-redes-2` |
| BENAVIDES | BioNatural Fuerza (1147742788423762) | REDES 2 | `sede-benavides` + `cola-redes-2` |
| ROOSEVELT | Bio Naturales (568453466348355) | IN_HOUSE | `sede-roosevelt` + `cola-inhouse` |
| ROOSEVELT | BioNatural Plus (1075001465705985) | IN_HOUSE | `sede-roosevelt` + `cola-inhouse` |
| PIURA | Natural Bio (1147257965133802) | IN_HOUSE | `sede-piura` + `cola-inhouse` |
| PIURA | BioNatural (1057863707412893) | IN_HOUSE | `sede-piura` + `cola-inhouse` |

---

## 3. Smart Views recomendadas (a crear en cada subcuenta GHL)

> En GHL: **Contacts → Smart Lists (Smart Views) → Nueva lista**, con filtro `Tag contains <etiqueta>`.

| # | Smart View | Filtro (tag) | Nota |
|---|-----------|--------------|------|
| 1 | Cola Redes 1 | `cola-redes-1` | Bandeja de Ernesto / Redes 1 |
| 2 | Cola Redes 2 | `cola-redes-2` | Bandeja de Click2Ring / Redes 2 |
| 3 | Cola Forms | `cola-forms` | Formularios (sin dueño) |
| 4 | Cola In-House | `cola-inhouse` | Solo Roosevelt / Piura |
| 5 | Lead Caliente | `lead-caliente` | Con teléfono o dirección |
| 6 | Con Teléfono | `con-telefono` | Listo para llamar |
| 7 | Sin Teléfono | `sin-telefono` | Falta capturar número |
| 8 | Compradores | `compro` | Venta cerrada |
| 9 | Cliente vTiger | `cliente-vtiger` | Comprador histórico |
| 10 | Revisar Ruteo | `revisar-ruteo` | Delegaciones no confirmadas (auditar) |
| 11 | Diabetes | `producto-diabetes` | Producto (opcional) |
| 12 | Potencia | `producto-potencia` | Producto (opcional) |

> **Importante:** la Smart View por sede (`sede-palacios`, `sede-benavides`, …) suele ser
> **redundante** porque cada subcuenta ya es soberana (los contactos ya están separados
> por location). Se usa `cola-*` para las bandejas de trabajo de los asesores.

---

## 4. Pasos de replicación (por subcuenta GHL)

1. Entrar a la subcuenta destino (Benavides / Roosevelt / Piura).
2. Crear las **Smart Views** de la sección 3 con el mismo nombre y filtro que Palacios.
3. Verificar que los **asesores** (usuarios de GHL) existan con el mismo rol:
   - Benavides: `REDES 1 BENAVIDES`, `REDES 2 BENAVIDES`.
   - Roosevelt: `REDES ROOSEVELT BIONATURAL`.
   - Piura: `REDES PIURA BIONATURAL`.
4. Confirmar que los **custom fields** existan (el motor ahora los resuelve dinámicamente
   por nombre para Roosevelt/Piura; si falta alguno, se omite sin romper).
5. Probar con un lead real: debe llegar etiquetado con `sede-*`, `cola-*` y `producto-*`.

---

*Generado por LOA Engine — 28/10/2026. La asignación de etiquetas es automática; solo las
Smart Views se replican manualmente en GHL.*
