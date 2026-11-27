# RUNBOOK — COMPLETAR LAS LISTAS DE CADA SUBCUENTA

**Fecha:** 27-nov-2026 · **Objetivo:** dejar llenos los CF de vTiger en GHL para que las listas inteligentes (SMS a sin venta y a compradores) funcionen en cada subcuenta.

---

## 0. Runner continuo (trabaja la cola atrasada en TU máquina)

### Pausar / reanudar (almuerzo, salida a domicilio, etc.)

Los runners **no se apagan**: quedan esperando sin gastar cuota y retoman solos.

```bash
node tools/runner_control.mjs estado
node tools/runner_control.mjs pausar --motivo="almuerzo" --minutos=60
node tools/runner_control.mjs pausar --motivo="me voy a domicilio"     # indefinido
node tools/runner_control.mjs pausar --sede=ROOSEVELT --motivo="mantenimiento"
node tools/runner_control.mjs reanudar
node tools/runner_control.mjs reanudar --sede=ROOSEVELT
```

O con doble clic: **`pausar_trabajos.bat`** y **`reanudar_trabajos.bat`**
(y **`lanzar_runners.bat`** para levantar las 4 sedes).

- La pausa se aplica **al terminar la página en curso** (≤ 1 minuto de retraso).
- Sin `--minutos` la pausa es **indefinida** hasta que se reanude.
- Con `--minutos=N` se reanuda **sola** al vencer.
- El estado vive en `scratch/runner_control.json`.

---

```bash
node tools/runner_n2.mjs --limite=40 --rate=6 --concurrencia=4
```

O doble clic en **`ejecutar_runner_n2.bat`** (queda en segundo plano y escribe en `logs/runner_n2.log`).

- Recorre **compradores (2026→2019)** y luego **contactos (2026→2019)** de cada sede configurada.
- **Reanudable**: guarda el avance en `scratch/runner_n2.json` (no repite lo hecho).
- **Se pausa solo** si la subcuenta no tiene cuota de fondo; reintenta en 60 s.
- **Ctrl+C** guarda y sale limpio.

Progreso:

```bash
type scratch\runner_n2.json
tail logs\runner_n2.log
```

Ritmo medido en esta máquina: **~1.000 fichas/hora** (≈4.000 llamadas/h). El cuello de botella es la latencia por ficha, no la cuota.

### Correr varias sedes en paralelo

Cada sede escribe su propio archivo de avance, así que no se pisan:

```bash
# Palacios + Benavides (compradores primero)
node tools/runner_n2.mjs --limite=40 --rate=6 --concurrencia=4

# Roosevelt: sus compradores ya están al 97%, falta el lead
node tools/runner_n2.mjs --solo=ROOSEVELT --tipo=contactos --limite=40 --rate=6 --concurrencia=4

# Piura: igual
node tools/runner_n2.mjs --solo=PIURA --tipo=contactos --limite=40 --rate=6 --concurrencia=4
```

Archivos de progreso: `scratch/runner_n2.json`, `scratch/runner_n2_ROOSEVELT_contactos.json`, `scratch/runner_n2_PIURA_contactos.json`.

**Prueba real (Roosevelt, 80 fichas):** la cobertura de sus leads pasó de **10% a 93%**
— Canal 0%→90%, Fecha Creación (DATE) 0%→90%, Tratamiento 38%→100%, Estado de Compra 38%→100%.

---


## 1. Lo que ya está probado (hoy, en producción)

Se enriquecieron **45 fichas** con el runner local y se verificó campo por campo:

| Universo | Muestra | Fecha Creación (DATE) | Estado de Compra | Fuente Última Orden | Global |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Contactos (sin venta) · Palacios 2026 | 12 | **100%** | **100%** | — | **95%** |
| Compradores · Palacios 2026 | 10 | **100%** | **100%** | **100%** | **97%** |

Antes de enriquecer, esos mismos campos estaban al **0%**.

> Hallazgo adicional: la auditoría reportaba 0% en "Fecha Creación (Fecha)" porque el comparador **no normalizaba los paréntesis**. Se corrigió: el campo ya se leía bien y ahora la medición es fiable.

---

## 2. El comando (tres pasos por sede y año)
```bash
# 1. OPCIONAL — detectar qué falta (solo lectura)
node tools/historico.mjs detectar --sede=PALACIOS --ano=2026 --tipo=contactos --limite=100

# 2. ENRIQUECER — re-publica las fichas que YA están en GHL (llena sus CF)
node tools/historico.mjs enriquecer --sede=PALACIOS --ano=2026 --tipo=contactos --limite=50 --ejecutar

# 3. VERIFICAR — cobertura campo por campo
node tools/local_sync.mjs cobertura --sede=PALACIOS --tipo=contactos --muestra=12
node tools/local_sync.mjs cobertura --sede=PALACIOS --tipo=compradores --muestra=10
```

`enriquecer` es **reanudable**: guarda el offset en `scratch/historico/<SEDE>_<TIPO>_<POR>_<AÑO>_enrich.json` y al relanzarlo continúa donde quedó. Se detiene solo si la subcuenta agota su cuota.

---

## 3. Volumen a completar (por sede actual)

| Sede | Compradores | Contactos (leads) | Total |
| :--- | ---: | ---: | ---: |
| Palacios | 21.830 | 176.206 | 198.036 |
| Benavides | 12.907 | 124.035 | 136.942 |
| Roosevelt | 6.115 | 41.474 | 47.589 |
| Piura | 4.894 | 35.151 | 40.045 |

**Costo:** ~3,5 llamadas por ficha → **~1,5 M de llamadas** para todo (~8–12 días al presupuesto de fondo).

---

## 4. Orden recomendado (valor primero)

| Tanda | Qué | Fichas | Tiempo aprox. |
| :--- | :--- | ---: | ---: |
| **1** | Compradores 2026–2025 de las 4 sedes | ~14.000 | 1 día |
| **2** | Compradores 2024 y anteriores | ~31.700 | 2 días |
| **3** | Contactos 2026–2025 | ~60.000 | 3–4 días |
| **4** | Contactos 2024 y anteriores | ~317.000 | 2 semanas (opcional) |

Con las tandas 1–3 ya se pueden lanzar las campañas de SMS (compradores completos + leads recientes).

---

## 5. Ritmo y cuota

- Cada corrida toma `--limite` fichas y hace una pausa configurable (`--rate`, por defecto 2/s).
- Antes de escribir, verifica `hayCuotaRealDeFondo(sede)`; si no hay, se detiene y se puede relanzar.
- **No correr en paralelo con el backfill de Render** sobre la misma sede.

Ejemplo de corrida nocturna (≈4 h):

```bash
for a in 2026 2025 2024; do
  node tools/historico.mjs enriquecer --sede=PALACIOS --ano=$a --tipo=compradores --limite=800 --rate=2 --ejecutar
done
```

---

## 6. Criterio de "lista terminada"

| Campo | Objetivo |
| :--- | ---: |
| Sede Asignada | 100% |
| Tratamiento comprado | ≥ 95% |
| Estado de Compra | ≥ 99% |
| Fecha Creación (Fecha) | ≥ 99% |
| Fecha Última Compra (compradores) | ≥ 95% |
| Fuente Última Orden (compradores) | ≥ 95% |
| Total Compras | ≥ 95% |

Cuando una sede cumple eso, su lista de SMS (sin venta y compradores) queda operativa.

---

## 7. Pendientes que no dependen del runner

1. **Desplegar** en Render para que el flujo diario (N3) mantenga los campos al día sin correr el runner.
2. **Roosevelt y Piura**: agregar `GHL_LOCATION_ID_*` y `GHL_API_KEY_*` en el `.env` local (o correr el runner desde el servidor).
3. **Consentimiento SMS**: definir campo/etiqueta `sms-optin` antes de la primera campaña.
