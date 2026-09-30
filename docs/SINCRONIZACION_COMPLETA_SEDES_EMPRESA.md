# Sincronización Completa vTiger → GHL (Sedes + Cuenta Empresa)

**Rama:** `bionic/sync-completa-sedes-empresa`
**Base:** `main` @ `de43ee4`
**Fecha:** 30 de Septiembre de 2026
**Estado:** ✅ Desplegado y verificado en producción

---

## 1. RESUMEN EJECUTIVO

Este documento consolida el trabajo de sincronización **vTiger → GHL** para las
**tres cuentas**: las subcuentas operativas de **PALACIOS** y **BENAVIDES**, y la
**Cuenta Empresa** como réplica analítica.

Se corrigieron **11 defectos** encontrados mediante medición directa contra las
APIs reales, no por inspección visual. Los dos más graves:

1. **El 98% de los compradores de Palacios no existía en su propia subcuenta.**
   El motor sólo actualizaba contactos existentes; nunca los creaba.
2. **El puente filtraba por `modifiedtime`**, que marca cualquier edición del
   registro, no una compra. Las ventas del día competían contra miles de fichas
   editadas y quedaban detrás del tope.

---

## 2. ARQUITECTURA DE DOS NIVELES

Definida por el negocio y respetada por el motor:

| Nivel | Qué es | Destino |
| :--- | :--- | :--- |
| **1 — Primario** | El comprador **completo** con sus etiquetas e información, para trabajo comercial | Subcuenta de su sede (`cf_3451`) |
| **2 — Soporte** | La base de esa sede **llena y al día**, para habilitar acciones posteriores (ej. campaña SMS a compradores de la última semana) | Mismos campos, mantenidos por avance monótono |

**La Cuenta Empresa es espejo analítico: NO enruta, NO atiende chats, NO asigna
asesores.** El enrutamiento es *point-to-point* desde vTiger, de modo que una
caída de la Empresa **no detiene** las sedes.

---

## 3. REGLA FUNDAMENTAL: EL TELÉFONO ES EL ÚNICO FACTOR QUE RELACIONA

> *"La lógica sólo se debe desarrollar con el dato de número de teléfono. Eso es
> el único factor que relaciona, en nuestro sentido de herramienta comercial."*

Implementado así:

- La búsqueda es por `homephone` / `mobile` / `phone` con los **últimos 10 dígitos (NANP)**.
- **Se retiró** el "escudo de homonimia": ya no se cruzan nombre ni apellido, y el
  resolvedor por similitud de nombres salió del flujo de búsqueda.
- Si varios registros de vTiger comparten el número, **gana el que tiene compras**
  (es la cartera que interesa) y se audita como `VTIGER_PHONE_MULTI_MATCH`.
- La búsqueda **siempre** va acotada a una sede (**Sede-Lock**): consultar desde
  Benavides nunca devuelve un contacto de Palacios.

**Justificación:** en GHL el teléfono ya es único por subcuenta — la plataforma no
admite dos contactos con el mismo número en la misma location.

**Validación estricta (NANP):** se descartan patrones imposibles antes de tocar GHL.

| Se acepta | Se rechaza (con motivo auditable) |
| :--- | :--- |
| `6145179276` → `+16145179276` | `0000000000` — dígitos repetidos |
| `+1 614-517-9276` | `1234567890` — área que empieza por 1 |
| `(305) 456-1234` | `5551234567` — área 555 reservada |

---

## 4. REGLA DE MUDANZA: SÓLO COMPRADORES

Un contacto de vTiger sin compras es un **LEAD** y **no se sincroniza** por este
conducto: entra cuando el negocio lo necesita o por **RECONTACTO** (otro flujo).

Blindado con `SOLO_COMPRADORES` y `esRegistroComprador()`, con **fail-safe**: sin
el campo, vacío o con valor no numérico → **no es comprador**. La barrera corta
**antes** de tocar la red y audita `DUAL_SYNC_SKIPPED_NOT_BUYER`.

---

## 5. MAPEO DE CAMPOS (verificado en vivo)

### Nativos
`phone` (desde `homephone`, prioritario — medido: el 100% de los compradores lo usa),
`firstName`, `lastName`, `email`, `city`, `state`, `source`.

### Personalizados — 18 en Empresa, 16 en sede

| vTiger | GHL |
| :--- | :--- |
| `cf_3451` sede | Sede Asignada / vTiger Sede-Tienda Compra |
| `cf_3472` relación | **Origen Lead** y UTM Campaign |
| `cf_2572` proveedor | Proveedor *(campo pendiente de crear)* |
| `cf_2610` padecimiento | Tratamiento comprado |
| `cf_3507` canal | vTiger Canal Captacion |
| `splareacodes_state(_code)` | `state` nativo (saneado) |
| `spl_fecha_ultima_compra` | vTiger Fecha Última Compra |
| `spl_fecha_primera_compra` | vTiger Fecha Primera Compra |
| `spl_num_compras` | vTiger Total Compras |
| `cf_3392` (gasto ACUMULADO, verificado) | vTiger Total Historico Gastado USD |
| `cf_994` etapa comercial | vTiger Etapa Comercial *(campo pendiente)* |
| `cf_1876` | vTiger Estado Comercial |
| `contact_no` | vTiger Contact No |
| `wcf_acf_atf_3390` | vTiger Asesor Asignado (Empresa) |
| `createdtime` | vTiger Fecha Creacion (Empresa) |
| `cf_2821` **SSEXO** | Sexo *(campo pendiente)* — valores reales `Hombre` / `Mujer` / `TERCER` |

### Descartados a propósito (con motivo)
- **`cf_3561`** ("Anotaciones Redes"): verificado en 12 compradores, su valor es
  `"49"` en el 100% y ninguno supera 12 caracteres. **No es una anotación.**
- **Ciudad**: `cf_1157` vacío en el 100% de los compradores medidos y `mailingcity`
  restringido por rol. **No se inventa.**
- **Zona horaria**: vTiger trae `ESTE`/`PACIFICO`/`CENTRO`/`MONTAÑA`, pero GHL
  gestiona su propio campo. **No se publica.**

---

## 6. CAPAS DE BLINDAJE

### Sede-Shield (3 capas)
1. **En la consulta**: toda query va acotada por `cf_3451`.
2. **En la búsqueda**: `belongsToSede()` descarta cualquier registro ajeno y audita `SEDE_SHIELD_BLOCKED`.
3. **En el payload**: `detectarSedeEnTexto()` reconoce la sede como **token completo**
   dentro de un texto (no por `includes` suelto). Si un campo nombra otra sede, se
   **vacía**. Y si el registro de vTiger no pertenece a la sede de destino, se purgan
   `contactoNo` e `idClienteVt` y se audita como **crítico**.

### Avance monótono del historial
La protección anterior ("si el contacto existe, no toques sus campos de compra")
**congelaba** la fecha de última compra: un cliente que volvía a comprar nunca la
actualizaba, y **la mitad de los contactos en GHL quedó sin ese dato** (25 de 50
medidos). La regla correcta es **"no retroceder"**:

```
GHL no tiene el dato            → se escribe
dato de vTiger MÁS NUEVO        → se escribe  (hubo compra nueva)
más antiguo o igual             → NO se escribe (se protege)
```

`parseFechaGhl()` normaliza los dos formatos: GHL devuelve sus campos DATE como
**epoch en milisegundos**; vTiger entrega `YYYY-MM-DD`.

### Control de APIs
- **Cola TokenBucket global**: serializa todas las llamadas a GHL de las 3 cuentas. Sin ráfagas.
- **Backoff por subcuenta** ante 429: pausa preventiva hasta 300 s, hasta 4 reintentos.
- **Prioridad ALTA** para webhooks en vivo: el trabajo de fondo nunca bloquea la atención.
- **Caché de custom fields** por location: 1 llamada por location por proceso.
- **Guardas de solapamiento**: si un ciclo tarda más que su intervalo, se omite el siguiente.

**Consumo medido:**

| Métrica | Valor |
| :--- | :--- |
| Llamadas a GHL por contacto | **8.6** (5.4 sede + 3.2 Empresa) |
| Ritmo real | 90 llamadas/minuto (global) |
| Límite de GHL | 100 / 10 s por location = 600/min |
| **Margen** | **6.6x por debajo** |

---

## 7. VOLÚMENES REALES Y TIEMPOS

Medidos contra vTiger por **fecha real de compra**:

| Ventana | PALACIOS | BENAVIDES | Total | Tiempo estimado |
| :--- | ---: | ---: | ---: | :--- |
| **Ayer (24 h)** | 23 | 22 | **45** | ⚡ ~5 min |
| Últimos 3 días | 58 | 43 | 101 | ⚡ ~10-15 min |
| **Últimos 10 días** | 197 | 189 | **386** | ⏱️ ~40-60 min |
| Últimos 30 días | 623 | 549 | 1.172 | 🕐 ~2 h |
| **Cartera total** | 1200+ | 1200+ | **2400+** | 🕐 ~7 h de trabajo continuo |

Cobertura actual en GHL: **Palacios 3.367** contactos | **Benavides 6.820**.

---

## 8. DEFECTOS CORREGIDOS

| # | Defecto | Impacto medido |
| :--- | :--- | :--- |
| 1 | Consulta del Reverse Sync sin filtro de sede | 871 fallos, ~44 h sin sincronizar |
| 2 | El motor nunca **creaba** contactos (sólo actualizaba) | **98%** de compradores de Palacios ausentes |
| 3 | `PAUSE_BENAVIDES` ausente → `undefined !== 'false'` = `true` | Benavides pausada en producción |
| 4 | El puente contaba **éxitos como fallos** (`ok` a nivel raíz ausente) | 11 éxitos reportados como 11 fallos |
| 5 | El puente no progresaba en la cartera (sin cursor) | Repetía los mismos 25 por ciclo |
| 6 | Protección de historial **congelaba** fechas de compra | 50% sin `Fecha Ultima Compra` |
| 7 | `modifiedtime` en vez de fecha de compra | Las ventas del día quedaban detrás |
| 8 | La Empresa escribía etapa de vTiger en el campo del negocio | 73 contactos contaminados; Smart Lists de compradores rotas |
| 9 | La Empresa no tenía clave de rate limit (efímera por petición) | Su 429 no activaba pausa preventiva |
| 10 | Estado escrito sin validar (colaba `VI`) | 1 valor inválido de 40 auditados |
| 11 | `limpiarNombre(null)` producía el literal `"null"` | Habría escrito "null" como nombre |

---

## 9. PENDIENTES DEL NEGOCIO

| # | Acción | Dónde | Efecto si falta |
| :--- | :--- | :--- | :--- |
| 1 | Campo **`Proveedor`** (TEXT) | GHL: Empresa + sedes | `CLICK2RING`/`ERNESTO` no se trackean |
| 2 | Campo **`vTiger Etapa Comercial`** (TEXT) | GHL: Empresa + sedes | La etapa de vTiger se omite |
| 3 | Campo **`Sexo`** (desplegable: `Hombre`/`Mujer`/`TERCER`) | GHL: Empresa + sedes | El sexo se omite |
| 4 | Limpiar **73 contactos** con etapa en `Estado de Compra` | GHL | Smart Lists de compradores incompletas |
| 5 | PIT válido de la Cuenta Empresa | Render | Empresa no recibe datos (`401`) |

**Nota:** los campos 1-3 no necesitan IDs. El motor los descubre por nombre y
empieza a llenarlos solo.

---

## 10. VERIFICACIÓN

```
13 suites de pruebas en verde
  test_dual_upsert.js        205 aserciones
  test_contact_collision.js   63 aserciones
  test_sede_governance.js     69 aserciones
  test_security_hardening.js  57 aserciones
  test_clinical_vocabulary.js 42 aserciones
  test_ingress_filter.js      39 aserciones
  test_order_history.js       38 aserciones
  test_audit_engine.js        29/29 reglas protocolares

npm run preflight   →  APTO PARA DEPLOY
npm run verify:boot →  malla de rutas íntegra
```

---

## 11. DEUDA TÉCNICA DOCUMENTADA

- **`learning_brain.json` estuvo versionado en git** siendo estado de runtime: cada
  ciclo de aprendizaje ensuciaba el repositorio y un merge podía pisar lo aprendido
  en producción. Se sacó del índice (`git rm --cached`) junto con
  `cursor_curador_benavides.json` y `pipelines_cache.json`.
- **La cartera histórica es lenta por diseño**: ~10 contactos/minuto. Es la
  contrapartida de mantener 6.6x de margen y no arriesgar un `429` que degradaría
  la atención en vivo.

---

*Documento generado a partir de mediciones directas contra las APIs de vTiger y
GoHighLevel. Cifras verificadas en producción.*
