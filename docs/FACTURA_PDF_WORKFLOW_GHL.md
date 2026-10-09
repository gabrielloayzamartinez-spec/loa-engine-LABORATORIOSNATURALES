# 🧾 Factura en PDF de Compras Nuevas → Cliente (vía Cuenta Empresa GHL)

**Proyecto:** LOA Engine — Laboratorios Naturales
**Objetivo del dueño:** que cada cliente que **cierra una compra** reciba el **PDF de su factura** por **WhatsApp/SMS con enlace**, disparado por un **workflow en la Cuenta Empresa Central** de GHL.
**Alcance acordado:** solo **compras nuevas** (no backfill histórico).
**Estado:** DISEÑO APROBADO + DIAGNÓSTICO REAL.
**Decisiones tomadas:** **Vía A** (se usa el PDF OFICIAL de vTiger) y **todo el flujo desde la Cuenta Empresa Central**.
**Bloqueantes:** B1 (token de la Empresa) → **RESUELTO en producción** (`credencial.valida = true`, HTTP 200); **pendiente replicar el PIT nuevo en el `.env` local**. B2 (PDF oficial) → requiere cargar las credenciales **web** de vTiger en `.env`.

> 📦 **IMPLEMENTACIÓN ENTREGADA EN UN REPOSITORIO INDEPENDIENTE**
> El flujo completo (detector de compras + PDF + publicación + puente) vive ahora en un proyecto **autónomo y separado**, listo para ejecutarse por sí solo:
> **`C:\Users\Lenovo\Desktop\LOA_INVOICE_ENGINE`** — cero dependencias externas, CLI propia, 7 suites de pruebas (261 asserts) en verde y commit inicial creado (rama `main`, 23 archivos).
> Este documento queda como **diseño de referencia**; los módulos de este motor son el prototipo del que se portó el código.

---

## 1. 🔬 Diagnóstico ejecutado (evidencia, no suposiciones)

Scripts de diagnóstico (solo lectura sobre vTiger, una escritura inocua y reversible en GHL):
`scratch/diag_invoice_pdf.js` y `scratch/diag_invoice_pdf2.js`

| # | Prueba | Resultado real | Lectura |
|---|---|---|---|
| A.1 | Contacto comprador por API vTiger | ✅ OK | El motor lee compradores sin problema. |
| A.2 | `SalesOrder` del contacto | ✅ OK (nº orden, total, fecha) | La fuente de la compra **ya está disponible**. |
| A.3 | Módulo `Invoice` por API | ❌ `Permission to perform the operation is denied` | El rol de API **no puede leer facturas**. El motor nunca lo usó. |
| A.4 | Campo de archivo/PDF dentro de `Invoice` | ❌ mismo permiso denegado | El PDF **no vive dentro** del registro. |
| B.1/B.2 | Ruta web `ExportPDF` (Invoice y SalesOrder) | ⚠️ HTTP 200 con **HTML de login** (20.831 bytes, `esLogin=true`) | La ruta **existe**, pero el PDF está **detrás de sesión web** (usuario + contraseña). |
| B.3 | `PDFMaker` | ⚠️ 99 bytes, sin login ni PDF | No confirmado instalado; también exige sesión. |
| C.0 | Credenciales Cuenta Empresa | ✅ presentes y bien formadas (`pit-`, 40 chars, sin espacios) | El formato es correcto. |
| C.1 | `GET /medias/files` (Empresa) | ❌ **HTTP 401 `Invalid Private Integration token`** | El **token de la Empresa está revocado/inválido**. |
| C.2 | `POST /medias/upload-file` (Empresa) | ❌ mismo 401 | Sin token válido no hay URL pública del PDF. |
| C.3 | Control cruzado: `GET /locations/{id}` con PIT de **Palacios** | ✅ **HTTP 200** (`PALACIOS EMPRESA - LABORATORIOS NATURALES`) | El problema es **exclusivo del token de la Empresa**, no del código. |

**Conclusión de hechos:** el motor **no necesita** leer `Invoice` para saber que hubo una compra (usa `SalesOrder`), pero **no puede obtener el PDF por API** y **no puede publicarlo** mientras el PIT de la Empresa siga inválido.

---

## 2. 🚧 Los 2 bloqueantes externos (acciones del dueño)

### B1 — Regenerar el PIT de la Cuenta Empresa Central
El token actual responde **401 "Invalid Private Integration token"** mientras el de Palacios funciona. Acción:

1. GHL → **subcuenta de la Empresa** → *Settings → Private Integrations* → **Create / Regenerate**.
2. Habilitar scopes mínimos para este flujo:
   - `locations.readonly` (health check)
   - `contacts.readonly` + `contacts.write` (escribir la URL de la factura)
   - `medias.read` + `medias.write` (**subir el PDF y obtener su URL**)
   - `customFields.readonly` (resolver el ID del campo puente)
3. Pegar el token nuevo en `.env` → `GHL_API_KEY_CENTRAL` y actualizarlo **también en Render**.
4. Re-ejecutar `node scratch/diag_invoice_pdf.js` → C.1 y C.2 deben quedar `[VIABLE]`.

**Estado verificado el 2026-10-09:**
- ✅ **Producción (Render):** `GET /api/health` → `cuentaEmpresa.credencial = { valida: true, status: 200 }` y `cuotaRealGhl.EMPRESA.dailyRemaining = 174944`. El PIT nuevo **funciona**.
- ⏳ **Local:** el `.env` de la máquina de trabajo conserva el PIT viejo (401). **Falta copiar el mismo valor nuevo** a `GHL_API_KEY_CENTRAL` en `.env` para poder desarrollar y probar sin tocar producción.
- ⏳ Verificar los *scopes* de media (`medias.read` / `medias.write`) del PIT nuevo: se comprueba con C.1 y C.2 del diagnóstico en cuanto el `.env` local quede al día.

### B2 — Decidir cómo se obtiene el PDF (el PDF de vTiger está detrás del login web)
La ruta existe, pero el `access key` de la API **no sirve** para el PDF: se necesita un **usuario web** de vTiger con contraseña y permiso de exportar.

> ✅ **DECISIÓN TOMADA: Vía A** (PDF oficial de vTiger). El formulario de login ya fue inspeccionado (`scratch/diag_vtiger_login_form.js`) y **NO tiene captcha**, así que es automatizable: `POST index.php` con `__vtrftk` (CSRF, formato `sid:...`), `module=Users`, `action=Login`, `username`, `password`, y cookie `PHPSESSID`.
>
> **Variables nuevas requeridas en `.env`** (agregarlas a mano; nunca pegarlas en un chat):
> ```
> VTIGER_WEB_USERNAME=usuario_web_vtiger
> VTIGER_WEB_PASSWORD=contrasena_web_vtiger
> ```
> El probe que valida todo el camino ya está escrito: `node scratch/probe_vtiger_pdf.js` (login → descubre `folderid` → descarga el PDF → valida `%PDF` → guarda en `scratch/out/`).

Comparativa de los dos caminos (la Vía B queda solo como plan de contingencia si el rol de vTiger no permite exportar):

| | **Vía A — Descargar el PDF de vTiger** | **Vía B — Generar el PDF en el motor** *(recomendada)* |
|---|---|---|
| Requiere | Usuario **y contraseña web** de vTiger + permiso `ExportPDF` en su rol | Nada nuevo: los datos de `SalesOrder` ya se leen hoy |
| Riesgo | Cookies/CSRF, plantilla PDF variable, se rompe si cambian el rol o la plantilla; la contraseña pasa a ser un secreto crítico | Ninguno sobre vTiger; el diseño lo controlamos nosotros |
| Mantenimiento | Cada cambio de vTiger puede romperlo | Estable; el logo/layout es propio |
| Dependencia nueva | Ninguna | `pdfkit` (JS puro, sin binarios — Render-friendly) |
| Fidelidad | Idéntico al PDF oficial de vTiger | Réplica visual de los mismos datos (nº orden, fecha, producto, total) |

> **Recomendación:** **Vía B**. Cumple el candado de "vTiger solo lectura" sin abrir excepciones, no depende de credenciales web ni de permisos de rol, y entrega los mismos datos que ya se sincronizan al contacto. Si más adelante se exige el PDF **oficial** con folio fiscal, se migra a Vía A sin cambiar el resto del flujo.

---

## 3. 🏗️ Arquitectura propuesta (extremo a extremo)

```mermaid
flowchart LR
    V[("vTiger SalesOrder\n(compra nueva)")] --> D[LOA Engine:\ndetector de compra nueva]
    D --> P[Obtener PDF\n(Vía B: generar / Vía A: ExportPDF)]
    P --> U[Subir a Media Library\nCuenta Empresa → URL pública]
    U --> W[Escribir campo\n'URL Factura PDF' + tag 'FACTURA_LISTA']
    W --> G{GHL Workflow\nTrigger: tag FACTURA_LISTA}
    G --> M[WhatsApp/SMS con enlace\nal número que cerró la compra]
```

**Contrato de datos (lo que el motor publica y el workflow consume):**

| Elemento | Valor propuesto | Nota |
|---|---|---|
| Campo personalizado (Empresa) | `URL Factura PDF` (texto) | El motor resuelve su ID por nombre con `resolveCustomFieldIds` (ya existe). |
| Campo de control | `Factura Nº Orden` (texto) | Guarda el nº de orden publicada → **idempotencia**. |
| Tag de disparo | `FACTURA_LISTA` | El workflow se activa con *Tag Added*. |
| Tag anti-duplicado | `FACTURA_ENVIADA` | Se puede añadir tras el envío para bloquear reenvíos. |

**Idempotencia (crítico):** antes de publicar, el motor compara `Factura Nº Orden` del contacto; si ya coincide con la orden detectada, **no hace nada**. Así el reenvío masivo es imposible aunque el ciclo se repita.

---

## 4. 🤖 Workflow en GHL (listo para armar en la Cuenta Empresa)

1. **Trigger:** `Contact Tag` → *Tag Added* → `FACTURA_LISTA`.
2. **Filtro:** `URL Factura PDF` *is not empty*.
3. **Acción principal — Send SMS** (o WhatsApp con plantilla aprobada):
   > Hola {{contact.first_name}}, tu compra quedó registrada. Aquí puedes ver y descargar tu factura:
   > {{contact.url_factura_pdf}}
   > Cualquier duda, respóndenos por aquí. — Laboratorios Naturales
4. **Acción secundaria:** añadir tag `FACTURA_ENVIADA` y quitar `FACTURA_LISTA`.
5. **Ventana horaria:** replicar la ya usada por el WF de seguimiento (L-V 07:00-22:00 / S-D 10:00-16:00).
6. **Reintento:** si el envío falla, esperar 1 h y reintentar una sola vez.

> **Discreción (regla de la casa):** el mensaje **no debe nombrar el tratamiento/producto** (artritis, próstata, etc.). Solo factura + enlace.

> **WhatsApp — límite real de Meta:** fuera de la ventana de 24 h desde el último mensaje del cliente, WhatsApp **exige plantilla aprobada**. Con enlace (no adjunto) alcanza una plantilla con una variable de URL; el **SMS no tiene esa restricción**. Si la prioridad es que salga siempre, el SMS es el canal determinista.

---

## 5. 🧩 Plan de implementación en el motor (micro-pasos atómicos)

| Fase | Entregable | Archivos | Prueba |
|---|---|---|---|
| **F1** ✅ | **Sesión web de vTiger + descarga del PDF oficial** (Vía A decidida) | `src/services/vtiger_web_session.js` (nuevo) + `src/tests/test_vtiger_web_session.js` | **52/52 PASS** (red simulada); prueba contra vTiger real vía probe |
| **F2** | Publicar el PDF y escribir el campo/tag puente en la Empresa | `src/services/invoice_publish_service.js` (nuevo) | Test offline con `fetch` simulado + prueba real de 1 caso. |
| **F3** | Detector de **compra nueva** + enganche idempotente | Enganche en `src/services/vtiger_order_history_service.js` (donde ya se escribe a la Central) | `npm run test:orders` + `npm test` completo (14 suites). |
| **F4** | Documentar y activar (feature flag) | `docs/` + `.env.example` | `npm run preflight` y `npm test` en verde. |

**Estado de avance (2026-10-09):**
- ✅ **Puente de datos implementado y probado:** `src/services/invoice_bridge_service.js` + `src/tests/test_invoice_bridge.js` (**27/27 PASS**). Decide con idempotencia estricta (compra nueva → publica; misma orden → bloquea con motivo `YA_PUBLICADA`), arma el payload con los 2 campos y el tag `FACTURA_LISTA`, es fail-safe si un ID no se resuelve, y lee el estado puente desde el contacto de GHL.
- ✅ **Suite integrada:** `npm test` corre ahora **15 suites** → `EXITCODE=0`, con el pre-flight interno en 29/29 reglas. La idempotencia del envío queda blindada de forma permanente.
- ✅ **F1 (sesión web + PDF oficial) IMPLEMENTADO y probado:** `src/services/vtiger_web_session.js` + `src/tests/test_vtiger_web_session.js` (**52/52 PASS**). Maneja el CSRF `__vtrftk`, el jar de cookies, la **sesión cacheada con single-flight** (1 solo login para N facturas), la **renovación automática** si la sesión cae a mitad de camino, el descubrimiento del `folderid` y la validación de los bytes `%PDF`. El candado de solo lectura se **extiende al canal web**: el único POST es el login y la allow-list de acciones es cerrada (`Login`, `ExportPDF`, `Detail`, `index`); `Save/Edit/Delete/MassEdit/Import` se rechazan **antes** de tocar la red.
- ✅ **Probe alineado al módulo real:** `node scratch/probe_vtiger_pdf.js` ejercita el código de producción y se detiene con mensaje claro mientras falten credenciales.
- ⏳ **Pendiente de llaves:** F1 solo espera la **prueba contra vTiger real** (probe) y **F2** (publicación en la Media Library) espera el PIT nuevo en el `.env` local.

**Reglas de seguridad respetadas:**
- El candado de solo lectura de vTiger **no se toca** (`VTIGER_ALLOWED_OPERATIONS` intacto).
- Ninguna escritura sobre vTiger.
- Todo el tráfico a GHL pasa por `ghlFetch` (rate limit, 429, timeout, telemetría).
- El flujo nace **apagado** (`INVOICE_PDF_ENABLED=false`) hasta validar un caso real.

---

## 6. ⚠️ Advertencia de gobernanza (decisión de negocio a ratificar)

La arquitectura vigente define la **Cuenta Empresa como réplica de solo lectura / analítica macro, "CERO ruteo"** (`docs/INFORME_ACTUALIZACION_SINCRONIZACION_Y_BENAVIDES_2026.md:92-95`), y la suite `test_audit_engine.js` (Reglas 19 y 22) vigila que no recupere comportamiento de cuenta operativa.

Enviar mensajes **desde** la Empresa es una excepción funcional a esa regla. Dos opciones:
- **A) La Empresa publica y la sede envía:** el PDF se sube a la Empresa (auditoría central) y el envío lo hace la subcuenta de la sede que cerró la venta (que ya tiene el número de WhatsApp y la conversación del cliente).
- **B) Todo desde la Empresa:** simple, pero requiere número conectado en la Empresa y suma un canal de salida a una cuenta declarada analítica.

> Si el envío sale desde una **sede operativa**, el diseño de §3-§5 no cambia: solo cambia a qué `locationId` se escribe el campo/tag y dónde vive el workflow.

---

## 7. ✅ Checklist de aceptación

- [ ] `GHL_API_KEY_CENTRAL` regenerado y validado (C.1 y C.2 en `[VIABLE]`).
- [ ] Vía del PDF decidida (A o B) y aprobada.
- [ ] Campo `URL Factura PDF` creado en la cuenta emisora.
- [ ] Workflow creado con trigger `FACTURA_LISTA` y **Action deshabilitada** durante la prueba.
- [ ] Prueba con 1 compra real controlada (`INVOICE_PDF_ENABLED=true` para un solo contacto).
- [ ] Verificado: 1 solo mensaje por compra (idempotencia) y sin nombres de tratamiento.
- [ ] `npm test` (14 suites) y `npm run preflight` en verde.
- [ ] Activación general + monitoreo de `/api/health` durante 24 h.
