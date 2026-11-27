# CAMPO CLAVE: `contact.contactfecha_creacion_fecha` (Fecha Creación DATE)

**Fecha:** 27-nov-2026 · **Estado medido:** **0% lleno** en Palacios y Benavides (muestra de 50).

---

## 1. El campo existe en las 4 subcuentas (verificado en vivo)

| Sede | ID | Tipo | Nombre | fieldKey |
| :--- | :--- | :--- | :--- | :--- |
| Palacios | `BjRhSD5vPaQzLAzS8DSD` | DATE | Fecha Creacion (Fecha) | `contact.contactfecha_creacion_fecha` |
| Benavides | `16K68thlRzHVmCszqTtG` | DATE | Fecha Creacion (Fecha) | `contact.contactfecha_creacion_fecha` |
| Roosevelt | `VjLfeS7UdCv8XUeqkeeT` | DATE | Fecha Creacion (Fecha) | `contact.contactfecha_creacion_fecha` |
| Piura | `6QhWVxjRsDFCJwpl8jDv` | DATE | Fecha Creacion (Fecha) | `contact.contactfecha_creacion_fecha` |

La clave es **la misma en las 4**, así que el mismo filtro de Smart List sirve en todas.

**Medición de llenado (hoy):**

| Sede | Llenos | % |
| :--- | ---: | ---: |
| Palacios | 0/50 | **0%** |
| Benavides | 0/50 | **0%** |

---

## 2. Por qué estaba vacío

1. El campo no tiene valor por defecto en GHL.
2. El sincronizador solo escribía el campo **TEXT** (`Fecha Creacion`), no el **DATE**.
3. Los contactos que **nacen en GHL** (chats de Messenger) no existen en vTiger, así que nadie les ponía fecha.

---

## 3. Qué se implementó para que se llene siempre

| Origen del contacto | Quién lo llena | Con qué valor | Estado |
| :--- | :--- | :--- | :--- |
| **vTiger (comprador o lead)** | Dual Sync (N2/N3) | `createdtime` real de vTiger | ✅ código listo |
| **Chat que nace en GHL** | Router (N1) | `dateAdded` de GHL | ✅ código listo |

Además:

- La resolución del campo usa la **clave** `contact.contactfecha_creacion_fecha` como alias prioritario: aunque alguien renombre el campo en GHL, se sigue encontrando.
- El llenado de este campo **dispara el PUT** del router (antes podía quedar sin escribir si era el único cambio).

---

## 4. Lo que falta para verlo lleno

| # | Paso | Efecto |
| :--- | :--- | :--- |
| 1 | **Desplegar** | el código que escribe el campo todavía no corre en producción |
| 2 | **Re-sincronizar** la cartera (compradores y leads) | llena el campo en las fichas que ya existen |
| 3 | Verificar | `node tools/campo_fecha_creacion.mjs 50` debe dar ≥ 95% |

Los contactos **nuevos** que entren después del deploy se llenan solos (N1 para chats, N3 para vTiger).

---

## 5. Verificación

```bash
# Llenado y coincidencia con vTiger, por subcuenta
node tools/campo_fecha_creacion.mjs 50
```

Salida esperada tras desplegar y re-sincronizar:

```
PALACIOS:   48/50 con contact.contactfecha_creacion_fecha lleno (96%) · coincide con vTiger: 10/10
BENAVIDES:  49/50 (98%) · coincide con vTiger: 10/10
```

---

## 6. Ejemplo de uso en la lista inteligente

```
Fecha Creación (Fecha)  ≥  01/11/2026
Y  Sede Asignada = PALACIOS
Y  Estado de Compra = No Comprador
Y  Tiene Teléfono = Sí
```

Ese filtro es el que hoy **no devuelve nada** porque el campo está vacío; después del relleno devuelve la cartera real.
