# TRABAJO LOCAL + AUDITORÍA DE MUESTRA (vTiger → GHL)

**Fecha:** 27-nov-2026 · **Herramienta:** `tools/local_sync.mjs` · **Modo:** tu máquina ⇄ APIs de GHL y vTiger

---

## 1. Qué se construyó

Una herramienta local que **no depende de Render** y que trabaja contra las APIs reales:

```bash
node tools/local_sync.mjs estado
node tools/local_sync.mjs auditar   --sede=PALACIOS --muestra=25
node tools/local_sync.mjs pedidos   --sede=PALACIOS --muestra=8
node tools/local_sync.mjs sincronizar --sede=PALACIOS --limite=10            # simula
node tools/local_sync.mjs sincronizar --sede=PALACIOS --limite=10 --ejecutar  # escribe
```

| Comando | Qué hace | ¿Escribe? |
| :--- | :--- | :--- |
| `estado` | ¿Están las 4 sedes en tu `.env`? ¿Cuánta cuota queda? | No |
| `auditar` | Lee N contactos de GHL y verifica 14 CF, etiquetas, teléfono válido para SMS, si existe en vTiger y si sus pedidos están reflejados | **No** |
| `pedidos` | Para N compradores de vTiger: sus órdenes, el total de la última, y cómo está hoy ese comprador en GHL | **No** |
| `sincronizar` | Sincroniza contacto + historial de órdenes | Solo con `--ejecutar` |

---

## 2. Requisitos en tu máquina

1. `.env` con `GHL_API_KEY_<SEDE>` y `GHL_LOCATION_ID_<SEDE>` para las 4 sedes, más `VTIGER_*`.
   **Hoy faltan en local:** `GHL_LOCATION_ID_ROOSEVELT` y `GHL_LOCATION_ID_PIURA`.
   (`estado` te lo dice; mientras tanto `auditar` acepta `--location=<id>`.)
2. **No correr `sincronizar --ejecutar` mientras Render está escribiendo** en la misma
   subcuenta: se duplica el trabajo y el consumo de cuota. Para trabajo local puro:
   pausar el servicio en Render (o usar solo los comandos de lectura).

---

## 3. Resultado de la muestra (medido hoy)

### 3.1 Contactos recientes de GHL — Palacios (10)

| Métrica | Resultado |
| :--- | :--- |
| Teléfono válido para SMS | 4/10 (40%) |
| Listos para SMS (teléfono + tiene teléfono + sede + producto) | 3/10 (30%) |
| Etiquetas completas (canal/prov/sede/página/producto) | 9/10 (90%) |
| Existen también en vTiger | 3/10 (30%) |
| Campos comerciales faltantes | **Canal Captación, Sexo, Etapa, Contact No, Total Compras, fechas, Precio, ID: 10/10** |
| Duplicados de teléfono en la muestra | 0 |

**Lectura:** los contactos **nuevos** de GHL son casi todos leads de Meta: no tienen bloque comercial porque **todavía no están en vTiger** o vTiger no los ha enriquecido. Para SMS masivo hoy servirían solo ~30%, y sin producto/estado el mensaje sería genérico.

### 3.2 Compradores con órdenes — Palacios (8 más recientes por id)

| Comprador | Órdenes | Última orden | Total | En GHL | CF faltan | Campos de pedido faltan | Precio = última orden |
| :--- | ---: | :--- | ---: | :--- | ---: | ---: | :--- |
| ANTONIO HERNANDEZ | 4 | 2026-11-27 | 230 | **NO EXISTE** | — | — | — |
| ERNESTO MARQUEZ | 1 | 2026-10-08 | 170 | INCOMPLETO | 3 | 0 | **NO** |
| RAUL DELGADO | 1 | 2026-10-07 | 250 | INCOMPLETO | 0 | 0 | **NO** |
| JOSE GALVAN | 1 | 2025-03-26 | 210 | INCOMPLETO | 2 | 0 | sí |
| RAMON ORTEGA | 1 | 2026-08-29 | 210 | INCOMPLETO | 2 | **5** | sí |
| ONORIO FRIAS | 1 | 2026-05-27 | 150 | INCOMPLETO | **9** | **5** | **NO** |
| JOSE VILLANUEVA | 1 | 2025-11-06 | 210 | INCOMPLETO | **9** | **5** | **NO** |
| FREDDY CHAVARRIA | 1 | 2026-11-26 | 100 | COMPLETO | 0 | 0 | sí |

**Resumen:** 7/8 existen en GHL (88%), **1/8 completo (13%)**, precio coincidente **3/8**.
Cada comprador recibiría **9–10 campos + nota de historial** al sincronizarse.

**Lectura para marketing:**
- Hay compradores recientes (venta de HOY) que **no están** en GHL: el flujo reactivo no los alcanzó.
- La mayoría **no tiene** el bloque de pedido (Historial, Último Producto, Estado de Entrega, Forma de Pago, Transportista) → sin eso no se puede segmentar por producto/entrega.
- El **"Precio venta" no refleja la última orden** en la mitad de los casos (era el conflicto de escritores que ya se corrigió en código, pero los datos viejos siguen mal).
- El "producto" de la orden viene como **SKU** (`ALFA-HOT---L-179`, `DELT-HOT---G-180`) y a veces literal `VENTA`. Para SMS conviene segmentar por **Tratamiento comprado** (CF del contacto), no por el SKU.

---

## 4. Bug real encontrado y corregido

`phoneClause()` en `src/services/vtigerClient.js` generaba:

```sql
AND (homephone = 'X' OR mobile = 'X' OR phone = 'X')
```

El Webservice de vTiger **no admite paréntesis**: responde
`Syntax Error on line 1: token '(' Unexpected PARENOPEN`. Toda consulta por teléfono
fallaba, se reintentaba 3 veces y **abría el circuit breaker** de vTiger (pausa de 120 s).

Corregido: `phoneClauses()` devuelve una cláusula por campo (sin OR ni paréntesis) y el
llamador las prueba en orden (`homephone` primero, que es donde vive el 100% de los
números reales de compradores). `phoneClause()` se conserva como compatibilidad.

---

## 5. Rutina recomendada para operar en local

1. **Completar el `.env`** (Roosevelt y Piura) y correr `estado`.
2. **Auditar una muestra por sede** (20–30 contactos y 8–10 compradores):
   ```bash
   node tools/local_sync.mjs auditar --sede=BENAVIDES --muestra=25
   node tools/local_sync.mjs pedidos --sede=BENAVIDES --muestra=10
   ```
3. **Sincronizar por lotes** compradores con `sincronizar --limite=N`, primero en
   dry-run y luego con `--ejecutar`. Empezar por los más recientes (venta de esta
   semana) porque son los que alimentan las campañas.
4. **Verificar** repitiendo `pedidos`: el objetivo es `ghl = COMPLETO`,
   `precioOk = sí` y `pedidoFaltan = 0`.
5. **Recién entonces** construir la Smart List de SMS (producto + tiene teléfono +
   estado de compra) sobre datos ya completos.

### Criterio de "listo para SMS"

| Criterio | Hoy (Palacios, muestra) |
| :--- | :--- |
| Teléfono válido EE.UU. | 40% de los contactos recientes |
| Tiene Teléfono = Sí | 30% |
| Sede + Producto poblados | 90% de etiquetas, CF variable |
| Bloque de pedido completo (compradores) | **13%** |

> ⚠️ **Cumplimiento:** GHL exige *opt-in* para SMS masivo y el motor **no registra un campo de consentimiento**. Antes de lanzar SMS hay que decidir dónde se guarda el consentimiento y filtrar por él; de lo contrario la campaña no es defendible.

---

## 6. Archivos

| Archivo | Qué es |
| :--- | :--- |
| `tools/local_sync.mjs` | herramienta local (estado / auditar / pedidos / sincronizar) |
| `scratch/audit_out/local_muestra_palacios.json` | salida cruda de la auditoría de contactos |
| `src/services/vtigerClient.js` | `phoneClauses()` corregido (sin paréntesis) |

**Verificación:** 22 suites en verde tras el cambio en `vtigerClient`; la herramienta
se probó contra las APIs reales en modo lectura y en dry-run.
