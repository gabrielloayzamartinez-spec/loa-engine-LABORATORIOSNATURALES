# LOA ENGINE — PLAYBOOK DE DESPLIEGUE (RAMA AISLADA → RENDER)

> **Rama de trabajo:** `bionic/fix-seguridad`
> **Objetivo:** integrar el PIT de Palacios, purgar el GHL Central, blindar secretos y
> habilitar colas durables **sin provocar crash loop en Render**.

---

## 1. FLUJO DE RAMAS (NO MERGEAR A `main` SIN GATE VERDE)

```bash
# 0. Estado limpio y rama aislada
git checkout -b bionic/fix-seguridad        # ya existente en este repo
git status

# 1. Gate obligatorio antes de commitear
npm run preflight      # secretos + 29 reglas + presupuesto < 5 s (OFFLINE)
npm run verify:boot    # smoke test de la malla de rutas (sin abrir puertos)
npm test               # suite offline completa (NO toca APIs externas)

# 2. Commit (el hook bloquea cualquier secreto)
cp scripts/pre-commit-hook.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
git add -A && git commit -m "feat(arch): PIT Palacios + purga GHL Central + colas durables fail-safe"

# 3. Push de la rama y preview deploy en Render (NO push a main todavía)
git push -u origin bionic/fix-seguridad
```

**El merge a `main` sólo se autoriza si:** `preflight` → `[RESULT] APTO PARA DEPLOY`,
`verify:boot` → `[RESULT] Malla de rutas íntegra` y `npm test` → todo verde.

---

## 2. VARIABLES DE ENTORNO EN RENDER

Configurar en **Dashboard → Environment** (nunca en el repositorio):

| Variable | Valor | Obligatoria |
| --- | --- | --- |
| `GHL_API_KEY_PALACIOS` | PIT nuevo de la subcuenta Palacios | **SÍ** |
| `GHL_LOCATION_ID_PALACIOS` | `5NqOaPYqWyIw2FPBfoRg` | **SÍ** |
| `GHL_API_KEY` / `GHL_LOCATION_ID` | alias de la sede primaria (Palacios) | recomendado |
| `GHL_API_KEY_BENAVIDES` | PIT de Benavides | si la sede está activa |
| `GHL_LOCATION_ID_BENAVIDES` | `QXcNBK6XCgpQaZ81Z8pv` | si la sede está activa |
| `VTIGER_URL` / `VTIGER_USERNAME` / `VTIGER_ACCESS_KEY` | conexión vTiger (solo lectura) | **SÍ** |
| `VTIGER_URL_<SEDE>` / `VTIGER_USERNAME_<SEDE>` / `VTIGER_ACCESS_KEY_<SEDE>` | instancia vTiger **dedicada** de una sede (opcional, ver §7) | solo si aplica |
| `META_WEBHOOK_VERIFY_TOKEN` | token propio del webhook | si se usa `/webhook/meta` |
| `META_ACCESS_TOKEN_PALACIOS` | System User Token | recomendado |
| `NODE_ENV` | `production` | **SÍ** |
| `PREFLIGHT_MAX_MS` | `5000` | **SÍ** |
| `STRICT_CONFIG` | `false` (**nunca `true` en Render**) | **SÍ** |
| `QUEUE_DRIVER` | `memory` (inicial) → `bullmq` (tras aprovisionar Redis) | **SÍ** |
| `REDIS_URL` | URL de Upstash/Render Key Value | solo con `bullmq` |
| `PERSISTENCE_DRIVER` | `file` (inicial) → `postgres` | **SÍ** |
| `DATABASE_URL` | PostgreSQL de Render | solo con `postgres` |

> `GHL_API_KEY_CENTRAL` y `GHL_LOCATION_ID_CENTRAL` deben **eliminarse** del dashboard:
> ya no son consumidas por el motor.

---

## 3. PROTOCOLO DE ENCENDIDO DEL FEATURE FLAG (COLAS DURABLES)

La migración es en dos tiempos para que un problema de Redis nunca detenga la operación:

```bash
# FASE 1 — Aprovisionar infraestructura (sin tocar el tráfico actual)
#   a) Crear "Render Key Value" (Redis) y copiar Internal/External URL
#   b) Crear "Render PostgreSQL" y copiar Internal Database URL
#   c) Setear REDIS_URL y DATABASE_URL en el dashboard, dejando:
#        QUEUE_DRIVER=memory
#        PERSISTENCE_DRIVER=file
#   d) Redeploy. El motor sigue igual, pero ya valida que las URLs existen.

# FASE 2 — Activar persistencia distribuida (sin reinicio de lógica)
PERSISTENCE_DRIVER=postgres
#   Redeploy y verificar:  GET /api/health → infrastructure.queue

# FASE 3 — Activar colas durables
QUEUE_DRIVER=bullmq
#   Redeploy y verificar en logs:  [QUEUE] [REDIS-READY] Conexión Redis operativa.
```

**Rollback inmediato:** volver `QUEUE_DRIVER=memory` (o `PERSISTENCE_DRIVER=file`) y
redeployar. El motor degrada solo, sin perder datos: si Redis/PostgreSQL no responden
en el arranque, las colas caen a memoria y el estado a archivo con un `[WARN]`.

**Verificación de las colas activas:**
```bash
curl -s https://<app>.onrender.com/api/health | jq '.infrastructure'
# { "queue": { "featureFlag":"bullmq", "activeDriver":"bullmq", "degraded":false },
#   "breakers": { ... } }
```

---

## 4. VERIFICACIÓN POST-DEPLOY (5 MINUTOS)

```bash
BASE=https://<app>.onrender.com

# 1. Liveness (debe responder 200 SIEMPRE, incluso si vTiger está caído)
curl -s -o /dev/null -w "%{http_code}\n" $BASE/api/health

# 2. Sedes configuradas y PIT nuevo en uso
curl -s $BASE/api/health | jq '.sedes.palacios'
# { "locationId":"5NqOaPYqWyIw2FPBfoRg", "active":true, "configured":true, "paused":false }

# 3. Infraestructura (colas + circuit breakers)
curl -s $BASE/api/health | jq '.infrastructure'

# 4. Dashboard humano
curl -s -o /dev/null -w "%{http_code}\n" $BASE/health

# 5. Verificar en logs de Render:
#    - [SECRETS] Cargados: N/M
#    - [PRE-FLIGHT SANITY CHECK] [SUCCESS] 29/29
#    - [QUEUE] Driver solicitado: ... | Activo: ...
#    - Ausencia de "[INIT] [FATAL]"
```

**Criterio de rollback:** si aparece `[INIT] [DEGRADADO]` o el health check falla dos
ciclos consecutivos (`/api/health` distinto de `200`), hacer *Rollback* del deploy
desde Render al commit anterior.

---

## 5. QUÉ HACE QUE EL SANITY CHECK SEA SEGURO EN RENDER

| Riesgo histórico | Mitigación implementada |
| --- | --- |
| El sanity check hacía I/O (llamaba a vTiger/Meta) y colgaba | Gate 100% síncrono y local. La regla 26 falla la suite si una regla devuelve una Promesa. |
| Un secreto faltante mataba el proceso (`exit 1`) | `auditSecrets()` clasifica crítico/opcional. En `NODE_ENV=production` un secreto esencial sólo emite `[WARN]` y degrada la sede. |
| Un `process.exit(1)` por fallo de sanity → crash loop infinito | El `exit 1` sólo ocurre con `STRICT_CONFIG=true` (local/CI). En Render se arranca en modo observación. |
| Health check profundo (consulta a APIs externas) | `render.yaml` apunta a `/api/health`, que es superficial: no toca GHL, vTiger ni Redis. |
| Importar la app disparaba tráfico y timers | `src/app.js` (malla HTTP pura) vs `src/server.js` (runtime). Los schedulers se registran sólo tras el `listen`. |
| Redeploy perdía jobs en vuelo | Apagado ordenado en SIGTERM/SIGINT: cierra colas, persiste estado y vuelca el learning_brain. |

---

## 6. PRUEBAS DISPONIBLES

| Comando | Alcance | Toca red |
| --- | --- | --- |
| `npm run preflight` | Gate de despliegue (secretos + 29 reglas + presupuesto) | No |
| `npm run verify:boot` | Malla de rutas Express y ausencia de side effects | No |
| `npm test` / `npm run test:offline` | Regresión funcional completa | No |
| `npm run test:queue` | Reintentos, DLQ, burst y circuit breaker | No |
| `npm run test:security` | Saneado, inyección, aislamiento de sede, backoff e idempotencia | No |
| `npm run test:governance` | Protocolo Sede-Lock & Sede-Shield (aislamiento, purga, fail-closed) | No |
| `npm run test:vocab` | Vocabulario clínico canónico y auth centralizada de vTiger | No |
| `npm run test:live` | Curador bi-direccional | **SÍ — muta GHL real** |

> **ADVERTENCIA:** `test_curador_bidireccional.js` ejecuta curación **en vivo** sobre las
> subcuentas reales (crea notas, mueve oportunidades, escribe custom fields). Se sacó de
> `npm test` por esa razón: ningún pipeline de CI debe mutar producción. Ejecutarlo sólo
> de forma manual, consciente y con autorización.

---

## 7. vTIGER POR SEDE (INSTANCIA DEDICADA) — CONFIGURACIÓN OPCIONAL

El diagrama de arquitectura contempla **una instancia vTiger por sede**. El motor ya lo
soporta de forma **retrocompatible**: mientras no se declare nada, todas las sedes usan
el endpoint global y el aislamiento se garantiza con el Sede-Shield (`cf_3451`).

Para dar a una sede su propia instancia (por ejemplo, un servidor vTiger independiente):

```bash
# Render → Environment
VTIGER_URL_PALACIOS=https://vtiger-palacios.dominio.com
VTIGER_USERNAME_PALACIOS=GABRIEL
VTIGER_ACCESS_KEY_PALACIOS=<clave dedicada>
```

Comportamiento resultante:
- `VTIGER_CONFIG.forSede('PALACIOS')` devuelve la instancia dedicada (`isDedicated: true`).
- El login mantiene **una sesión por instancia**, no una global: si una sede tiene su
  propio vTiger, su sesión no se pisa con la de las demás.
- Las sedes sin variables propias siguen consultando el endpoint global, sin cambios.
- Verificación: `npm run test:vocab` (TEST 5) cubre esta resolución.

**Pendiente de decisión:** confirmar si el negocio usa realmente 4 instancias vTiger
separadas o una sola con filtro por sede. Si es una sola, no hay que configurar nada.
