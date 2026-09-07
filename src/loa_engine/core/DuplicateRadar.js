/**
 * LOA Engine v1.0
 * Copyright (c) 2026 LOA Agency. Todos los derechos reservados.
 * 
 * DuplicateRadar: Escudo Anti-Saturación.
 * Cachea en memoria las interacciones recientes para descontar 
 * duplicados instantáneamente sin tener que consultar a GHL.
 */

export class DuplicateRadar {
    constructor() {
        // Cache en memoria: clave (phone o Meta ID) -> { count, lastSeen, originalAdId }
        this.cache = new Map();
        // Limpiar caché cada hora para evitar desbordamiento de RAM
        setInterval(() => this.cleanCache(), 3600000); 
    }

    /**
     * Evalúa un lead entrante para detectar saturación.
     * @param {Object} leadData - { phone, metaLeadId, adId }
     * @returns {Object} { isDuplicate, touchCount, isSpam }
     */
    evaluateLead(leadData) {
        const key = leadData.phone || leadData.metaLeadId;
        if (!key) return { isDuplicate: false, touchCount: 1, isSpam: false };

        const now = Date.now();
        const record = this.cache.get(key);

        if (record) {
            // El lead ya existe en nuestra memoria
            const timeDiff = (now - record.lastSeen) / 1000; // Segundos
            
            // Si el lead hizo clic hace menos de 10 segundos, es el clásico doble-tap (SPAM puro)
            if (timeDiff <= 10) {
                return { isDuplicate: true, touchCount: record.count, isSpam: true };
            }

            // Es un reingreso legítimo pero facturablemente descontable
            record.count += 1;
            record.lastSeen = now;
            this.cache.set(key, record);

            return { isDuplicate: true, touchCount: record.count, isSpam: false };
        } else {
            // Es un lead totalmente nuevo en la ventana de memoria
            this.cache.set(key, {
                count: 1,
                lastSeen: now,
                originalAdId: leadData.adId || null
            });

            return { isDuplicate: false, touchCount: 1, isSpam: false };
        }
    }

    cleanCache() {
        const now = Date.now();
        const EXPIRATION_MS = 86400000; // 24 horas
        for (const [key, value] of this.cache.entries()) {
            if (now - value.lastSeen > EXPIRATION_MS) {
                this.cache.delete(key);
            }
        }
    }
}
