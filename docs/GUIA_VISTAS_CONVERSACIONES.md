# 💬 GUÍA — Vistas de CONVERSACIONES (por etiqueta)

**Objetivo:** organizar el trabajo del personal de redes en el inbox de Conversaciones,
filtrando por etiquetas (canal + proveedor + padecimiento).

---

## 1. Etiquetas disponibles (para conversaciones)

| Tipo | Etiquetas |
| :--- | :--- |
| Canal | `canal-messenger`, `canal-forms`, `canal-whatsapp`, `canal-sms`, `canal-instagram` |
| Proveedor | `prov-ernesto`, `prov-click2ring`, `prov-in-house`, `prov-redes-2-benavides`, `prov-en-casa-g`, `prov-enzo`, `prov-up-ideas` |
| Padecimiento | `producto-artritis`, `producto-diabetes`, `producto-gastro`, `producto-potencia`, `producto-colageno`, `producto-vision`, `producto-hongos`, `producto-gummies` |
| Página | `pagina-<nombre>` (ver `PAGINAS_ETIQUETAS.md`) |
| Sede | `sede-palacios`, `sede-benavides`, `sede-roosevelt`, `sede-piura` |

---

## 2. Vistas de Conversaciones por sede

### PALACIOS
| Vista | Filtro |
| :--- | :--- |
| Messenger – Ernesto | `canal-messenger` + `prov-ernesto` |
| Messenger – Click2Ring | `canal-messenger` + `prov-click2ring` |
| Forms – Diabetes | `canal-forms` + `producto-diabetes` |
| Forms – Gastro | `canal-forms` + `producto-gastro` |
| Forms – Testosterona | `canal-forms` + `producto-potencia` |
| Forms – EN CASA G (Gastro) | `canal-forms` + `prov-en-casa-g` |
| WhatsApp | `canal-whatsapp` |

### BENAVIDES
| Vista | Filtro |
| :--- | :--- |
| Messenger – Redes 1 (Ernesto) | `canal-messenger` + `prov-ernesto` |
| Messenger – Redes 2 (Click2Ring) | `canal-messenger` + `prov-click2ring` |
| Forms – Diabetes | `canal-forms` + `producto-diabetes` |
| Forms – Testosterona | `canal-forms` + `producto-potencia` |
| Forms – Artritis | `canal-forms` + `producto-artritis` |
| WhatsApp | `canal-whatsapp` |

### ROOSEVELT
| Vista | Filtro |
| :--- | :--- |
| Messenger | `canal-messenger` + `sede-roosevelt` |
| Forms | `canal-forms` + `sede-roosevelt` |
| WhatsApp | `canal-whatsapp` + `sede-roosevelt` |

### PIURA
| Vista | Filtro |
| :--- | :--- |
| Messenger | `canal-messenger` + `sede-piura` |
| Forms | `canal-forms` + `sede-piura` |
| WhatsApp | `canal-whatsapp` + `sede-piura` |

---

## 3. Cómo crear cada vista

1. **Conversaciones** → filtro de **Tags (Etiquetas)**.
2. Selecciona la etiqueta (ej. `canal-forms` + `prov-ernesto`).
3. **Guardar vista** con el nombre (ej. "Forms – Diabetes").
4. Repite para cada vista.

---

## 4. Reglas

- **Canal** y **proveedor** son independientes: combina con `+` (AND).
- Al saltar de canal/página, las etiquetas se purgan para reflejar el **último** canal.
- Los leads nuevos llegan con `canal-*`; los viejos pueden tener `cola-*` (etiqueta antigua) hasta que re-ingresen.
