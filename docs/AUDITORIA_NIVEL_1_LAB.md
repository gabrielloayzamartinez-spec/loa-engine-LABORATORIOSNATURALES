# AUDITORÍA Y LABORATORIO DEL NIVEL 1 (EQUIPO DE REDES)

**Fecha:** 27-nov-2026 · **Objetivo:** que el N1 funcione para el equipo de gestión de redes trabajando **por etiquetas** (proveedor, canal, página, sede, producto), y poder probarlo en local con el servidor detenido.

---

## 1. Flujo real del Nivel 1

```
Meta (Messenger / IG / Form)
      │ webhook
      ▼
meta_webhook_agent  ──►  chat_router_agent.routeChatByContact()
      │                        │
      │                        ├─ 1. Lee el contacto y sus conversaciones (GHL)
      │                        ├─ 2. Resuelve página → PAGE_MATRIX (sede, proveedor, dueño)
      │                        ├─ 3. Resuelve campaña/adset/anuncio (Meta API + referral)
      │                        ├─ 4. Arma el ORIGEN: SEDE-PROVEEDOR-CANAL-PADECIMIENTO
      │                        ├─ 5. Calcula ETIQUETAS y CUSTOM FIELDS
      │                        └─ 6. PUT al contacto (o DRY-RUN)
      ▼
GHL: contacto con etiquetas + CF + (dueño o cola)
```

**Fuentes de disparo:** webhook (camino principal), radar (60 s, red de seguridad), trabajo del día (15 min, refresca UTM/Ad ID de hoy), N3 (cambios de vTiger).

---

## 2. Qué debe quedar en cada lead (el contrato del N1)

| Dimensión | Etiqueta / Campo | Regla |
| :--- | :--- | :--- |
| Canal | `canal-messenger`, `canal-forms`, `canal-whatsapp`, `canal-instagram`, `canal-sms` | **una sola** |
| Proveedor | `prov-ernesto`, `prov-click2ring`, `prov-in-house`, `prov-redes-2-benavides`, `prov-en-casa-g`, `prov-enzo`, `prov-up-ideas` | una, decidida por la PÁGINA (campaña como respaldo) |
| Página | `pagina-<slug>` | una, la del último chat |
| Sede | `sede-<sede>` | una (hermetismo) |
| Producto | `producto-<tratamiento>` | uno (o `producto-desconocido`) |
| Cola | — | **`cola-*` ya no se escribe** (legado) |
| Dueño | `assignedTo` | REDES según página; **null** en forms/WSP (Cola Forms) |
| CF | Sede, Tratamiento, Proveedor, Canal, Origen Lead, Ad ID, UTM, Tiene Teléfono, Última Interacción, Página/Canal del último chat | ver contrato de campos |

---

## 3. Laboratorio local (sin tocar GHL)

Herramienta: `tools/lab_n1.mjs`. Corre **el mismo router de producción** en modo `dry-run` y muestra el payload calculado.

```bash
# Un contacto (diff completo de etiquetas)
node tools/lab_n1.mjs --contacto=<idGHL>

# Una muestra de la sede, con conteo de anomalías
node tools/lab_n1.mjs --sede=PALACIOS --muestra=10 --json=scratch/n1_audit.json
```

Salida por contacto: canal, proveedor, página, asesor, `revisar-ruteo`, etiquetas que entran y salen, CF escritos.

### Resultado medido hoy (10 contactos más recientes de Palacios)

| Chequeo | Resultado |
| :--- | :--- |
| Sin canal | **0** |
| Sin página | **0** |
| Sin proveedor | **0** |
| Sin dueño | **0** |
| Sin etiquetas | **0** |
| `revisar-ruteo` | **1** |
| Errores | **0** |

Muestra real del payload:

| Contacto | Canal | Proveedor | Página | Asesor |
| :--- | :--- | :--- | :--- | :--- |
| castro perez | canal-messenger | prov-ernesto | pagina-naturales-bionatural | REDES 1 ERNESTO |
| jaime arredondo | canal-forms | prov-in-house | pagina-laboratorios-naturales-bio | Cola Forms |
| alfredo hernandez | canal-forms | prov-in-house | pagina-laboratorios-naturales-bio | Cola Forms |
| juan barajas escobar | canal-forms | prov-in-house | pagina-laboratorios-naturales-bio | Cola Forms |

**Conclusión preliminar:** el ruteo de los contactos nuevos está correcto (canal + proveedor + página + dueño). El punto a vigilar es `revisar-ruteo`.

---

## 4. Riesgos detectados (para atacar en local)

| # | Síntoma | Evidencia | Impacto en el equipo de redes |
| :--- | :--- | :--- | :--- |
| 1 | `revisar-ruteo` en leads sin evidencia de Meta | 1/10 en la muestra de hoy; **183/300 (61%)** en la auditoría de 300 contactos recientes | el asesor ve leads marcados "revisar" y pierde confianza |
| 2 | Piura sin `pagina-*` | 0,7% de 300 contactos | sus vistas por página están vacías |
| 3 | `cola-*` ya no se escribe | código vs `docs/PAGINAS_ETIQUETAS.md` | si alguien creó vistas por cola, están vacías |
| 4 | Producto `producto-desconocido` | visible en leads sin tratamiento | segmentación por producto imprecisa |
| 5 | Contactos sin teléfono | ~50% de los chats nuevos | no entran a la vista de llamadas (correcto: van a Cola Forms) |
| 6 | Varios procesos pueden re-rutear | radar 60 s + curador 15 min + N3 | reprocesos si falla el armonizador |

---

## 5. Protocolo de prueba en local (con el servidor detenido)

### 5.1 Casos que hay que probar sí o sí

| # | Caso | Qué debe pasar |
| :--- | :--- | :--- |
| 1 | Lead de Messenger de "Naturales BioNatural" | `canal-messenger`, `prov-ernesto`, `pagina-naturales-bionatural`, dueño ERNESTO |
| 2 | Lead de formulario de "Laboratorios Naturales BIO" | `canal-forms`, `prov-in-house`, **sin dueño**, Cola Forms |
| 3 | Lead de Messenger de "BioNatural - Ultra" | `prov-click2ring`, dueño ULTRA |
| 4 | Lead de campaña INHOUSE sobre página de ERNESTO | gana la página → `prov-ernesto` (regla 26/11) |
| 5 | Reingreso por otra página | se purga la etiqueta de página anterior |
| 6 | Contacto sin conversación indexada | no se marca atendido; se reintenta |
| 7 | Contacto sin teléfono | `sin-telefono` + Cola Forms |
| 8 | Contacto con compra en vTiger | `compro` + `cliente-vtiger`, sin `prospecto` |

### 5.2 Cómo ejecutarlo

```bash
# 1. Tomar 5 ids reales por caso desde GHL (Contactos → filtro por etiqueta)
# 2. Simular uno por uno
node tools/lab_n1.mjs --contacto=<id> 

# 3. O una muestra completa por sede
node tools/lab_n1.mjs --sede=PALACIOS --muestra=20 --json=scratch/n1_palacios.json
node tools/lab_n1.mjs --sede=ROOSEVELT --muestra=20 --json=scratch/n1_roosevelt.json
node tools/lab_n1.mjs --sede=PIURA     --muestra=20 --json=scratch/n1_piura.json
node tools/lab_n1.mjs --sede=BENAVIDES --muestra=20 --json=scratch/n1_benavides.json
```

### 5.3 Criterios de aprobación

| Criterio | Umbral |
| :--- | ---: |
| Canal correcto | 100% |
| Proveedor correcto según página | 100% |
| Página presente | ≥ 99% |
| `revisar-ruteo` | ≤ 5% |
| Sin etiquetas | 0% |
| Errores de simulación | 0 |

---

## 6. Qué se necesita del lado del servidor (cuando se paralice)

1. Detener Render (o pausar el radar) para que **no compita** con las pruebas locales.
2. Confirmar que el `.env` local tiene las 4 sedes (ya está).
3. Correr el laboratorio por sede y guardar los JSON.
4. Revisar juntos los casos que fallen y corregir **un archivo a la vez**.

---

## 7. Cambios ya aplicados que afectan al N1

| Cambio | Efecto |
| :--- | :--- |
| El router **ya no borra** `canal-*` | las vistas por canal dejan de parpadear |
| El router **escribe Canal Captación** | el CF de canal ya no queda vacío |
| Proveedor canónico (`etiquetaProveedor`) | evita `prov-` con tildes o formatos raros |
| Radar a 60 s y guardián apagado | menos reprocesos y cuota |
| Fecha Creación (DATE) **fuera del N1** | el N1 no la toca; la llena el N2 |
