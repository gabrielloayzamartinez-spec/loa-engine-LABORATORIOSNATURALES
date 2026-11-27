# OPERACIÓN LOCAL + VISTAS DE GHL

**Fecha:** 27-nov-2026 · Estado: **4 runners N2 + radar N1 corriendo en local** (Render apagado)

---

## 1. Las vistas (contrato: solo `prov-*` y `pagina-*`)

En GHL: **Conversaciones → Filtros → Etiquetas**. Se combinan con **Y / O**.

### 1.1 Por proveedor (4 vistas — el reparto de trabajo)

| Vista | Filtro |
| :--- | :--- |
| REDES 1 · Ernesto | `prov-ernesto` |
| IN-HOUSE | `prov-in-house` |
| CLICK2RING | `prov-click2ring` |
| EN CASA G | `prov-en-casa-g` |

### 1.2 Por iniciativa (página) — una vista por página

| Sede | Página | Filtro | Iniciativa |
| :--- | :--- | :--- | :--- |
| Palacios | Naturales BioNatural | `pagina-naturales-bionatural` | Messenger |
| Palacios | Laboratorios Naturales BIO | `pagina-laboratorios-naturales-bio` | Formularios |
| Palacios | BioNatural Salud | `pagina-bionatural-salud` | Formularios |
| Palacios | BIO Vida Natural | `pagina-bio-vida-natural` | Formularios |
| Palacios | BioNatural - Ultra | `pagina-bionatural-ultra` | (por definir) |
| Palacios | BioHealth Natural | `pagina-biohealth-natural` | (por definir) |
| Benavides | Naturales Bio Corp | `pagina-naturales-bio-corp` | Messenger |
| Benavides | Bio Natural | `pagina-bio-natural` | Messenger |
| Benavides | BioNatural Fuerza | `pagina-bionatural-fuerza` | Formularios |
| Benavides | BioNatural Testosterona | `pagina-bionatural-testosterona` | (por definir) |
| Benavides | BioNatural Diabetes | `pagina-bionatural-diabetes` | (por definir) |
| Roosevelt | Bio Naturales | `pagina-bio-naturales` | Messenger |
| Roosevelt | BioNatural Plus | `pagina-bionatural-plus` | (por definir) |
| Roosevelt | Bio Natural Salud | `pagina-bio-natural-salud` | (por definir) |
| Piura | Natural Bio | `pagina-natural-bio` | (por definir) |
| Piura | BioNatural | `pagina-bionatural` | (por definir) |
| Piura | BioNatural Piura Inhouse | `pagina-bionatural-piura-inhouse` | (por definir) |

### 1.3 Iniciativa + proveedor (la vista más fina)

```
Etiqueta contiene: pagina-laboratorios-naturales-bio
Y  Etiqueta contiene: prov-in-house
```

### 1.4 Formularios (los que NO tienen conversación)

Los forms no aparecen en una vista de chats. Para verlos: **Contactos → filtro por campo**:

```
Canal Captación = FORM
Y  Sede Asignada = PALACIOS
```

### 1.5 Vista de CONTROL (para detectar huecos)

```
Contactos SIN la etiqueta prov-ernesto / prov-in-house / prov-click2ring / prov-en-casa-g
```

Esa vista debe tender a cero. Es el semáforo de que el N1 está al día.

---

## 2. Los procesos que corren en local

| Proceso | Qué hace | Frecuencia | Comando |
| :--- | :--- | :--- | :--- |
| **Radar N1** | etiqueta los contactos nuevos (prov + pagina) | 45 s | `node tools/radar_n1_local.mjs --intervalo=45` |
| **Runner N2 ×4** | sincroniza los CF desde vTiger, por sede | continuo | ver abajo |
| **Control** | pausa / reanuda todo | a demanda | `pausar_trabajos.bat` |

### Arranque completo (4 terminales o `lanzar_runners.bat`)

```bash
node tools/radar_n1_local.mjs --intervalo=45
node tools/runner_n2.mjs --solo=PALACIOS  --limite=40 --rate=6 --concurrencia=4
node tools/runner_n2.mjs --solo=BENAVIDES --limite=40 --rate=6 --concurrencia=4
node tools/runner_n2.mjs --solo=ROOSEVELT --tipo=contactos --limite=40 --rate=6 --concurrencia=4
node tools/runner_n2.mjs --solo=PIURA     --tipo=contactos --limite=40 --rate=6 --concurrencia=4
```

### Ver progreso

```bash
node tools/runner_control.mjs estado
type scratch\runner_n2_PALACIOS.json
type logs\radar_n1.log
```

---

## 3. Rutina diaria (5 minutos)

| Paso | Comando | Qué mirar |
| :--- | :--- | :--- |
| 1. Encender | `lanzar_runners.bat` | que arranquen los 4 |
| 2. Verificar etiquetado | `node tools/lab_n1.mjs --sede=PALACIOS --muestra=10` | `revisar=0`, `sinCanal=0` |
| 3. Limpiar basura nueva | `node tools/limpiar_etiquetas.mjs --sede=PALACIOS --paginas=2` | simulación: debe dar casi cero |
| 4. Cobertura de CF | `node tools/local_sync.mjs cobertura --sede=PALACIOS --muestra=10` | Fecha Creación ≥95% |
| 5. Pausar al salir | `pausar_trabajos.bat` | los procesos quedan dormidos |

---

## 4. Cómo se reparte la gestión (lo que pediste)

Cada **iniciativa** = una página + un canal. La vista se crea con la etiqueta de página, y el proveedor dice quién la trabaja:

| Sede | Iniciativas activas | Quién gestiona |
| :--- | ---: | :--- |
| Palacios | 6 páginas (2 Messenger, 3 Forms, 1 por definir) | Ernesto · In-House · Click2Ring · En Casa G |
| Benavides | 5 páginas (2 Messenger, 1 Form, 2 por definir) | Ernesto · Click2Ring · In-House |
| Roosevelt | 3 páginas (1 Messenger, 2 por definir) | In-House |
| Piura | 3 páginas (por definir) | In-House |

Con esto el equipo puede tomar **una iniciativa por persona** sin pisarse: la vista filtra por página y el proveedor ya está en la etiqueta.

---

## 5. Pendientes para cerrar la operación

| # | Pendiente | Impacto |
| :--- | :--- | :--- |
| 1 | Canal de las **10 páginas** sin medición | sin eso, sus leads de formulario no se distinguen |
| 2 | Decidir si se agrega la etiqueta `form` | ver formularios dentro de la vista de chats |
| 3 | Desplegar a Render | que el N1 corra 24/7 sin tu máquina |
| 4 | Revisar que la vista de CONTROL tienda a cero | validar que no quedan contactos sin proveedor |
