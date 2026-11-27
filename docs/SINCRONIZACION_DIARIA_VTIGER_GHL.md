# SINCRONIZACIÓN DIARIA vTIGER → GHL (SOLO LOS CF)

**Objetivo del negocio:** que los CF de vTiger estén reflejados en GHL. Lo que exista de más en GHL no importa. vTiger se actualiza a diario.

---

## 1. Cuánto cambia vTiger en un día (medido hoy)

| Sede | Cambios en 24 h | De ellos, compradores |
| :--- | ---: | ---: |
| Palacios | 9.146 | 5.030 |
| Benavides | 2.373 | 787 |
| Roosevelt | 11.587 | 1.762 |
| Piura | 16.398 | 1.857 |
| **Total** | **39.504** | **9.436** |

*Nota: incluye la misma ficha editada varias veces en el día.*

---

## 2. Cómo se sincroniza (una sola dirección)

```
vTiger  ──►  GHL   (siempre; nunca al revés)
```

| Cuándo | Quién | Qué hace |
| :--- | :--- | :--- |
| **Cada 60 s** | **Nivel 3** | busca contactos con `modifiedtime` nuevo, relee la ficha completa y publica **todos sus CF** (modo espejo) |
| **Al crear/editar una venta** | **Nivel 3 órdenes** | encola el contacto de la orden y actualiza compras, fechas, monto y recompra |
| **De fondo** | **N2A** | recorre la cartera histórica que aún no está (solo la primera vez) |

Nada de esto borra, deduplica ni "limpia" GHL. Solo escribe.

---

## 3. Ajustes para que el día quepa en la cuota

| Parámetro | Antes | Ahora | Por qué |
| :--- | ---: | ---: | :--- |
| `NIVEL3_SOLO_COMPRADORES` | `true` | **`false`** | el objetivo es que **todos** los CF de vTiger estén en GHL, no solo los compradores |
| `NIVEL3_MAX_DIA` | 4.000 | **20.000** | el delta diario es de 39.504 cambios; con 20.000 se cubre todo el universo de compradores (9.436) y una parte grande de contactos |
| `NIVEL3_COOLDOWN_MIN` | — | **10 min** | una ficha editada 10 veces en una hora se sincroniza **una vez** (colapsa ráfagas de los asesores) |
| `NIVEL3_MAX_ATRASO_MIN` | 45 | 45 | si el atraso pasa de 45 min, el cursor salta al presente: el histórico no lo cubre el reactor |

### Cuentas de cuota

```
20.000 contactos/día × ~3,5 llamadas = ~70.000 llamadas
Nivel 1 (atención en vivo)          = ~90.000 (medido; baja al frenar el radar)
N2A (solo si queda histórico)       = resto
Techo GHL                            = 200.000/día
```

Si un día no alcanza, el reactor **salta al presente** y sigue desde ahí: nunca se queda persiguiendo un backlog viejo (eso es trabajo de N2A).

---

## 4. Qué significa "CF sincronizados"

En cada sincronización se publica el **estado actual** de vTiger (modo espejo), no un delta:

| Bloque | Campos |
| :--- | :--- |
| Identidad | nombre, teléfono, ciudad, estado |
| Enrutamiento | Sede Asignada, Sede/Tienda Compra, Tratamiento, Proveedor, Canal, Campaña, Origen Lead/Compra |
| Comercial | Estado, Etapa, Estado de Compra, Contact No, Total Compras, Precio Venta, Total Histórico, Fechas (creación DATE, primera/última compra, última factura), Asesor, Sexo |
| Atribución | Ad ID, UTM (source/medium/campaign/content/term), Conjunto, Nombre del anuncio |
| Pedido | Historial completo, Último producto, Estado de entrega, Conformidad, Forma de pago, Transportista, Tracking |
| Segmentación | Fuente Última Orden (`Mi Re-Orden` / `Primera Compra`), Fecha Creación (DATE) |

Si vTiger corrige un dato (compra anulada, fecha cambiada), el espejo lo publica: **no se queda con el valor viejo**.

---

## 5. Cómo verificar que el día se sincronizó

```bash
# 1. Estado del reactor y límites
curl -s .../api/nivel3/estado

# 2. Cobertura campo por campo de una muestra
node tools/local_sync.mjs cobertura --sede=PALACIOS --muestra=10

# 3. Que un cambio puntual llegue
#    (editar cualquier campo de un contacto en vTiger y, en < 2 min, verlo en GHL)
```

**Semáforo diario**

| Métrica | Objetivo |
| :--- | :--- |
| `limites.consumoHoy` vs `maxDia` | < 100% (si llega al 100%, subir cuota o bajar cooldown) |
| Contactos sincronizados / cambios del día | ≥ 50% (con 20.000 de 39.504) |
| Cobertura de campos en muestra | ≥ 95% |
| Atraso del cursor | < 45 min |

---

## 6. Si se quiere el 100% del delta diario

Hay dos caminos, y ambos son de negocio, no de código:

1. **Subir `NIVEL3_MAX_DIA` a 40.000** — cubre todo, pero consume ~140.000 llamadas/día y deja al Nivel 1 con poco margen.
2. **Bajar el costo del Nivel 1** (radar ya está a 60 s y el guardián apagado) para liberar cuota hacia el reactor.

Hoy el sistema está calibrado en 20.000/día para convivir con el Nivel 1 sin ahogarlo.
