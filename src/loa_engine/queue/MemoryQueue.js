/**
 * LOA Engine v1.0
 * Copyright (c) 2026 LOA Agency. Todos los derechos reservados.
 * 
 * MemoryQueue: Sistema de Colas Inteligente en Memoria.
 * Reemplaza el antiguo y agresivo poller de 15 segundos. 
 * Actúa como amortiguador para que los Webhooks de Meta se procesen 
 * ordenadamente sin saturar el Límite de API de GHL.
 */

import { DuplicateRadar } from '../core/DuplicateRadar.js';
import { RoutingEngine } from '../core/RoutingEngine.js';
import { EnrichmentModule } from '../core/EnrichmentModule.js';
import { GhlConnector } from '../connectors/GhlConnector.js';

export class MemoryQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        
        // Inicializamos los subsistemas del motor
        this.radar = new DuplicateRadar();
        this.ghl = new GhlConnector();
    }

    /**
     * Encola un nuevo Webhook entrante de Meta
     */
    enqueue(webhookPayload) {
        this.queue.push({
            payload: webhookPayload,
            timestamp: Date.now()
        });

        // Auto-arrancar el procesador si está dormido
        if (!this.isProcessing) {
            this.processQueue();
        }
    }

    /**
     * Procesador en bucle FIFO
     */
    async processQueue() {
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const item = this.queue.shift();
            try {
                await this.executeCommercialLogic(item.payload);
            } catch (error) {
                console.error(`[LOA Queue Error] Fallo al procesar lead: ${error.message}`);
                // Podríamos implementar lógica de reintentos aquí (Dead Letter Queue)
            }

            // Descanso de cortesía de 300ms entre leads para no ahogar la API de GHL (Rate Limit seguro)
            await new Promise(r => setTimeout(r, 300));
        }

        this.isProcessing = false;
    }

    /**
     * La Orquestación Comercial (El Viaje del Lead)
     */
    async executeCommercialLogic(payload) {
        const contactData = payload.contact || payload;
        const metaData = payload.meta || {};

        // 1. Detección de Duplicados en Memoria (0 latencia)
        const radarResult = this.radar.evaluateLead({
            phone: contactData.phone,
            metaLeadId: metaData.leadId,
            adId: metaData.adId
        });

        if (radarResult.isSpam) {
            console.log(`[SPAM BLOCKED] Lead ignorado por doble-tap instantáneo: ${contactData.phone}`);
            return; 
        }

        // 2. Enrutamiento Comercial
        const { pageName, pageTag } = RoutingEngine.identifySourcePage(metaData, contactData.tags);
        const { advisorId, advisorName } = RoutingEngine.assignCommercialAdvisor(pageName);

        // 3. Generación de Nomenclaturas y Etiquetas
        const tags = contactData.tags || [];
        if (pageTag && !tags.includes(pageTag)) tags.push(pageTag);
        
        // Etiqueta de facturación si es reingreso
        if (radarResult.touchCount > 1) {
            tags.push(`reingreso-x${radarResult.touchCount}`);
        }

        const standardizedName = EnrichmentModule.generateStandardName(contactData, metaData, contactData.customFields);
        const stageData = EnrichmentModule.determineStage(Boolean(contactData.phone));

        // 4. Salida Optimizada (3 Acciones API a GHL)
        
        // ACCIÓN 1: Upsert Contact
        const upsertedContact = await this.ghl.upsertContact(contactData, advisorId, tags);
        const ghlContactId = upsertedContact.contact.id;

        // ACCIÓN 2: Nota Forense (Solo si es reingreso o hay datos extra)
        if (radarResult.touchCount > 1 || metaData.adId) {
            const noteText = `[Auditoría Inteligente] Clic #${radarResult.touchCount} | Origen: ${pageName || 'Desconocido'} | AdID: ${metaData.adId || 'N/A'}`;
            await this.ghl.addNote(ghlContactId, noteText);
        }

        // ACCIÓN 3: Create Opportunity
        await this.ghl.createOpportunity(ghlContactId, stageData, standardizedName, advisorId);

        console.log(`[LOA Engine ✔] ${standardizedName} -> Sede: ${pageName} -> Asesor: ${advisorName}`);
    }
}
