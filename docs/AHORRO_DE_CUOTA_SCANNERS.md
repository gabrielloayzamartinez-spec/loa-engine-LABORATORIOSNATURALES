# AHORRO DE CUOTA — SCANNERS Y RUTEO QUE NO APORTABAN

**Fecha:** 27-nov-2026 · **Evidencia:** `/api/auditoria/tecnica` en producción · **Objetivo:** dejar de gastar GHL en trabajo redundante sin perder el Nivel 1.

---

## 1. Lo que se midió (producción, 18 h de uptime)

**224.040 llamadas GHL · 9.920/hora ≈ 238.000/día** (por encima del techo de 200.000).

| Proceso | Nivel | Llamadas | % |
| :--- | :--- | ---: | ---: |
| **Order History** | N2 | **75.888** | 34% |
| Agente 3 (router) | N1 | 56.973 | 25% |
| **Radar (scanner)** | N1 | **56.432** | 25% |
| Dual Sync | N2 | 25.939 | 12% |
| Curadores (4 sedes) | N2 | 5.754 | 3% |
| Reverse Sync | N2 | 1.498 | 0,7% |

Y el diagnóstico de bucles de 60 minutos:

| Origen | Ruteos | Únicos | Desperdicio |
| :--- | ---: | ---: | ---: |
| **radar** | 122 | 92 | **25%** |
| curador-bidireccional | 82 | 81 | 1% |
| limpiador-bandejas (webhook) | 50 | 47 | 6% |
| **guardián-bandejas** | 20 | 20 | re-ruteo de trabajo ya hecho |
| trabajo-del-día | 4 | 4 | 0% |

**Veredicto del propio motor:** 1.005 ruteos para 735 contactos únicos → **26,9% de desperdicio** y 58 contactos ruteados varias veces.

---

## 2. Qué se cambió

| Componente | Antes | Ahora | Por qué |
| :--- | :--- | :--- | :--- |
| **Radar** (scanner) | cada **5 s**, sin pausa (el ciclo duraba ~1 min, así que corría continuo) | cada **60 s** (`RADAR_INTERVALO_MS`); se apaga con `RADAR_ENABLED=false` | releía 60 contactos + 100 conversaciones por sede **aunque no hubiera mensajes nuevos** |
| **Trabajo del día** | cada **3 min** | cada **15 min** (`TRABAJO_DIA_MS`) | el dato del día no cambia cada 3 minutos; paginaba hasta 15 páginas × 4 sedes |
| **Guardián de bandejas** | cada **60 s** | **APAGADO** (`GUARDIAN_BANDEJAS_ENABLED=false`) | con los dueños disueltos, "sin asignar" es el estado NORMAL: re-ruteaba trabajo ya hecho |
| **Curador bidireccional** | forward **60 s** / backward **60 s** | forward **15 min** / backward **30 min** | recorría GHL contacto por contacto; el Nivel 3 ya garantiza frescura |
| **Order History por contacto** | pedía órdenes a **todos** (incluidos leads sin compras) | sólo si tiene **compras o monto** (`ORDER_HISTORY_SOLO_COMPRADORES`) | 1 llamada a vTiger + 1-2 a GHL por lead **sin nada que publicar** |

Nada del Nivel 1 se apagó: el router y los webhooks siguen igual. El radar sigue siendo la red de seguridad, pero deja de escanear sin parar.

---

## 3. Ahorro estimado

| Proceso | Antes (llamadas/h) | Después (estimado) | Ahorro |
| :--- | ---: | ---: | ---: |
| Radar (lecturas de escaneo) | ~3.100 | ~480 | **−84%** |
| Guardián de bandejas | ~80 | 0 | −100% |
| Curador bidireccional | ~320 | ~25 | −92% |
| Trabajo del día | ~200 | ~40 | −80% |
| Order History (leads) | ~2.500 | ~900 | −64% |
| **Total estimado** | **~9.920** | **~5.800–6.500** | **~35–40%** |

Traducido al día: de **~238.000** a **~140.000–155.000** llamadas → por debajo del techo de 200.000, con margen para el backfill histórico.

> Son estimaciones basadas en la mezcla medida. La cifra real se lee en `/api/auditoria/tecnica` → `resumenConsumo.tasaTotalPorHora` después de 1 hora de correr.

---

## 4. Cómo verificarlo

```bash
# Antes y después (esperar ~1 h entre lecturas)
curl -s https://loa-engine-laboratoriosnaturales.onrender.com/api/auditoria/tecnica | jq '.resumenConsumo'

# El detalle por proceso dice quién gasta:
#   consumoPorProceso[].porHora  (0 = no corrió en la ventana)
#   bucles.desperdicioPct        (objetivo: < 10%)
```

**Semáforo**

| Métrica | Verde | Rojo |
| :--- | :--- | :--- |
| `tasaTotalPorHora` | < 6.500 | > 8.500 |
| `bucles.desperdicioPct` | < 10% | > 20% |
| Radar por hora | < 600 | > 1.500 |

---

## 5. Si algo se echa de menos

Todo se reactiva por entorno, sin tocar código:

```ini
RADAR_ENABLED=true
RADAR_INTERVALO_MS=15000        # volver a 15 s
TRABAJO_DIA_MS=180000           # volver a 3 min
GUARDIAN_BANDEJAS_ENABLED=true  # volver a rutear bandejas sin dueño
CURADOR_FORWARD_MS=60000
CURADOR_BACKWARD_MS=60000
ORDER_HISTORY_SOLO_COMPRADORES=false
```

---

## 6. Nota sobre el "ruteo" que no servía

El motor tiene **dos** caminos de ruteo:

1. **Webhook** (`/webhook/chat-router`, `/webhook/meta`): llega el mensaje → se atiende. Es el camino bueno y el que debe usarse.
2. **Scanner** (radar): recorre GHL por si el webhook falló. Ese es el que gastaba cuota.

Si el webhook de GHL está bien configurado y estable, se puede apagar el scanner del todo (`RADAR_ENABLED=false`) y el ruteo queda 100% por evento. El radar se deja encendido a 60 s como red de seguridad; la decisión es del negocio, no del código.
