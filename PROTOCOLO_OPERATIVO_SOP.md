# 📜 PROTOCOLO OPERATIVO ESTÁNDAR (SOP)
## LOA Engine — Laboratorios Naturales
### Estándares Obligatorios de Arquitectura, Inferencia y Despliegue en GoHighLevel

---

## 1. 🔍 Auditoría de Procesos: Lecciones Aprendidas y Causas Raíz

Para evitar que los errores históricos vuelvan a repetirse, este protocolo documenta los fallos detectados y sus soluciones mandatorias:

| Error Histórico Detectado | Causa Raíz Técnica | Solución Protocolar Blindada |
| :--- | :--- | :--- |
| **Falsos Artritis en Leads de Potencia / Colágeno** | El diccionario de Artritis contenía `'muestra gratis'` y `'colageno'`, asignando puntos a Artritis ante cualquier saludo. | **Regla de Oro 1:** Prohibición estricta de palabras de cortesía o promocionales en diccionarios clínicos. Ponderación directa de 10 puntos para títulos publicitarios (`MUESTRA GRATIS POTENCIA` ➡️ 10 pts a Potencia). |
| **Falso Tráfico Orgánico `IN_HOUSE`** | Si el número de Ad ID no llegaba en los primeros milisegundos, el motor degradaba el contacto a `IN_HOUSE`. | **Regla de Oro 2:** Si el lead tiene etiqueta `meta-ads`, `Paid Social` o proviene de Facebook, se clasifica como **`CLICK2RING`** sin excepción. |
| **Fuentes Truncadas (ej: `-Ar`)** | El generador de fuentes admitía abreviaturas de 2 letras de estados (como `AR` de Arkansas) si el tratamiento venía vacío. | **Regla de Oro 3:** Validación estricta de longitud en `buildVtigerSource`: si el tratamiento tiene `<= 2` caracteres, se reemplaza automáticamente por `General`. |
| **Etiquetas Dobles / Cruzadas** | El sistema acumulaba etiquetas nuevas sin remover las incompatibles (`producto-artritis` + `producto-potencia`). | **Regla de Oro 4 (Poda Activa):** Al determinarse el producto real, se purgan automáticamente las etiquetas de otros productos médicos incompatibles. |
| **Saltos de Pantalla y Pérdida de Texto en Asesores** | Consultas en bucle emitían peticiones `PUT` cada 20 segundos mientras el asesor estaba digitando en GHL. | **Regla de Oro 5 (Escudo UX 15 Minutos):** Bloqueo total de modificaciones por API si hubo interacción en los últimos 15 minutos. Cero parpadeos para el asesor. |
| **Servidor Corriendo Código Desactualizado en RAM** | Se modificaban archivos en disco, pero el proceso en la consola CMD no se reiniciaba, manteniendo la lógica vieja en RAM. | **Regla de Oro 6 (Pre-Flight Sanity Check):** Al iniciar, el servidor corre automáticamente una batería de 6 pruebas unitarias. Si una falla, el servidor se rehúsa a iniciar. |

---

## 2. 🛡️ Las 5 Reglas de Oro Protocolares

### Protocolo 1: Inferencia Clínica y de Pauta (Freshness First)
1. **Prioridad 1 (Título Directo):** Expresiones directas como `"MUESTRA GRATIS POTENCIA"` otorgan 10 puntos al producto correspondiente.
2. **Prioridad 2 (Síntomas Clínicos en Chat):** Palabras como rodillas, cartílago o articulaciones asignan Artritis; azúcar, glucosa o sed asignan Diabetes; vigor o erección asignan Potencia.
3. **Prioridad 3 (UTM / Campaña de Meta):** Si el chat solo dice *"Muestra gratis"* sin síntomas, se extrae obligatoriamente el producto del campo `attributionSource.utmMedium` o `utmCampaign` (ej: `DOMINGOS - COLÁGENO...` ➡️ `Colageno`).
4. **Fallback Seguro:** Si no hay síntomas ni pauta identificable, se asigna `General`. **Jamás se asigna Artritis por omisión.**

---

### Protocolo 2: Atribución de Fuente de Contacto
Formato universal obligatorio:
```text
[SEDE]-[PROVEEDOR]-[CANAL]-[TRATAMIENTO]
```
* **SEDE:** Mapeada exclusivamente por la Fanpage de entrada más reciente (`PALACIOS`, `PALACIOS_ULTRA`, `BENAVIDES`, `BENAVIDES_2`, `ROOSEVELT`, `PIURA`).
* **PROVEEDOR:** `CLICK2RING` si proviene de pauta publicitaria (tags `meta-ads`, `cpc`, `Paid Social`, `adId`). `IN_HOUSE` únicamente si es 100% orgánico sin anuncio.
* **CANAL:** `FB-MSGR` (Facebook Messenger).
* **TRATAMIENTO:** Nombre completo en formato título (`Colageno`, `Potencia`, `Diabetes`, `Prostata`, `Vision`, `Artritis`, `General`). Longitud mínima: 3 caracteres.

---

### Protocolo 3: Protección UX del Asesor (Escudo de 15 Minutos)
* **Regla Inquebrantable:** Si un contacto está asignado a un asesor y la conversación ha registrado mensajes en los últimos **15 minutos**, el motor **aborta cualquier intento de actualización por API**.
* **Objetivo:** Evitar que la interfaz de GHL recargue el panel de contacto, salte en la lista de mensajes o borre números que el asesor esté digitando en vivo.
* **Momento de Inyección:** Los datos se inyectan en el momento cero (al entrar el lead fresco antes de que el asesor abra el chat) o en momentos de calma (> 15 minutos sin mensajes).

---

### Protocolo 4: Integridad de Datos Generales (USA)
* Todo teléfono extraído debe formatearse estrictamente bajo el estándar NANP de Estados Unidos: `+1XXXXXXXXXX` (10 dígitos).
* El código de área telefónico mapea automáticamente:
  * **País:** `United States`
  * **Estado (`state`):** Sigla oficial de 2 letras (ej: `479` ➡️ `AR`, `832` ➡️ `TX`, `786` ➡️ `FL`).
  * **Zona Horaria (`timezone`):** Formato IANA correspondiente (`America/New_York`, `America/Chicago`, `America/Los_Angeles`, etc.).

---

### Protocolo 5: Procedimiento de Reinicio y Despliegue
Antes de poner en marcha cualquier cambio:
1. **Ejecutar Pre-Flight Check:**
   ```bash
   node src/tests/test_audit_engine.js
   ```
   Debe devolver obligatoriamente: `6/6 Reglas protocolares validadas al 100%`.
2. **Reinicio Obligatorio:**
   Si se está corriendo localmente en CMD, presionar `Ctrl + C` e iniciar nuevamente (`node src/server.js`) para garantizar que la memoria RAM cargue el código nuevo.
3. **Despliegue a Servidor Cloud (Render):**
   Subir los cambios con `git push origin main`. En Render, el servidor ejecuta automáticamente el pre-flight test al iniciar cada contenedor.

---

## 3. 🧹 Rutina Diaria de Curación en "Tiempos Muertos" (Opción 6)
Para mantener la base de datos saludable sin interrumpir los dos turnos laborales:
1. Abrir `ejecutar_pipeline.bat` en momentos de calma o cambio de guardia.
2. Seleccionar la **Opción `[6]`**.
3. El script recorre los últimos contactos, corrige etiquetas cruzadas, inyecta Ad IDs faltantes en ambos campos (`6w3y...` y `ujLG...`) y respeta el escudo de chats activos.
