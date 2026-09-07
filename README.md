# 🎯 GoHighLevel (GHL) Pipeline Maestro & Radar de Auditoría Multi-Touch

Sistema inteligente, autónomo y forense diseñado para la gestión comercial y la **auditoría de pauta de Meta Ads (Facebook/Instagram)** en GoHighLevel (GHL).

**Desarrollado y Arquitectado por: Gabriel Loayza** 🚀

---

## 🏛️ Arquitectura de Pipelines Duales en GHL

El sistema opera con **dos tableros paralelos y sincronizados en tiempo real**:

```
                      [ INTERACCIÓN DEL CLIENTE ]
                                   │
         ┌─────────────────────────┴─────────────────────────┐
         ▼                                                   ▼
┌────────────────────────────────┐         ┌────────────────────────────────┐
│  TABLERO 1: VENTAS COMERCIAL   │         │  TABLERO 2: AUDITORÍA DE PAUTA │
│    (Para los Asesores/Llamadas)│         │     (Para Gerencia y Agencia)  │
├────────────────────────────────┤         ├────────────────────────────────┤
│ 1. Precalificado (Sin Teléfono)│         │ 1. 🟢 1er Clic (Lead Nuevo X1) │
│ 2. Lead Calificado (Con Tel)   │         │ 2. 🟡 2do Clic (Reingreso X2)  │
│ 3. En Llamada / Negociación    │         │ 3. 🟠 3er Clic (Reingreso X3)  │
│ 4. Venta Cerrada (Ganado)      │         │ 4. 🔴 4to Clic+ (Saturación X4)│
│ 5. No Contesta / Descalificado │         │ 5. ⚠️ Spam / Doble Clic Rápido │
└────────────────────────────────┘         └────────────────────────────────┘
```

---

## 🌟 Características Principales

1. **Atribución Forense Multi-Touch (X1, X2, X3, X4+):**
   * Extrae los identificadores únicos globales (`messageId`, `adId`, `pageName`, `timestamps`) de cada interacción.
   * Clasifica automáticamente si es el **1er Toque** (Adquisición), **2do Toque** (Reingreso - Descuento 1), **3er Toque** (Reingreso - Descuento 2) o **4to Toque o más** (Saturación).
   * Detecta **Doble Clic Rápido / Spam** (< 15 minutos entre clics) por error de interfaz del usuario.

2. **Resolución para Agencias Herméticas:**
   * No requiere permisos de administrador ni tokens de Business Manager de agencias externas.
   * Audita directamente el ADN forense inyectado por Meta en las conversaciones y webhooks de GHL.

3. **Asignación por Asesor y Sede:**
   * Mantiene al vendedor sincronizado en ambos tableros (`assignedTo`) para que cada asesor vea sus leads propios y sus respectivos reingresos.
   * Sedes integradas: Palacios, Benavides 1, Benavides 2, Roosevelt y Piura.

4. **Notas de Auditoría Financiera y Reportes CSV:**
   * Inyecta notas en el CRM con el desglose exacto de clics, IDs de Meta y deducciones.
   * Genera archivos CSV descargables listos para la conciliación contable de facturas de marketing.

5. **Servidor 24/7 con Dashboard en Vivo:**
   * Monitoreo en tiempo real en `http://localhost:3000/health` con conteo de leads, dinero/leads ahorrados y webhooks.

---

## 🚀 Uso del Sistema

### Iniciar Servidor 24/7 y Dashboard:
```bash
npm start
```
Acceso al panel: `http://localhost:3000/health`

### Iniciar Panel de Control Interactivo (CLI):
```bash
npm run cli
```

### Ejecutar Peinado Masivo y Generar Reporte CSV:
```bash
node src/services/ad_attribution_engine.js --all
```

---
*© 2026 Gabriel Loayza - Soluciones de Automatización Avanzada y Auditoría de Call Centers.*
