/**
 * LOA Engine v1.0
 * Copyright (c) 2026 LOA Agency. Todos los derechos reservados.
 * 
 * EnrichmentModule: Módulo de Enriquecimiento y Nomenclatura.
 * Construye la estructura visual requerida: Nombre - Canal - Dolencia.
 */

export class EnrichmentModule {

    /**
     * Limpia un string quitando tildes y caracteres especiales.
     */
    static cleanText(text) {
        return (text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    }

    /**
     * Genera la nomenclatura estándar para la tarjeta (Opportunity) en GHL.
     * Estructura requerida: [Nombre] - [Canal] - [Dolencia]
     * 
     * @param {Object} contact - Datos del contacto (firstName, lastName)
     * @param {Object} metaData - Datos de origen (source, pageName)
     * @param {Array} customFields - Campos personalizados de vTiger/GHL
     * @returns {string} Nomenclatura final
     */
    static generateStandardName(contact, metaData, customFields = []) {
        // 1. Nombre Completo
        let fullName = `${contact.firstName || ''} ${contact.lastName || ''}`.trim();
        if (!fullName) fullName = contact.name || 'Sin Nombre';

        // 2. Canal (Ej: FB-MSGR, IG, WA)
        let canal = 'WEB';
        if (metaData?.source?.toLowerCase().includes('messenger') || metaData?.source?.toLowerCase().includes('facebook')) {
            canal = 'FB-MSGR';
        } else if (metaData?.source?.toLowerCase().includes('instagram')) {
            canal = 'IG-DM';
        } else if (metaData?.source?.toLowerCase().includes('whatsapp')) {
            canal = 'WA';
        } else if (contact.tags && contact.tags.includes('vtiger')) {
            // Histórico de vTiger
            canal = 'FB-MSGR'; // Canal por defecto histórico según captura
        }

        // 3. Dolencia (Búsqueda en Custom Fields)
        let dolencia = 'Por definir';
        
        for (const cf of customFields) {
            // Buscar si algún campo tiene el valor de la dolencia (vTiger Producto Condicion)
            // Se puede inyectar la lógica exacta del ID del campo de Dolencia aquí
            const fieldName = String(cf.name || cf.id || '').toLowerCase();
            if (fieldName.includes('producto') || fieldName.includes('condicion') || fieldName.includes('dolencia')) {
                if (cf.value) {
                    dolencia = this.cleanText(cf.value);
                    // Capitalizar primera letra
                    dolencia = dolencia.charAt(0).toUpperCase() + dolencia.slice(1).toLowerCase();
                    break;
                }
            }
        }

        // Estructura final: Manuel Arevalo - FB-MSGR - Artritis
        return `${fullName} - ${canal} - ${dolencia}`;
    }

    /**
     * Determina el Stage ID correcto dependiendo de si tiene teléfono o no.
     */
    static determineStage(hasPhone, monetaryValue = 0) {
        // Si hay valor monetario histórico (compra)
        if (monetaryValue > 0) {
            return {
                stageId: 'b7b26459-ae47-4249-a45f-0a0c5506e30e', // Ganado
                status: 'won'
            };
        }

        // Regla Crucial: Separación por Teléfono
        if (hasPhone) {
            return {
                stageId: '5e7d5fb0-0a71-46df-aa42-912fe0b487f1', // Calificado (Con Teléfono)
                status: 'open'
            };
        } else {
            return {
                stageId: '29293e88-d26e-4095-bde9-d40aa0cf1024', // Precalificado (Chat/Sin Teléfono)
                status: 'open'
            };
        }
    }
}
