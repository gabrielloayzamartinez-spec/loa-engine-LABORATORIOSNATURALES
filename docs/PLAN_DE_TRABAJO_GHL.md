# PLAN DE TRABAJO — Operación 100% en GHL (sin hojas de cálculo)

> **Propósito:** dejar de descargar hojas de cálculo "al aire" y que cada supervisor
> trabaje su base de datos directamente desde su usuario en GHL, con la vista limitada
> a su oficina, sobre datos sincronizados en tiempo real con el CRM madre (vTiger).

---

## 1. Objetivo

| Antes (problema) | Después (propuesta) |
| :--- | :--- |
| Descargar sheets manualmente | Trabajar directo en GHL |
| Datos desactualizados / duplicados | Datos sincronizados en tiempo real |
| Cada uno copia/pega su parte | Cada usuario ve SOLO su vista (sede) |
| Errores de manejo manual | El sistema enruta y etiqueta solo |

---

## 2. Arquitectura de datos (la base)

```
vTiger (CRM MADRE / fuente de verdad de la venta)
        │  sincronización automática
        ▼
GHL (CRM de MARKETING + ATENCIÓN EN VIVO — el lugar de trabajo diario)
```

- **vTiger** = historial, compras, órdenes, estado comercial. (fuente única)
- **GHL** = campañas SMS, chats de redes, vistas inteligentes, seguimiento.
- Ambos quedan **sincronizados en 2 niveles**:
  - **Nivel 1 (tiempo real):** cada chat de Facebook/Forms entra, se etiqueta y se enruta al momento.
  - **Nivel 2 (masivo):** los datos históricos de vTiger se vuelcan a GHL.

---

## 3. Qué YA está funcionando (para no empezar de cero)

| Componente | Estado |
| :--- | :--- |
| Compradores + leads sincronizados (4 sedes) | ✅ ~350k contactos |
| Campos completos por contacto | ✅ Sede, Estado, Proveedor, Canal, Tratamiento, Sexo, Fechas, Total Compras |
| Campo "Fuente Última Orden" (recompra) | ✅ ("Mi Re-Orden", "Lead del Dia", etc.) |
| Fechas en tipo DATE (filtrar por calendario) | ✅ |
| Etiquetas para vistas de chat | ✅ `canal-*`, `prov-*`, `pagina-*`, `producto-*` |

---

## 4. Las vistas por ROL (qué ve cada quien)

| Rol | Qué ve en GHL | Cómo se filtra |
| :--- | :--- | :--- |
| **Jefe de oficina** | todo (todas las sedes) | Smart Lists globales |
| **Supervisor de sede** | solo SU oficina | `Sede Asignada = PALACIOS` (o su sede) |
| **Asesor de redes** | solo SU canal/proveedor | vista de chat `canal-*` + `prov-*` |

### Ejemplos de Smart Lists (Contactos → SMS/marketing)
| Vista | Filtro |
| :--- | :--- |
| Clientes (compraron) | Estado Comercial = `CONVERTIDO` |
| Leads (no compraron) | Estado Comercial = `SIN VENTA` |
| Recompradores | Fuente Última Orden = `Mi Re-Orden` |
| SMS por mes | Fecha Creación (Fecha) entre `01/08/2026` y `31/08/2026` + Tiene Teléfono = `Sí` |

### Ejemplos de Vistas de chat (Conversaciones → redes)
| Vista | Etiqueta |
| :--- | :--- |
| Messenger Ernesto | `canal-messenger` + `prov-ernesto` |
| Messenger Click2Ring | `canal-messenger` + `prov-click2ring` |
| Forms Diabetes | `canal-forms` + `producto-diabetes` |

---

## 5. Plan de implementación (pasos)

| Paso | Acción | Responsable |
| :--- | :--- | :--- |
| 1 | Completar la sincronización pendiente (fechas históricas, leads de Roosevelt/Piura, re-etiquetado) | Ingeniería |
| 2 | Crear las Smart Lists + vistas de chat por sede | Ingeniería + supervisores |
| 3 | Configurar accesos por usuario (vista limitada a su sede) | Admin GHL |
| 4 | Capacitar al equipo (cómo usar sus vistas) | Supervisores |
| 5 | **Dejar de descargar sheets** | Todo el equipo |

---

## 6. Beneficios

1. **Cero hojas de cálculo** — todo se opera en GHL.
2. **Datos en tiempo real** — lo que entra en vTiger se refleja en GHL.
3. **Cada uno ve su trabajo** — sin mezclar sedes ni proveedores.
4. **Menos errores** — el sistema etiqueta y enruta solo.
5. **Campañas SMS más rápidas** — filtras por fecha/sede/estado en segundos.

---

## 7. Riesgos y cómo se evitan

| Riesgo | Mitigación |
| :--- | :--- |
| El backfill (Nivel 2) retrase los chats en vivo (Nivel 1) | el Nivel 2 corre de fondo, con freno automático que cede ante el Nivel 1 |
| Confundir etiquetas con campos | guía de vistas (etiquetas = chat; campos = contactos) |
| Ver datos de otra sede | acceso limitado por usuario (cada supervisor solo su oficina) |
| Dato desactualizado | sincronización automática + re-proceso del día cada 3 min |

---

## 8. Próximo paso sugerido

1. **Aprobar el plan** (jefe de oficina).
2. Definir la **lista de usuarios** y qué sede/canal ve cada uno.
3. Ingeniería termina la sincronización + arma las vistas.
4. Capacitación + arranque sin sheets.
