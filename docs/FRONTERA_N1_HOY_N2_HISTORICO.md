# FRONTERA N1 (HOY) / N2 (HISTÓRICO) — REGLA DEFINITIVA

**Fecha:** 27-nov-2026 · **Regla:** el Nivel 1 atiende **solo hoy**; el Nivel 2 cubre **todo lo anterior a hoy**. La frontera es la **medianoche de Lima** (UTC-5).

---

## 1. La regla en una tabla

| Nivel | Alcance | Objetivo | Quién lo ejecuta |
| :--- | :--- | :--- | :--- |
| **N1** | **HOY** (desde 00:00 Lima) | armonía del trabajo de los asesores de redes | radar + webhooks + trabajo del día |
| **N2** | **TODO antes de HOY** (histórico hasta ayer 23:59) | toda la data de vTiger sincronizada, con todos sus CF | N2A (cobertura) + N2B (completitud) |
| **N3** | cualquier fecha, **por cambio** | que nada quede viejo cuando vTiger se corrige | tail de contactos + tail de órdenes |

**N3 no compite con la frontera:** es el mecanismo que evita "puenteos". Si mañana corrigen una compra de 2023, N3 lo detecta por `modifiedtime` y actualiza ese contacto histórico — sin que nadie tenga que correr un script.

---

## 2. Qué se implementó

### 2.1 Una sola definición de "hoy"

`src/domain/ventana_temporal.js` centraliza el cálculo (antes cada módulo recalculaba su propia medianoche y podían discrepar):

```js
inicioDiaLima()        // 05:00 UTC del día de Lima
esDeHoy(ts)            // ¿pertenece al día de hoy?
fechaLimaISO()         // 'AAAA-MM-DD' de Lima
filtroVtigerAntesDeHoy('createdtime')  // " AND createdtime < '2026-11-27 00:00:00'"
n2SoloHistorico()      // interruptor N2_HASTA_AYER (true por defecto)
```

`app.js` ya no tiene su propia copia: delega en este módulo.

### 2.2 N1 = solo hoy

En el radar (`runExpressAssignment`), después de comprobar que hay mensaje nuevo:

```js
if (mensajeMs > 0 && !esDeHoy(mensajeMs)) return;   // histórico → lo ve N2
```

Efecto: el radar **deja de re-rutear cartera vieja**. Un contacto de ayer que hoy no escribió ya no gasta ni una llamada. Si el lead de ayer escribe HOY, su `lastMessageDate` es de hoy → entra como trabajo del día.

### 2.3 N2 = histórico hasta ayer

- **Backfill de compradores**: la consulta ahora lleva `AND createdtime < 'hoy 00:00:00'`.
- **Backfill de órdenes**: mismo corte.
- Los compradores de HOY no se reprocesan en N2: los atiende N1 (si conversan) o N3 (al crearse/modificarse). **Mañana** entran solos al histórico.

Interruptor: `N2_HASTA_AYER=false` devuelve el comportamiento anterior (N2 también recorre hoy).

---

## 3. Por qué esto evita los "puenteos"

Un "puenteo" es correr un script a mano para arreglar una ficha. Ocurría porque:

1. El histórico avanzaba a 249 fichas/hora → la ficha de hace 2 años nunca llegaba.
2. Un cambio en vTiger sobre una ficha vieja no se reflejaba (el cursor ya había pasado).

Ahora:

| Antes | Ahora |
| :--- | :--- |
| N2 recorría todo mezclado, compitiendo con N1 | N2 recorre **solo el histórico** y no toca el día |
| El radar re-ruteaba cartera vieja | el radar toca **solo conversaciones de hoy** |
| Una corrección en vTiger esperaba al cursor | **N3** la publica en minutos (contacto u orden) |
| Se arreglaba a mano con scripts | no hace falta: el sistema lo detecta solo |

---

## 4. Cómo queda el día a día

```
00:00 Lima  ──►  los contactos de AYER pasan a ser HISTÓRICO (N2)
                 los de HOY son N1

Durante el día:
  N1  atiende conversaciones de hoy (webhook + radar cada 60 s)
  N3  publica cada cambio de vTiger (contactos y ventas), de cualquier fecha
  N2A avanza el histórico (antes de hoy) sin tocar el día
  N2B repara huecos de lo ya sincronizado

23:59  el día cierra; lo de hoy mañana es histórico
```

---

## 5. Verificación

```bash
# 1. La frontera (unitaria)
node src/tests/test_ventana_temporal.js      # 14 aserciones

# 2. Que N2 no procese hoy: el backfill debe reportar el corte en su consulta
#    (aparece en los logs como "createdtime < 'AAAA-MM-DD 00:00:00'")

# 3. Que N1 no toque ayer: en los logs del radar ya no aparecen contactos
#    con última conversación anterior a la medianoche.

# 4. El estado general
curl -s .../api/sync/estado
curl -s .../api/nivel2/carriles
curl -s .../api/nivel3/estado
```

**Semáforo**

| Métrica | Esperado |
| :--- | :--- |
| Contactos de ayer procesados por el radar | 0 |
| Compradores de hoy procesados por N2 | 0 |
| Cambio en vTiger sobre ficha histórica reflejado | < 5 min (N3) |
| `bucles.desperdicioPct` | < 10% |

---

## 6. Archivos

| Archivo | Cambio |
| :--- | :--- |
| `src/domain/ventana_temporal.js` | **nuevo**: única definición de "hoy" y del corte histórico |
| `src/app.js` | el radar descarta lo que no es de hoy; `inicioDiaLima` delega en el módulo |
| `src/services/vtiger_buyers_backfill.js` | filtro `createdtime < hoy` |
| `src/services/vtiger_order_history_service.js` | mismo filtro en el backfill de órdenes |
| `src/tests/test_ventana_temporal.js` | **nuevo**: 14 aserciones de frontera |
| `.env.example` | `N2_HASTA_AYER` |

**Pruebas:** 24 suites en verde · 14 aserciones de ventana · 47 de carriles/N3 · boot validado.
