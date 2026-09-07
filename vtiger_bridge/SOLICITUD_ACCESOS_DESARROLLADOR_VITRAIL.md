# 📩 Plantilla de Solicitud de Accesos para el Desarrollador / Administrador de Vitrail

> **Instrucciones:** Puedes copiar y pegar este mensaje directamente por correo electrónico o WhatsApp al desarrollador o responsable técnico de **Vitrail**.

---

### ✉️ Mensaje Listo para Enviar (Copiar y Pegar)

```text
Estimado equipo de desarrollo / administración de Vitrail,

Espero que se encuentren muy bien.

Les escribo para coordinar la integración técnica entre nuestra plataforma Vitrail y nuestro sistema comercial y CRM en GoHighLevel (GHL). Hemos desarrollado un middleware autónomo en Python para gestionar dos flujos clave:

1. Migración Histórica (2019 – 2026): Carga estructurada de clientes históricos y sus compras previas para campañas de recontacto y seguimiento en Estados Unidos (+1).
2. Sincronización Bidireccional en Tiempo Real: Reflejo inmediato de nuevas ventas desde Vitrail hacia GHL, y retroalimentación de citas o ventas cerradas por el call center hacia Vitrail.

Para poder conectar el middleware de manera segura y eficiente, necesitamos que por favor nos provean los siguientes accesos técnicos (según la arquitectura disponible en su servidor):

----------------------------------------------------------------------
OPCIÓN 1: Conexión mediante API REST & Webhooks (Recomendada)
----------------------------------------------------------------------
1. URL Base de la API (API Base URL / Host).
2. Credenciales de acceso (API Key, Bearer Token o credenciales OAuth2 / Client ID & Secret) con permisos de:
   - Lectura de Clientes (ID, Nombres, Teléfono US, Email, Dirección, Ciudad/Estado).
   - Lectura de Ventas / Órdenes Históricas (ID Venta, ID Cliente, Fecha, Monto en USD, Productos comprados, Sede/Store).
   - Lectura de Recetas / Graduaciones (Esfera, Cilindro, Eje, Adición, Notas).
3. Configuración de Webhook Saliente en Vitrail (Eventos de nueva venta/cliente):
   - Capacidad de disparar un POST HTTP hacia nuestro endpoint:
     URL: https://[NUESTRO_DOMINIO_MIDDLEWARE]/api/v1/vitrail/sale-event
4. Documentación o especificación de endpoints de su API (Swagger / Postman / JSON Spec).

----------------------------------------------------------------------
OPCIÓN 2: Acceso Directo a Base de Datos (Solo Lectura)
(En caso de no contar con módulo de API REST)
----------------------------------------------------------------------
1. Host / IP del servidor de Base de Datos y Puerto (ej. MySQL 3306, PostgreSQL 5432, SQL Server 1433).
2. Nombre de la base de datos (Database Name).
3. Usuario y contraseña con permisos estrictos de SOLO LECTURA (SELECT únicamente) sobre las tablas de clientes, ventas, comprobantes y recetas.
4. Si cuentan con firewall o whitelist, por favor indíquennos para suministrar la IP fija de nuestro servidor.

----------------------------------------------------------------------
OPCIÓN 3: Exportación Masiva Inicial (Para la Migración Histórica 2019-2026)
----------------------------------------------------------------------
- Archivo consolidado (CSV o Excel .xlsx) con la exportación histórica desde 2019 hasta la fecha actual con las columnas:
  [ID Cliente | Nombres | Apellidos | Celular/Teléfono US | Email | Dirección | Ciudad/Estado | Producto | Fecha Compra | Monto USD | Sede | Graduación/Notas]

Quedamos atentos a su respuesta para coordinar la prueba de control inicial con un lote piloto de 10 a 20 registros.

Muchas gracias por su apoyo y colaboración.

Saludos cordiales.
```

---

## 📋 Checklist de Datos que Debes Recibir del Desarrollador

Marca los elementos conforme el desarrollador te los entregue:

- [ ] **Tipo de Conexión Disponible:** ¿API REST (Opción 1) o Base de Datos Directa (Opción 2)?
- [ ] **URL Base o Host:** (ej. `https://api.vitrail.com/v1` o `192.168.1.XX` / IP pública)
- [ ] **Token / API Key / Credenciales:** Token alfanumérico generado en Vitrail.
- [ ] **Documentación de la API:** Enlaces a Swagger, colección de Postman o listado de tablas de la BD.
- [ ] **Webhook Habilitado:** Confirmación de si Vitrail puede enviar el evento `sale_completed` a nuestra URL.
- [ ] **Archivo de Exportación Histórica (2019-2026):** Para cargar de inmediato en la carpeta `data/input/`.
