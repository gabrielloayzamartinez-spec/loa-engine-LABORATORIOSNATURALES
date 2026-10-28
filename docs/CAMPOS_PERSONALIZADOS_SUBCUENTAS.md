# Campos Personalizados a crear en Benavides / Roosevelt / Piura

> Lista completa de custom fields que LOA Engine escribe/lee. Crea estos campos en
> cada subcuenta GHL con **el mismo nombre** que Palacios. El motor los resuelve por
> nombre (ignora tildes y mayúsculas), pero usa estos nombres exactos para no fallar.
>
> **Tipo recomendado:** usa `TEXT` como regla general (es lo más seguro, acepta cualquier
> valor). Solo los campos marcados usan otro tipo.

---

## A. Atribución y Origen (Nivel 1 — se escriben en cada lead)

| # | Nombre del campo (GHL) | Tipo recomendado | Nota |
|---|------------------------|------------------|------|
| 1 | Origen Lead | TEXT | **Obligatorio.** Guarda `SEDE-PROVEEDOR-CANAL-PADECIMIENTO` |
| 2 | Sede Asignada | TEXT | Valores: PALACIOS / BENAVIDES / ROOSEVELT / PIURA |
| 3 | ID de Anuncio | TEXT | Ad ID numérico |
| 4 | Ad ID | TEXT | Respaldo del Ad ID |
| 5 | Nombre del Anuncio | TEXT | Nombre del creativo |
| 6 | Campaña Meta | TEXT | Nombre de la campaña |
| 7 | Conjunto de Anuncios | TEXT | Nombre del AdSet |
| 8 | UTM Source | TEXT | ej. `facebook` |
| 9 | UTM Medium | TEXT | ej. `cpc` / `messenger` |
| 10 | UTM Campaign | TEXT | Nombre de campaña |
| 11 | UTM Content | TEXT | Anuncio o tratamiento |
| 12 | UTM Term | TEXT | AdSet |
| 13 | Tratamiento Comprado | TEXT | Diabetes / Potencia / Artritis… |
| 14 | Tiene Teléfono | TEXT | `Sí` / `No` |
| 15 | Ultima Interaccion | TEXT | `YYYY-MM-DD` |
| 16 | Canal Captacion | TEXT | FB-MSGR / FORM |
| 17 | Proveedor | TEXT | ERNESTO / CLICK2RING / IN_HOUSE |
| 18 | id form clipo | TEXT | ID del formulario Lead Ads |

## B. Comerciales (Nivel 2 — se escriben al sincronizar con vTiger)

| # | Nombre del campo (GHL) | Tipo recomendado | Nota |
|---|------------------------|------------------|------|
| 19 | Estado Comercial | TEXT | SIN VENTA / GANADO… |
| 20 | Status del Contacto | TEXT | SIN TRABAJAR / TRABAJANDO… |
| 21 | Etapa Comercial | TEXT | Etapa del embudo vTiger |
| 22 | Fecha Ultima Asignacion | TEXT | fecha |
| 23 | Fecha de Compra | TEXT | fecha |
| 24 | Fecha Primera Compra | TEXT | fecha |
| 25 | Fecha Ultima Compra | TEXT | fecha |
| 26 | Fecha Ultima Factura | TEXT | fecha |
| 27 | Fecha Creacion | TEXT | fecha |
| 28 | Precio Venta | NUMERICAL | monto USD |
| 29 | Total Compras | NUMERICAL | número |
| 30 | Total Historico Gastado USD | NUMERICAL | monto acumulado |
| 31 | Estado de Compra | TEXT | Comprador / No Comprador |
| 32 | Sede Tienda Compra | TEXT | sede donde compró |
| 33 | Anotaciones Redes | TEXT | notas |
| 34 | Contact No | TEXT | número de contacto vTiger |
| 35 | ID Cliente | TEXT | id vTiger |
| 36 | Asesor Asignado | TEXT | nombre asesor |
| 37 | Sexo | TEXT | Hombre / Mujer / TERCER |
| 38 | Historial Completo | LARGE_TEXT | detalle de órdenes |

## C. Entrega y Orden (Nivel 2 — enriquecimiento de orden)

| # | Nombre del campo (GHL) | Tipo recomendado |
|---|------------------------|------------------|
| 39 | Estado de Entrega | TEXT |
| 40 | Conformidad | TEXT |
| 41 | Forma de Pago | TEXT |
| 42 | Transportista | TEXT |
| 43 | Tracking | TEXT |
| 44 | Ultimo Producto | TEXT |

---

## Notas importantes

1. **El motor no crea campos automáticamente**: hay que crearlos a mano en cada
   subcuenta GHL (Settings → Custom Fields). Si un campo falta, el motor lo omite
   sin romper (pero ese dato no quedará guardado).
2. **El nombre manda**: la resolución dinámica compara por nombre normalizado
   (sin tildes, minúsculas). Usa exactamente los nombres de arriba.
3. **Prioridad de creación**: los 18 de la sección A son los imprescindibles para el
   Nivel 1 (origen, dueño, producto, UTM). Las secciones B y C son para el trabajo
   comercial (compras/montos/historial) que ya corre en Palacios.
4. **"Origen Lead" debe ser TEXT** (contiene la cadena completa
   `PALACIOS-ERNESTO-FB-MSGR-Potencia`), no opciones.

*Generado por LOA Engine — 28/10/2026.*
