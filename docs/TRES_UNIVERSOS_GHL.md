# LOS TRES UNIVERSOS DE GHL: CHATS · CONTACTOS · COMPRADORES

**Fecha:** 27-nov-2026 · **Motivo:** en GHL conviven tres poblaciones distintas y solo dos vienen de vTiger.

---

## 1. Qué es cada cosa

| Universo | Dónde nace | Tiene teléfono | Está en vTiger | Quién lo trabaja |
| :--- | :--- | :--- | :--- | :--- |
| **CHAT** | GHL (Messenger, IG, WhatsApp conectados) | **No** (al inicio) | **No** | **Nivel 1** (ruteo/etiquetas del día) |
| **CONTACTO** | vTiger (`spl_num_compras = 0`) | Sí | Sí | **Nivel 2** (histórico) + N3 (cambios) |
| **COMPRADOR** | vTiger (`spl_num_compras > 0`) | Sí | Sí | **Nivel 2** + N3 |

El puente entre los mundos es el **teléfono**. Un chat que comparte su número puede convertirse en contacto de vTiger; ahí el upsert por teléfono los une en la misma ficha de GHL.

---

## 2. Medición (muestra de 100 contactos recientes por subcuenta)

| Sede | Con par en vTiger | · compradores | · leads | Solo-chat | **Sin teléfono** |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Palacios | 37 (37%) | 1 | 36 | 12 (12%) | **51 (51%)** |
| Benavides | 16 (16%) | 1 | 15 | 1 (1%) | **83 (83%)** |

**Lectura:** la mayoría de los contactos que hoy entran a GHL **no son fichas de vTiger**: son chats de redes. En Benavides, 83 de cada 100 contactos recientes no tienen teléfono todavía.

Esto explica dos cosas que parecían anomalías:

1. **GHL tiene más contactos que vTiger** (480.592 vs 422.611): el excedente son chats.
2. **El volumen que gasta cuota no es el de vTiger, es el de chats**: por eso el radar que escaneaba todos los contactos "recientes" era tan caro — casi todos eran chats sin mensaje nuevo.

---

## 3. Regla de sincronización

```
vTiger  ──(teléfono)──►  GHL
   contactos y compradores se crean/actualizan por upsert
   
GHL (chats)  ──►  NUNCA se tocan desde vTiger
   no se borran, no se cuentan como faltantes, no se "sincronizan"
```

- **Nunca** un contacto solo-chat se considera "faltante en vTiger".
- **Nunca** el sync de vTiger borra o pisa un chat.
- Un chat **sí** recibe la actualización cuando su teléfono coincide con una ficha de vTiger (misma persona).

---

## 4. Cómo se refleja en las auditorías

`node tools/local_sync.mjs auditar --sede=PALACIOS --muestra=12` ahora clasifica cada contacto:

```json
"universos": {
  "chats": "7 (58.3%)",
  "contactos": 3,
  "compradores": 0,
  "leads solo-GHL": 2
}
```

Y la cobertura por año (`tools/cobertura_actual.mjs`) se mide **solo sobre fichas de vTiger** (compradores y contactos), nunca sobre chats.

---

## 5. Qué implica para lo que falta

| Pregunta | Respuesta medida |
| :--- | :--- |
| ¿Faltan chats por sincronizar? | **No existen en vTiger.** No hay nada que sincronizar. |
| ¿Faltan contactos (leads) de vTiger? | Cobertura ~100% en las muestras; hay **bloques aislados** (p. ej. ~60 fichas del 30-may-2023) que el cursor se saltó. |
| ¿Faltan compradores? | Cobertura ~100% en las muestras por año; mismo caso de bloques aislados. |
| ¿Roosevelt y Piura? | Sin medir: faltan `GHL_LOCATION_ID_*` en el `.env` local. |

---

## 6. Presupuesto: dónde se va la cuota

| Población | Volumen | ¿Se debe escanear? |
| :--- | ---: | :--- |
| Chats (GHL-native) | mayoría del padrón | **No**: se atienden por webhook cuando escriben |
| Contactos vTiger | 377.307 | Solo en la pasada histórica que se decida |
| Compradores vTiger | 45.753 | Sí: es la cartera que genera ingreso |

Por eso el radar quedó limitado a **conversaciones de hoy** y el escaneo masivo de contactos se retiró: escanear chats no aporta y consume cuota.
