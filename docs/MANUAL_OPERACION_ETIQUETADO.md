# MANUAL DE OPERACIÓN DEL ETIQUETADO

**Sistema:** LOA Engine · **Niveles:** N1 (hoy) · N2 (histórico) · N3 (cambios)
**Regla de oro:** cada contacto lleva **1 etiqueta de proveedor y 1 de página**. Nada más.

---

## 1. Las dos preguntas que responde una etiqueta

| Pregunta | Etiqueta | De dónde sale |
| :--- | :--- | :--- |
| **¿Quién** trae al lead? | `prov-<proveedor>` | de la **página** (matriz). Si la campaña/anuncio lo resuelve antes, ese manda |
| **¿Dónde** cayó? | `pagina-<página>` | del `pageId` del **último mensaje**; si no hay mensaje, de la etiqueta previa; si no, de la matriz (formularios) |

Todo lo demás (canal, producto, sede, estado, urgencia, formulario) **no es etiqueta**: vive en un campo.

---

## 2. Quién escribe qué

| Nivel | Cuándo | Qué escribe |
| :--- | :--- | :--- |
| **N1** | hoy, en vivo (webhook) | `prov-*` + `pagina-*` de los chats y formularios del día |
| **N2** | histórico hasta ayer | campos del contacto (CF) y `prov-*` de los leads de vTiger |
| **N3** | cada cambio en vTiger | re-publica los CF del contacto cambiado |

---

## 3. El flujo, paso a paso

```
1. Llega el mensaje (Meta / formulario / GHL)
        ↓
2. ¿Hay evidencia Meta? ── no ──►  se reintenta (la conversación puede no estar indexada)
        │ sí
        ↓
3. Resolver PÁGINA  →  pageId del último mensaje
        │               si no hay → etiqueta `pagina-*` previa
        │               si no hay → matriz (página de formulario)
        ↓
4. Resolver PROVEEDOR  →  campaña/anuncio (si existe)  →  si no, el de la página
        ↓
5. ¿Es formulario?  →  sí: va a Cola Forms (no se asigna a una persona)
        ↓
6. Aplicar CONTRATO: se quedan solo `prov-*` y `pagina-*`; el resto se retira
        ↓
7. PUT al contacto (1 sola llamada)
```

---

## 4. Reglas de decisión (qué hacer en cada caso)

| Caso | Qué se coloca | Qué NO se hace |
| :--- | :--- | :--- |
| Chat de Messenger de una página conocida | `prov-<página>` + `pagina-<slug>` | no se toca el canal |
| Lead de **formulario** | `prov-<página>` + `pagina-<slug>` | no se asigna dueño; va a Cola Forms |
| **WhatsApp / SMS** | `prov-*` (de vTiger o de la campaña) | **no** se pone `pagina-*` (no viene de una fanpage) |
| Contacto **sin teléfono** | igual se etiqueta | no se espera al teléfono |
| **Sin conversación indexada** | se **reintenta** hasta 6 veces | no se etiqueta a ciegas ni se cierra el caso |
| Página **no mapeada** en la matriz | se etiqueta con lo que haya | no se inventa un proveedor |
| **Cambia de página** | se **intercambia** proveedor y página | no se acumulan dos `prov-*` |
| Lead que ya existe en vTiger | se cruza por teléfono y se llenan sus CF | no se crea nada en vTiger |
| Número **nuevo** que no está en vTiger | no se hace nada en el CRM | no se inventa ficha |

---

## 5. Ciclo de vida de una etiqueta

| Evento | Resultado |
| :--- | :--- |
| El lead escribe por primera vez | se crean `prov-*` y `pagina-*` |
| El lead vuelve por **otra** página | se **reemplaza** la anterior (queda solo la más reciente) |
| Cambia el proveedor de la página | se reemplaza `prov-*` |
| Cualquier otra etiqueta aparece | se **retira** en el siguiente ruteo |
| Página nueva en el negocio | se agrega a la **matriz** → su etiqueta queda autorizada |

---

## 6. Lo que NUNCA se hace

| Prohibido | Por qué |
| :--- | :--- |
| Inventar `prov-*` con un nombre que no está en la matriz | rompe las vistas |
| Acumular dos proveedores o dos páginas | la vista se duplica |
| Etiquetar canal / producto / sede / estado | ya existe como campo |
| Etiquetar sin evidencia de Meta | se marca para revisión o se reintenta |
| Escribir en vTiger | vTiger es solo lectura |

---

## 7. Campos que reemplazan a las etiquetas eliminadas

| Dato | Campo | Quién lo llena |
| :--- | :--- | :--- |
| Canal | `Canal Captación` | N1 y N2 |
| Producto | `Tratamiento comprado` | N2 |
| Sede | `Sede Asignada` | ambos |
| Estado | `Estado de Compra` | N2 |
| Formulario | `id form clipo` | N1 |
| Fecha de alta | `Fecha Creación (Fecha)` | N2 |
| Urgencia | **ANS** (minutos de espera) | se calcula, no se etiqueta |

---

## 8. Control de calidad (lo que hay que mirar)

| Métrica | Dónde | Objetivo |
| :--- | :--- | ---: |
| Contactos **sin** `prov-*` | vista de control en GHL | 0 |
| Contactos con **2** proveedores | auditoría | 0 |
| Cobertura de página | `lab_n1.mjs` | ≥ 95% |
| Demora de etiquetado | radar (log) | ≤ 60 s con webhook |
| ANS vencido | `vista_general --ans=10` | lo que decida el equipo |

---

## 9. Las 26 etiquetas autorizadas

| Sede | Proveedores | Páginas | Total |
| :--- | ---: | ---: | ---: |
| Palacios | 4 | 6 | 10 |
| Benavides | 3 | 5 | 8 |
| Roosevelt | 1 | 3 | 4 |
| Piura | 1 | 3 | 4 |
| **Total** | **9** | **17** | **26** |

Más **4 marcadores internos** que usa el motor y el equipo nunca ve:
`alerta-reingreso-pauta` · `doble-ingreso-publicitario` · `alerta-duplicado-clic` · `alerta-duplicado-crm`

---

## 10. Cómo se mantiene limpio

1. La **matriz** es la única fuente: página → sede, proveedor, iniciativa.
2. Cualquier etiqueta que no esté en la matriz se retira en el siguiente ruteo.
3. Las definiciones que GHL deja borrar se eliminan desde **Ajustes → Etiquetas**.
4. Las que están en uso (GHL responde 409) desaparecen solas cuando los runners limpian las fichas.
