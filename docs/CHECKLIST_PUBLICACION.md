# CHECKLIST DE PUBLICACIÓN Y ARRANQUE EN RENDER

**Fecha:** 27-nov-2026 · **Estado:** código commiteado (`81d68bd`), árbol limpio.

---

## 1. Lo que ya está listo (viaja en el repo)

| Elemento | Estado |
| :--- | :--- |
| Código con el contrato de etiquetas (`prov-*` + `pagina-*`) | ✅ commiteado |
| Matriz de 17 páginas con proveedor e iniciativa | ✅ |
| `render.yaml` con las variables de la operación por niveles | ✅ actualizado |
| `Dockerfile` + `npm start` → `src/server.js` | ✅ |
| 24 suites en verde, `BOOT=0` | ✅ |

---

## 2. Lo que NO viaja en el código y hay que cargar en Render

### 2.1 Variables de entorno (Dashboard → Environment)

Todas están declaradas en `render.yaml`; las que dicen `sync: false` **hay que cargarlas a mano**:

| Grupo | Variables |
| :--- | :--- |
| **GHL — 4 sedes** | `GHL_API_KEY_{PALACIOS,BENAVIDES,ROOSEVELT,PIURA}` y `GHL_LOCATION_ID_{...}` |
| **GHL — Empresa** | `GHL_API_KEY`, `GHL_LOCATION_ID` |
| **vTiger** | `VTIGER_ACCESS_KEY` (URL y usuario ya tienen valor) |
| **Meta — 4 sedes** | `META_APP_ID_*`, `META_APP_SECRET_*`, `META_ACCESS_TOKEN_*`, `META_AD_ACCOUNT_IDS_*` |
| **Meta — general** | `META_WEBHOOK_VERIFY_TOKEN`, `META_BACKUP_TOKENS` |
| **Licencia** | `LOA_LICENSE_KEY` |

> **Ojo:** `GHL_LOCATION_ID_ROOSEVELT` y `GHL_LOCATION_ID_PIURA` estaban vacíos en local y los completé hoy. Verificá que en Render tengan valor:
> `SETlaGKhBpbqfBSzzpIB` (Roosevelt) y `9J4pKs5f7OcaokdhyurW` (Piura).

### 2.2 Webhooks (esto es lo que hace que el N1 sea instantáneo)

| Origen | URL destino | Evento |
| :--- | :--- | :--- |
| **GHL** (por cada subcuenta) | `https://<tu-servicio>.onrender.com/webhook/ghl-contact` | ContactCreate / InboundMessage |
| **Meta** | `https://<tu-servicio>.onrender.com/webhook/meta` | mensajes de página |

Sin esto, el sistema depende del radar (60 s) y no del webhook (~3 s).

---

## 3. Orden de publicación

```bash
# 1. Publicar el código
git push origin main

# 2. Render detecta el push y despliega (o "Manual Deploy")
# 3. Cargar/verificar las variables de la sección 2.1
# 4. Confirmar los webhooks de la sección 2.2
```

---

## 4. Verificación post-despliegue (5 minutos)

| # | Qué | Cómo | Esperado |
| :--- | :--- | :--- | :--- |
| 1 | Servicio vivo | `GET /api/health` | `200` |
| 2 | Niveles corriendo | `GET /api/nivel3/estado` | contadores y límites |
| 3 | Las 4 sedes responden | `GET /api/subcuentas/control` | 4 sedes activas |
| 4 | Etiquetado correcto | `node tools/lab_n1.mjs --sede=PALACIOS --muestra=10` | `revisar=0`, `sinCanal=0` |
| 5 | Cobertura de campos | `node tools/local_sync.mjs cobertura --sede=PALACIOS --muestra=10` | Fecha Creación ≥95% |
| 6 | Sin basura nueva | `node tools/clasificar_etiquetas.mjs --sede=PALACIOS` | basura = 0 |

---

## 5. Riesgos antes de publicar

| Riesgo | Mitigación |
| :--- | :--- |
| Los cambios no se probaron en producción | el commit es reversible: `git revert 81d68bd` |
| Los runners locales siguen escribiendo | **detenerlos antes del despliegue** (dos procesos escribiendo duplican cuota) |
| GHL rechaza borrar etiquetas en uso (409) | las 13 de Palacios se limpian solas con el runner |
| Doble webhook (Render + local) | el local no recibe webhooks; solo el radar. **Apagar el radar local al desplegar** |

---

## 6. Después de desplegar: apagar lo local

| Proceso local | Acción |
| :--- | :--- |
| Radar N1 | detener (lo reemplaza el webhook) |
| Runners N2 | detener (los reemplaza el backfill de Render) |
| `pausar_trabajos.bat` | sirve para pausar lo que quede |

Así no hay dos sistemas compitiendo por la misma cuota.
