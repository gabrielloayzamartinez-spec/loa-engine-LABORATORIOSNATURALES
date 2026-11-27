# 📄 MAPEO OFICIAL DE PÁGINAS → ETIQUETAS (LOA ENGINE)

**Fuente única de verdad:** `src/config/page_matrix.js`
**Actualizado:** 19-nov-2026 · 12 páginas mapeadas al 100%

Cada página se identifica por su **ID de Facebook** y recibe etiquetas derivadas de su
**nombre de página** (identificable), su **proveedor** y su **cola/canal**. La etiqueta
`pagina-*` se deriva directamente del nombre de la página (minúsculas + guiones).

---

## PALACIOS — Location GHL `5NqOaPYqWyIw2FPBfoRg`

| Página | ID Facebook | Proveedor | Cola | Etiqueta `pagina-*` |
| :--- | :--- | :--- | :--- | :--- |
| Naturales BioNatural | `566501466542620` | ERNESTO | redes-1 | `pagina-naturales-bionatural` |
| Laboratorios Naturales BIO | `718150351371765` | IN_HOUSE (sin dueño) | forms | `pagina-laboratorios-naturales-bio` |
| BioNatural - Ultra | `111906554968800` | CLICK2RING | redes-2 | `pagina-bionatural-ultra` |
| BIO Vida Natural | `1087387677802467` | IN_HOUSE (sin dueño) | forms | `pagina-bio-vida-natural` |
| BioHealth Natural | `1422379957628845` | EN CASA G (sin dueño) | forms | `pagina-biohealth-natural` |
| BioNatural Salud | `1438600545996758` | IN_HOUSE (sin dueño) | forms | `pagina-bionatural-salud` |

## BENAVIDES — Location GHL `QXcNBK6XCgpQaZ81Z8pv`

| Página | ID Facebook | Proveedor | Cola | Etiqueta `pagina-*` |
| :--- | :--- | :--- | :--- | :--- |
| Naturales Bio Corp | `510617778807469` | ERNESTO | redes-1 | `pagina-naturales-bio-corp` |
| Bio Natural | `126154270581792` | CLICK2RING | redes-2 | `pagina-bio-natural` |
| BioNatural Fuerza | `1147742788423762` | REDES 2 BENAVIDES | redes-2 | `pagina-bionatural-fuerza` |

## ROOSEVELT — Location GHL `SETlaGKhBpbqfBSzzpIB`

| Página | ID Facebook | Proveedor | Cola | Etiqueta `pagina-*` |
| :--- | :--- | :--- | :--- | :--- |
| Bio Naturales | `568453466348355` | IN_HOUSE | inhouse | `pagina-bio-naturales` |
| BioNatural Plus | `1075001465705985` | IN_HOUSE | inhouse | `pagina-bionatural-plus` |
| Bio Natural Salud | `180536758476362` | IN_HOUSE | inhouse | `pagina-bio-natural-salud` |

## PIURA — Location GHL `9J4pKs5f7OcaokdhyurW`

| Página | ID Facebook | Proveedor | Cola | Etiqueta `pagina-*` |
| :--- | :--- | :--- | :--- | :--- |
| Natural Bio | `1147257965133802` | IN_HOUSE | inhouse | `pagina-natural-bio` |
| BioNatural | `1057863707412893` | IN_HOUSE | inhouse | `pagina-bionatural` |

---

## 🏷️ Regla de etiquetas por cada página

Cada lead que entra por una página recibe **estas etiquetas** (contrato único, `src/domain/ghl_tags.js`):

| Etiqueta | Origen | Ejemplo |
| :--- | :--- | :--- |
| `pagina-<nombre>` | Nombre de la página (identificable) | `pagina-naturales-bio-corp` |
| `prov-<proveedor>` | Proveedor | `prov-ernesto` |
| `canal-<canal>` | Canal real de entrada (UNA sola) | `canal-messenger`, `canal-forms`, `canal-whatsapp` |
| `sede-<sede>` | Sede | `sede-benavides` |
| `producto-<padecimiento>` | Padecimiento (si aplica) | `producto-diabetes` |

**Proveedores válidos:** `prov-ernesto`, `prov-click2ring`, `prov-in-house`, `prov-redes-2-benavides`, `prov-en-casa-g`, `prov-enzo`, `prov-up-ideas`
**Canales válidos:** `canal-messenger`, `canal-forms`, `canal-whatsapp`, `canal-sms`, `canal-tiktok`, `canal-instagram`
**Sedes válidas:** `sede-palacios`, `sede-benavides`, `sede-roosevelt`, `sede-piura`

> ⚠️ **CORRECCIÓN DE AUDITORÍA (27-nov-2026).** Este documento listaba `cola-<canal>`
> (`cola-redes-1`, `cola-redes-2`, `cola-forms`, `cola-inhouse`, `cola-wsp`) como una de
> las 4 etiquetas estándar. **El router ya no las escribe**: quedaron como etiquetas
> LEGADAS y el Nivel 2 las retira. No construir Smart Views sobre `cola-*`.
> Tampoco son válidas `vtiger`, `vtiger-sincronizado` ni `vtiger-status-*`: el motor las
> purga. Detalle completo: [`AUDITORIA_N1_N2_CF_ETIQUETAS.md`](./AUDITORIA_N1_N2_CF_ETIQUETAS.md).

---

## 🔄 Comportamiento "último canal"

Si un lead salta de una página a otra, las etiquetas se **purgan** para reflejar solo la
**última página/canal** por el que escribió (la vista de chat muestra dónde está AHORA).

*Documento de referencia para crear las Smart Views en GHL.*
