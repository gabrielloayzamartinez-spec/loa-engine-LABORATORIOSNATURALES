/**
 * LOA Engine v1.0
 * Copyright (c) 2026 LOA Agency. Todos los derechos reservados.
 * 
 * RoutingEngine: Motor Comercial de Asignación y Enrutamiento.
 * Se encarga de evaluar las páginas de origen y derivar el lead 
 * a la sede y asesor correcto en GoHighLevel.
 */

import { PAGE_TAG_MAP, PALACIOS_USERS } from '../../config/index.js';

export class RoutingEngine {
    
    /**
     * Identifica a qué oficina/página pertenece un lead basado en 
     * el payload de Meta (Webhook) o etiquetas históricas.
     * @param {Object} metaData - Datos del evento de Meta (pageName, adId)
     * @param {Array} existingTags - Etiquetas actuales si es un contacto histórico
     * @returns {Object} { pageName, pageTag }
     */
    static identifySourcePage(metaData, existingTags = []) {
        let detectedPageName = metaData?.pageName || null;

        // Si no viene explícito de Meta, lo buscamos en etiquetas (para rescates o cruces)
        if (!detectedPageName) {
            for (const [pageName, tag] of Object.entries(PAGE_TAG_MAP)) {
                if (existingTags.includes(tag)) {
                    detectedPageName = pageName;
                    break;
                }
            }
        }

        const pageTag = detectedPageName ? PAGE_TAG_MAP[detectedPageName] || detectedPageName.toLowerCase().replace(/[^a-z0-9]/g, ' ') : null;

        return { pageName: detectedPageName, pageTag };
    }

    /**
     * Retorna el ID de Usuario de GHL asignado para la página detectada.
     * @param {string} pageName - Nombre de la Fanpage o Sede
     * @returns {Object} { advisorId, advisorName }
     */
    static assignCommercialAdvisor(pageName) {
        let advisorId = null;
        let advisorName = null;

        if (pageName === 'Naturales BioNatural') {
            advisorId = PALACIOS_USERS['naturales bionatural'].id;
            advisorName = PALACIOS_USERS['naturales bionatural'].name;
        } else if (pageName === 'BioNatural - Ultra') {
            advisorId = PALACIOS_USERS['bionatural ultra'].id;
            advisorName = PALACIOS_USERS['bionatural ultra'].name;
        } else if (pageName === 'Naturales Bio Corp') {
            advisorId = PALACIOS_USERS['redes benavides 1'].id;
            advisorName = PALACIOS_USERS['redes benavides 1'].name;
        } else if (pageName === 'Bio Natural' || pageName === 'BioNatural Fuerza' || pageName === 'Bio Natural Salud') {
            advisorId = PALACIOS_USERS['redes benavides 2'].id;
            advisorName = PALACIOS_USERS['redes benavides 2'].name;
        } else if (pageName === 'Bio Naturales' || pageName === 'BioNatural Plus' || pageName === 'Bio Naturales Plus') {
            advisorId = PALACIOS_USERS['redes roosevelt'].id;
            advisorName = PALACIOS_USERS['redes roosevelt'].name;
        } else if (pageName === 'BioNatural' || pageName === 'Natural Bio' || pageName === 'BIO Naturales Laboratorio' || pageName === 'Laboratorios Naturales BIO') {
            advisorId = PALACIOS_USERS['redes piura'].id;
            advisorName = PALACIOS_USERS['redes piura'].name;
        }

        return { advisorId, advisorName };
    }
}
