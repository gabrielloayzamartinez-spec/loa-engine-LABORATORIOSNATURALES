# ⚡ MOTOR REACTIVO vTiger → GHL (Nivel 2)

**Objetivo:** que un cambio en vTiger (Contacto u Orden de Venta) dispare una señal que sincronice automáticamente ese contacto en GHL, al momento.

---

## 1. Arquitectura

```
vTiger (Workflow/Webhook al guardar un cambio)
   │  POST HTTP con { meta: {event_id, event_type, vtiger_record_id}, contact: {...} }
   ▼
LOA Engine  →  /webhook/vtiger/reactive
   │  (idempotencia por event_id + reconciliación por vtiger_record_id)
   ▼
GHL (upsert del contacto en su subcuenta según Oficina Actual cf_3590)
```

**Ya construido en el motor:**
- Endpoint: `POST /webhook/vtiger/reactive` (en `src/app.js`).
- Lógica: `src/services/vtiger_reactive_sync.js` (`procesarEventoReactivo`).
- Idempotencia por `event_id` (un evento se procesa UNA vez) + retry con backoff.
- Reconciliación por `vtiger_record_id`.

---

## 2. Qué falta: configurar el Workflow en vTiger (lado vTiger, UI)

Para que vTiger "mande la señal", hay que crear un **Workflow → Webhook** en la UI de vTiger:

1. En vTiger: **Settings → Workflows** (o Herramientas → Automatización).
2. Crear workflow para el módulo **Contacts** (y otro para **SalesOrder/Invoice**).
3. Condición: *"Al crear o modificar un registro"* (o transiciones clave: calificación, cambio de etapa, venta nueva).
4. Acción: **Send Webhook (HTTP POST)** con esta URL:

```
https://loa-engine-laboratoriosnaturales.onrender.com/webhook/vtiger/reactive
```

5. **Body (JSON)** del webhook (formato que espera el motor):

```json
{
  "meta": {
    "event_id": "evt_<id_único>",
    "event_type": "contact.qualified",
    "vtiger_record_id": "12x2886921",
    "timestamp": "2026-11-19T10:00:00Z"
  },
  "contact": {
    "firstname": "JULIO",
    "lastname": "ALBITRES",
    "phone": "9043979771",
    "sede": "BENAVIDES",
    "etapa": "2-POR ASIGNAR",
    "tratamiento": "Testosterona",
    "num_compras": "1",
    "fecha_ultima_compra": "2026-09-21",
    "campaign": "BENAVIDES-IN_HOUSE-FORM-Testosterona"
  }
}
```

> ⚠️ **`sede` debe llevar la Oficina Actual (`cf_3590`)**, no la original (`cf_3451`), para que el contacto aterrice en la subcuenta correcta.

---

## 3. Allow-list de eventos (los únicos que procesa el motor)

| event_type | Cuándo se emite |
| :--- | :--- |
| `contact.created` | nuevo contacto en vTiger |
| `contact.qualified` | lead calificado (teléfono válido y/o compra) |
| `contact.stage_changed` | cambio de etapa comercial |
| `contact.assigned` | asignación de asesor / cita |
| `sale.created` | venta nueva (SalesOrder) |

*(Cualquier otro event_type se descarta silenciosamente — no se procesa.)*

---

## 4. Fallback: watcher por polling (ya existe)

Mientras no se configure el Workflow en vTiger, el **watcher** `vtiger_bridge/vtiger_watcher.py` hace polling cada 2 min de `modifiedtime` y empuja los contactos cambiados a GHL. Es el plan B (near-real-time), no reactivo puro.

---

## 5. Estado

| Pieza | Estado |
| :--- | :--- |
| Endpoint `/webhook/vtiger/reactive` | ✅ construido |
| `procesarEventoReactivo` (idempotencia + reconciliación) | ✅ construido |
| Preferencia `cf_3590` en la sede | ✅ corregido (2026-11-19) |
| Watcher por polling (fallback) | ✅ existe |
| **Workflow/Webhook en vTiger (señal push)** | ⏳ **pendiente — se configura en la UI de vTiger** |

---

*Documento de diseño del motor reactivo Nivel 2.*
