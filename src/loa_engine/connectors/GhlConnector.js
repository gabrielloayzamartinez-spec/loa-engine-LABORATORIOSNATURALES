/**
 * LOA Engine v1.0
 * Copyright (c) 2026 LOA Agency. Todos los derechos reservados.
 * 
 * GhlConnector: Capa de abstracción de la API V2 de GoHighLevel.
 * Aplica la regla estricta de las 3 Acciones para máxima optimización.
 */

import { GHL_CONFIG } from '../../config/index.js';

export class GhlConnector {
    constructor() {
        this.locationId = GHL_CONFIG.locationId;
        this.headers = {
            'Authorization': `Bearer ${GHL_CONFIG.apiKey}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        this.baseUrl = 'https://services.leadconnectorhq.com';
    }

    /**
     * ACCIÓN 1: Upsert Contact
     * Crea o actualiza el contacto, inyectando etiquetas y Propietario.
     */
    async upsertContact(contactData, advisorId, tagsList) {
        const payload = {
            locationId: this.locationId,
            firstName: contactData.firstName,
            lastName: contactData.lastName,
            email: contactData.email,
            phone: contactData.phone,
            tags: tagsList,
            customFields: contactData.customFields
        };

        if (advisorId) {
            payload.assignedTo = advisorId;
        }

        const res = await fetch(`${this.baseUrl}/contacts/upsert`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error(`Error en Upsert: ${await res.text()}`);
        return await res.json();
    }

    /**
     * ACCIÓN 2: Add Notes
     * Inyecta el resumen forense o chat inicial en el perfil.
     */
    async addNote(contactId, noteBody) {
        const res = await fetch(`${this.baseUrl}/contacts/${contactId}/notes`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ body: noteBody })
        });
        
        if (!res.ok) throw new Error(`Error en AddNote: ${await res.text()}`);
        return await res.json();
    }

    /**
     * ACCIÓN 3: Create Opportunity
     * Construye la tarjeta comercial con la nomenclatura estándar.
     */
    async createOpportunity(contactId, stageData, standardizedName, advisorId) {
        const payload = {
            locationId: this.locationId,
            contactId: contactId,
            name: standardizedName,
            pipelineId: 'yDWAU0AGW3QiivEz4VJg', // Pipeline Maestro Fijo
            pipelineStageId: stageData.stageId,
            status: stageData.status
        };

        if (advisorId) {
            payload.assignedTo = advisorId;
        }

        const res = await fetch(`${this.baseUrl}/opportunities/`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error(`Error en CreateOpportunity: ${await res.text()}`);
        return await res.json();
    }
}
