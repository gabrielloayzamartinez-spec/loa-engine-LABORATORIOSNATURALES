# TAXONOMÍA FINAL DE ETIQUETAS — OPERACIÓN LIMPIA

**Decisión:** 27-nov-2026 · **Principio:** una etiqueta existe solo si responde **quién** o **dónde**.

---

## 1. La regla que ordena todo

> **Una etiqueta se crea solo desde la matriz de páginas.** Si no está en la matriz, es basura y se borra.

Eso convierte el etiquetado en algo **predecible**: no hay etiquetas inventadas por un asesor, por un workflow viejo o por un script. Si mañana entra una página nueva, se agrega a la matriz y su etiqueta queda autorizada; hasta entonces, cualquier `pagina-*` que no exista ahí se considera ruido.

---

## 2. Las 2 familias (y nada más)

| Familia | Responde | Cuántas por sede | Para qué sirve |
| :--- | :--- | ---: | :--- |
| `prov-<proveedor>` | **quién** trae el lead | 2 – 5 | vista por equipo/proveedor |
| `pagina-<página>` | **dónde** cayó (iniciativa) | 3 – 6 | vista por iniciativa |

**Total operativo: 9 a 13 etiquetas por sede.** Eso es todo lo que el equipo necesita para trabajar.

### Palacios (ejemplo real)

| Tag | Significado | Iniciativa |
|---|---|---|
| `prov-ernesto` | Ernesto | — |
| `prov-in-house` | In-House | — |
| `prov-click2ring` | Click2Ring | — |
| `prov-en-casa-g` | En Casa G | — |
| `pagina-naturales-bionatural` | Naturales BioNatural | Messenger |
| `pagina-laboratorios-naturales-bio` | Laboratorios Naturales BIO | Formularios |
| `pagina-bionatural-salud` | BioNatural Salud | Formularios |
| `pagina-bionatural-ultra` | BioNatural - Ultra | por definir |
| `pagina-biohealth-natural` | BioHealth Natural | por definir |

---

## 3. Lo que NO es etiqueta (y dónde vive)

| Dato | Antes (etiqueta) | Ahora (campo nativo) |
| :--- | :--- | :--- |
| Canal | `canal-messenger`, `canal-forms` | **último mensaje** de GHL + `Canal Captación` |
| Producto | `producto-diabetes` | `Tratamiento comprado` |
| Sede | `sede-palacios` | la subcuenta misma + `Sede Asignada` |
| Estado | `compro`, `prospecto-vtiger` | `Estado de Compra` |
| Urgencia | `lead-caliente` | **ANS real** (minutos de espera) |
| Formulario | `form`, `form-id-*` | `Canal Captación = FORM` + `id form clipo` |
| Fecha | — | `Fecha Creación (Fecha)` |

Todo eso ya existe como campo. Etiquetarlo era duplicar el dato y crear las variantes que ensuciaron las vistas.

---

## 4. Marcadores internos (no son del equipo)

Quedan **3** y son invisibles para las vistas:

| Tag | Quién lo usa | Puede pasar a campo? |
| :--- | :--- | :--- |
| `alerta-reingreso-pauta` | `ad_attribution_engine`, `master_processor` | sí, más adelante |
| `doble-ingreso-publicitario` | `master_processor` | sí, más adelante |
| `alerta-duplicado-clic` / `alerta-duplicado-crm` | router | sí, más adelante |

Mientras el motor los lea como etiqueta, se conservan. No se usan para construir vistas.

---

## 5. Estado de la limpieza

| Sede | Etiquetas hoy | Conservar | Basura a borrar |
| :--- | ---: | ---: | ---: |
| Palacios | 87 | 13 | **68** |
| Benavides | 82 | 10 | **68** |
| Roosevelt | 63 | 8 | **53** |
| Piura | 59 | 7 | **50** |
| **Total** | 291 | 38 | **239** |

**Cómo se borra:** desde la configuración de la subcuenta (Ajustes → Etiquetas), **una operación por etiqueta**. Al borrar la definición, desaparece de todos los contactos: no hay que tocar 480.000 fichas.

```bash
node tools/clasificar_etiquetas.mjs --sede=PALACIOS          # ver la lista
node tools/clasificar_etiquetas.mjs --sede=PALACIOS --borrar # ejecutar
```

---

## 6. Cómo queda la operación

| Aspecto | Antes | Ahora |
| :--- | :--- | :--- |
| Etiquetas por contacto | 6 – 10 (con variantes) | **1 proveedor + 1 página** |
| Vistas de chat | parpadeaban | estables |
| Etiqueta inventada | posible | imposible (no está en la matriz) |
| Limpieza | ficha por ficha | **definición** (1 clic) |
| Urgencia | criterio del asesor | **ANS medido** |
| Costo de mantener | alto | casi cero |

---

## 7. Para operar mañana

1. Borrar las **239** etiquetas basura (4 comandos).
2. Confirmar las 5 páginas con iniciativa "por definir" (Messenger vs Formularios).
3. Desplegar el webhook → etiquetado en ~3 s, sin radar.
4. Vista única del equipo: `prov-*` + `pagina-*`.
