# Onboarding de una Sede Nueva — Checklist LOA Engine

**Aplica a:** ROOSEVELT y PIURA (creación prevista: 1 de Octubre de 2026)
**Estado actual de ambas:** `isActive: false`, `isConfigured: false`, `pipeline: null`, `customFields: null`

---

## ESTADO DE PARTIDA (verificado)

| Componente | Roosevelt | Piura |
| :--- | :--- | :--- |
| `GHL_LOCATION_ID_*` | ❌ vacío | ❌ vacío |
| `GHL_API_KEY_*` | ❌ vacío | ❌ vacío |
| `isActive` | `false` | `false` |
| Pipeline | `null` | `null` |
| Custom fields | `null` | `null` |
| Meta app | ❌ vacío | ❌ vacío |
| Páginas de Facebook | ✅ ya definidas | ✅ ya definidas |

**Nada se rompe mientras falten:** el gateway marca la sede como `isConfigured: false`
y el motor simplemente no la incluye en `getActiveSedes()`. Es *fail-safe*, no *fail-open*.

---

## PASO 1 — Variables en Render (imprescindible)

Render → Environment. Añadir por cada sede:

```bash
# Roosevelt
GHL_API_KEY_ROOSEVELT=pit-...
GHL_LOCATION_ID_ROOSEVELT=...

# Piura
GHL_API_KEY_PIURA=pit-...
GHL_LOCATION_ID_PIURA=...
```

**El PIT debe tener estos scopes en la Private Integration:**
- `contacts.readonly` (leer)
- `contacts.write` (crear y actualizar) ← **sin este, no se sincroniza nada**
- `locations.readonly` (descubrir custom fields)

> **Verificación inmediata:** `/api/health` debe mostrar la sede con
> `configured: true`. Si sale `false`, el PIT o el Location ID no llegaron.

### Variables de Meta (solo si la sede tendrá campañas)
```bash
META_APP_ID_ROOSEVELT= / META_APP_SECRET_ROOSEVELT= / META_ACCESS_TOKEN_ROOSEVELT=
META_AD_ACCOUNT_IDS_ROOSEVELT=
```
Si las campañas se gestionan desde otra cuenta, este paso puede omitirse: el motor
**no se rompe** sin ellas (el lead se asigna con los datos que lleguen en el
webhook original).

---

## PASO 2 — Activar la sede en el código

`src/config/sedes_gateway.js`, cambiar `isActive: false` → `true`:

```javascript
ROOSEVELT: {
  sedeId: 'ROOSEVELT',
  isActive: true,        // <- cambiar
  ...
}
```

> **Mientras `isActive` sea `false`, la sede NO se sincroniza aunque tenga
> credenciales.** Las dos cosas hacen falta.

---

## PASO 3 — Descubrir e instalar los Custom Fields

Hoy `SEDE_CUSTOM_FIELDS.ROOSEVELT` y `.PIURA` son `null`. Una vez la sede esté en
Render con credenciales válidas, se pueden listar y mapear:

```bash
curl "https://services.leadconnectorhq.com/locations/<LOCATION_ID>/customFields" \
  -H "Authorization: Bearer <PIT>" \
  -H "Version: 2021-07-28"
```

**Los 29 campos que el motor busca** (nombres del diccionario de Palacios y
Benavides, para replicarlos idénticos en las sedes nuevas):

`Origen Lead` · `Sede Asignada` · `vTiger Sede / Tienda Compra` · `Tratamiento comprado` ·
`vTiger Canal Captacion` · `vTiger Contact No` · `vTiger ID Cliente` ·
`vTiger Fecha Primera Compra` · `vTiger Fecha Última Compra` · `vTiger Total Compras` ·
`Precio venta` · `Estado de Compra` · `vTiger Estado Comercial` · `UTM Campaign` ·
`UTM Source` · `UTM Medium` · `UTM Content` · `UTM Term` · `Ad ID` · `Adset ID` ·
`ID de Anuncio` · `Ultima Interaccion` · `Fecha Ultima Asignacion` · `Fecha compra` ·
`vTiger Fecha Ultima Factura` · `Tiene Teléfono` · `vTiger Anotaciones Redes` ·
`vTiger Historial Completo`

### Campos que hay que CREAR (no existen en ninguna cuenta aún)
| Campo | Tipo | Para qué |
| :--- | :--- | :--- |
| `Proveedor` | TEXT | Trackear `CLICK2RING` / `ERNESTO` / `IN_HOUSE` / `ENZO` |
| `vTiger Etapa Comercial` | TEXT | Etapa real de vTiger (`1-POR ASIGNAR`, `EN LLAMADA`…) |
| `Sexo` | Desplegable | `Hombre` / `Mujer` / `TERCER` — **respetar la capitalización** |

> **Buena noticia:** el motor **descubre los campos por nombre en runtime**, así que
> no hay que pasar IDs. Si el campo existe con el nombre correcto, se llena solo.
> Si falta, se **omite sin error** (no inventa datos).

---

## PASO 4 — Pipeline y etapas

`SEDE_PIPELINES.ROOSEVELT` y `.PIURA` son `null`. Si la sede va a usar embudo
comercial, hay que crear el pipeline en GHL y registrar:

```javascript
ROOSEVELT: {
  id: '<pipelineId>',
  name: 'Embudo Comercial (Redes - Roosevelt)',
  stages: {
    prospectoInicial: '<uuid>',
    contactoCapturado: '<uuid>',
    seguimiento: '<uuid>',
    ganado: '<uuid>',
    perdido: '<uuid>'
  }
}
```

> **Nota:** la sincronización de compradores **NO depende** del pipeline. Se puede
> activar la sede y sincronizar contactos completos sin definir pipeline. El
> pipeline solo hace falta cuando se quiera mover etapas.

---

## PASO 5 — Verificar en vTiger

La sede debe existir en vTiger con el valor exacto en `cf_3451`:

```
ROOSEVELT  →  cf_3451 = 'ROOSEVELT'
PIURA      →  cf_3451 = 'PIURA'
```

`VTIGER_SEDES_VALIDAS` ya incluye ambas, así que **el motor las reconocerá en
cuanto tengan contactos con ese valor**. Si en vTiger se escribe distinto
(ej. `ROOSEVELT-LIMA`), el registro se descarta y se audita `VTIGER_SEDE_INVALID`.

---

## PASO 6 — Verificación final (los 4 puntos)

```bash
# 1. La sede aparece configurada y activa
curl https://loa-engine-laboratoriosnaturales.onrender.com/api/health
#    -> sedes.roosevelt.active = true, configured = true

# 2. Los schedulers ahora cubren 4 sedes
#    (los ciclos recorren getActiveSedes(), que incluirá Roosevelt y Piura)

# 3. Un contacto de la sede nueva se sincroniza
#    -> audit: DUAL_SYNC_SEDE_OK con locationId de Roosevelt/Piura

# 4. Se publican los campos
#    -> busca un comprador en GHL y revisa sus custom fields + nota de historial
```

---

## RESUMEN: qué es imprescindible y qué es opcional

| Paso | ¿Imprescindible? | Efecto si falta |
| :--- | :--- | :--- |
| 1. PIT + Location ID en Render | **SÍ** | La sede queda `configured: false` |
| 2. `isActive: true` | **SÍ** | La sede no se sincroniza |
| 3. Custom fields | Recomendado | Los campos no mapeados se omiten (sin error) |
| 4. Pipeline | Solo si se usan etapas | Sin efecto en la sincronización de contactos |
| 5. `cf_3451` en vTiger | **SÍ** | Los contactos se descartan por sede no reconocida |
| 6. Meta app | Solo si hay campañas | El lead se asigna con los datos del webhook |

**Regla de oro:** mientras algo falte, el sistema **degrada sin romperse**. Nunca
enruta datos de una sede desconocida hacia otra: `resolveSedeContext` devuelve un
contexto `UNRESOLVED` con `apiKey: ''` (fail-safe).

---

## AISLAMIENTO GARANTIZADO DESDE EL DÍA 1

Las sedes nuevas nacen con las mismas protecciones ya verificadas:

- **Sede-Lock:** toda consulta a vTiger va acotada por `cf_3451`.
- **Sede-Shield:** un registro de otra sede se descarta y se audita.
- **Teléfono como único factor:** el match es por número, siempre dentro de una sede.
- **Solo compradores:** los leads con 0 compras no se mudan.
- **Rate limit por subcuenta:** cada sede tiene su propia clave de backoff; un 429
  de Roosevelt **no frena** a Palacios.

---

*Documento de onboarding generado a partir del estado verificado del sistema.*
