# DOCUMENTACIÓN TÉCNICA: SYSTEM LABORATORIOS NATURALES

Documento de referencia arquitectónica y operativa del sistema de integración y auditoría automatizada entre vTiger CRM y GoHighLevel (GHL).

---

## 1. Arquitectura del Sistema (Flujo de Datos)

El sistema opera bajo una arquitectura de microservicios, donde un proceso en Python actúa como extractor de datos y un servidor Node.js/Express procesa, enriquece y orquesta las peticiones hacia las APIs de GHL y Meta.

```mermaid
graph TD
    A[(vTiger CRM)] -->|Polling 120s| B(vtiger_watcher.py)
    B -->|Transformación de Payload| C{Webhook HTTP Node.js}
    C -->|POST /webhook/ghl-contact| D[server.js]
    
    D --> E[master_processor.js]
    E -->|Routing / Asignación| F(GHL Contacts & Opportunities API)
    E -->|Evaluación Multi-Touch| G(Auditoría Anti-Fraude Ads)
    E -->|Conversiones Offline| H(Meta Conversions API)
    
    F --> I[(GoHighLevel)]
    G --> I
    
    J[auto_auditor_healer.js] -.->|Cron 3600s: Validación de Integridad| I
```

---

## 2. Componentes del Sistema

### 2.1 Ecosistema de Extracción (Python: `vtiger_bridge/`)
| Módulo | Descripción Técnica | Ejecución |
| :--- | :--- | :--- |
| `vtiger_watcher.py` | Script de sincronización asíncrona (`asyncio`). Realiza polling a la base de datos de vTiger buscando registros modificados posteriores al timestamp almacenado en `last_sync_state.json`. Formatea el payload y ejecuta un POST request hacia el Maestro Node.js. | Proceso daemon continuo (`npm start`). |
| `exportar_todos_contactos_ghl.py`| Utilidad de respaldo. Extrae lotes masivos de la base de datos completa y los persiste en formato CSV. Optimizado para migraciones manuales sin afectar la cuota de API (Rate Limits). | Ejecución manual (`npm run vtiger:export`). |
- **Columna 1: Precalificado (Sin Teléfono / En Chat)** (Solo Leads Nuevos de Meta sin teléfono)
- **Columna 2: PARA CONTACTAR ahora (Con Teléfono)** (Solo Leads Nuevos de Meta con teléfono)
- **Columna 3: PARA REMARKETING (contactos antiguos)** (Solo contactos de vTiger con $0 de compras)
- **Columna 4: Venta Cerrada (Ganado)** (Solo contactos de vTiger con compras mayores a $0).

### 2.2 Ecosistema de Orquestación (Node.js)
| Módulo | Descripción Técnica | Ejecución |
| :--- | :--- | :--- |
| `server.js` | Servidor Express. Punto de entrada de los webhooks y servidor de estado interno (`http://localhost:3000/health`). | Proceso principal. |
| `master_processor.js` | Motor de reglas de negocio. Procesa el payload entrante, evalúa el historial de conversaciones de Facebook para enrutamiento, analiza duplicados/reingresos y ejecuta solicitudes HTTP hacia GHL para la creación/actualización de Oportunidades. | Por cada webhook (Evento). |
| `auto_auditor_healer.js` | Job en background. Ejecuta consultas paginadas a GHL de forma periódica para auditar la consistencia del pipeline (etapas, etiquetas) corrigiendo desajustes causados por intervención humana. | Cron de 1 hora. |
| `meta_api_service.js` | Cliente HTTP para la Meta Conversions API (CAPI). Envía eventos offline para optimización de exclusiones en campañas publicitarias. | Tras inserción exitosa. |
| `pipeline_manager.js` | Script de inicialización (Idempotente). Verifica y crea estructuras requeridas (Pipelines/Stages) en GHL si estas no existen en el entorno. | On-boot. |

---

### 2.3 Niveles de sincronización (N1 · N2A · N2B · N3)

El motor separa el trabajo por **prioridad y objetivo**. Todos escriben con el MISMO
contrato de campos y etiquetas (`src/domain/ghl_tags.js`).

| Nivel | Objetivo | Qué corre | Cadencia | Cuota |
| :--- | :--- | :--- | :--- | :--- |
| **N1** | Atención en vivo (Meta) | radar, router, webhooks, trabajo del día | 5 s / 3 min | prioridad absoluta (reserva intocable) |
| **N2A** | **Cobertura** (histórico) | backfill de compradores, leads backfill, sales bridge | continuo por cursor | resto del fondo; manda sobre N2B |
| **N2B** | **Completitud** (reconciliación) | re-llenado comercial, curador de estándar, order history | 15–20 min | lote corto; cede ante N2A |
| **N3** | **Frescura** (reactivo vTiger) | un cambio de vTiger = una ficha completa en GHL | 60 s | tope `NIVEL3_MAX_DIA` (4.000/día) |

- **N2 partido en dos carriles** (`src/services/ciclo_operativo.js`): un carril a la
  vez, y si ambos quieren arrancar gana el histórico. Antes un solo turno hacía que
  el re-llenado le robara el turno al backfill.
- **N3 reemplaza al demonio inverso** (`src/services/nivel3_reactive_sync.js`):
  idempotente por `sede:id:modifiedtime`, con Sede-Lock y salto de cursor si el
  atraso supera 45 min. El demonio antiguo queda detrás de
  `VTIGER_REVERSE_SYNC_ENABLED=true`.
- **Paneles:** `GET /api/nivel2/carriles`, `GET /api/nivel3/estado`,
  `GET /api/sync/estado`, `GET /api/auditoria/contrato-sync`.

---

## 3. Protocolo de Modificaciones y Desarrollo (Sandbox)

Para preservar la integridad del entorno de producción, las modificaciones al código core (ej. lógica de deduplicación, asignación de asesores) deben seguir un flujo estricto de desarrollo modular:

1. **Extracción y Aislamiento:**
   Solicitar la extracción del módulo/función objetivo hacia un script de pruebas aislado dentro del directorio `scratch/` (Ej: `scratch/test_module.js`).
2. **Pruebas en Entorno Local (Sandbox):**
   Desarrollar y ejecutar pruebas unitarias con mocks o payloads de prueba locales (sin invocar APIs de producción) utilizando el comando `node scratch/test_module.js`.
3. **Despliegue (Plug & Play):**
   Tras la validación técnica exitosa, inyectar y refactorizar el código validado en el módulo original de producción (ej. `master_processor.js`) y reiniciar los servicios.

---

## 4. Referencia de Comandos Operativos

- **Inicialización Concurrente (Daemon):**
  Ejecuta de forma paralela los entornos Node.js y Python.
  ```bash
  npm start
  ```
- **Exportación Masiva (Migración Segura):**
  Generación de archivos CSV omitiendo el procesamiento del webhook.
  ```bash
  npm run vtiger:export
  ```
- **Monitoreo Local:**
  Endpoint de telemetría y métricas operativas de la instancia Node.js.
  - `http://localhost:3000/health`
