# 🗂️ GUÍA — Smart Views en GHL (taxonomía limpia)

**Objetivo:** trabajo por ETIQUETAS con 5 dimensiones limpias y separadas:
**Canal** (cómo), **Proveedor** (quién), **Padecimiento** (qué), **Página** (cuál), **Sede** (dónde).

---

## 1. Etiquetas disponibles

| Tipo | Etiquetas |
| :--- | :--- |
| Canal | `canal-messenger`, `canal-forms`, `canal-whatsapp`, `canal-sms`, `canal-instagram` |
| Proveedor | `prov-ernesto`, `prov-click2ring`, `prov-in-house`, `prov-redes-2-benavides`, `prov-en-casa-g`, `prov-enzo`, `prov-up-ideas` |
| Padecimiento | `producto-artritis`, `producto-diabetes`, `producto-gastro`, `producto-gummies`, `producto-testosterona` |
| Página | `pagina-<nombre>` (14 páginas — ver `PAGINAS_ETIQUETAS.md`) |
| Sede | `sede-palacios`, `sede-benavides`, `sede-roosevelt`, `sede-piura` |

---

## 2. Vistas recomendadas

### Nivel 1 — Canal (5 vistas)
| Vista | Filtro |
| :--- | :--- |
| Canal Messenger | `canal-messenger` |
| Canal Forms | `canal-forms` |
| Canal WhatsApp | `canal-whatsapp` |
| Canal SMS | `canal-sms` |
| Canal Instagram | `canal-instagram` |

### Nivel 2 — Proveedor (las que operes)
| Vista | Filtro |
| :--- | :--- |
| Proveedor Ernesto | `prov-ernesto` |
| Proveedor Click2Ring | `prov-click2ring` |
| Proveedor In-House | `prov-in-house` |
| Proveedor EN CASA G | `prov-en-casa-g` |

### Nivel 3 — Padecimiento (combinar con canal)
| Vista | Filtro |
| :--- | :--- |
| Forms Diabetes | `canal-forms` AND `producto-diabetes` |
| Forms Gastro | `canal-forms` AND `producto-gastro` |
| Forms Testosterona | `canal-forms` AND `producto-testosterona` |

### Nivel 4 — Página (opcional, 14 páginas)
| Vista | Filtro |
| :--- | :--- |
| Naturales Bio Corp | `pagina-naturales-bio-corp` |
| … | `pagina-<nombre>` |

---

## 3. Pasos en GHL

1. **Contacts** → ícono de **filtro / Smart List**.
2. **+ Nueva Vista**.
3. **Nombre** (ej. `Canal Messenger`).
4. **Filtro:** Tags → **contiene** → `canal-messenger`.
5. Para 2 etiquetas: 2 condiciones con **AND**.
6. **Guardar**.

---

## 4. Reglas

- **Proveedor** y **canal** son independientes: un lead puede ser `prov-en-casa-g` + `canal-sms`.
- Al saltar de página/canal, las etiquetas se purgan para reflejar el **ÚLTIMO canal**.
- Las vistas combinan dimensiones con **AND** (ej. Forms + Diabetes).
