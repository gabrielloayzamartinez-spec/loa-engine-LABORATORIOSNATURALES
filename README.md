# 🎯 Herramienta de Pipeline Maestro y Distribución GHL

Herramienta especializada para GoHighLevel que automatiza la creación de un tablero Kanban y la clasificación masiva de leads.

---

## 🏛️ Lógica de Calificación del Pipeline

1. **💬 Precalificado (Sin Teléfono / En Chat):**
   * Contactos que entraron por chat pero aún no proporcionan su número.
2. **📞 Lead Calificado (Con Teléfono / Listo para Llamar):**
   * Contactos que cuentan con número de teléfono verificado, listos para llamada comercial.
3. **⏳ En Llamada / Negociación**
4. **🎉 Venta Cerrada (Ganado)**
5. **❌ No Contesta / Descalificado**

---

## 📁 Archivos

* **`pipeline_manager.js`**: Crea y valida el Pipeline Maestro y sus etapas.
* **`distribute_contacts.js`**: Inyecta masivamente a todos los contactos en la etapa correspondiente con 10 hilos concurrentes.
* **`index.js`**: Menú interactivo en consola.
* **`ejecutar_pipeline.bat`**: Acceso directo con doble clic.
