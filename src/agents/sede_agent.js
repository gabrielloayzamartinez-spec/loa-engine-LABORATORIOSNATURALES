/**
 * ==============================================================================
 * LOA ENGINE - SEDE AGENT (HERMETIC TENTACLE WORKER)
 * ==============================================================================
 * Representa un agente / worker autónomo y hermético para una subcuenta o sede específica.
 * Cada instancia encapsula:
 * - Configuración oficial (Location ID, API Keys, Pipeline, Custom Fields, Users, Fanpages)
 * - Enrutamiento y curación con Sede-Lock estricto
 * - Ciclos autónomos Forward (tiempo real) y Backward (histórico profundo)
 */

import { SEDES_GATEWAY, resolveSedeContext, getGhlHeaders, getActiveSedes } from '../config/index.js';
import { routeChatByContact } from './chat_router_agent.js';
import { runForwardCure, runBackwardCure, loadCursorState } from '../services/curador_bidireccional_service.js';

export class SedeAgent {
  constructor(sedeDescriptor) {
    if (!sedeDescriptor || !sedeDescriptor.sedeId) {
      throw new Error('SedeAgent requiere un descriptor de sede válido.');
    }
    this.sedeId = sedeDescriptor.sedeId;
    this.name = sedeDescriptor.name;
    this.vtigerSedeName = sedeDescriptor.vtigerSedeName;
    this.isActive = Boolean(sedeDescriptor.isActive);
    this.isPaused = Boolean(sedeDescriptor.isPaused);
    this.isConfigured = sedeDescriptor.isConfigured !== false;
    this.ghl = sedeDescriptor.ghl;
    this.meta = sedeDescriptor.meta;
    this.pageIds = sedeDescriptor.pageIds || [];
    this.pipeline = sedeDescriptor.pipeline;
    this.customFields = sedeDescriptor.customFields;
    this.users = sedeDescriptor.users || {};
  }

  /**
   * Enruta un contacto aplicando Sede-Lock estricto para esta sede
   */
  async routeContact(contactId, isLive = true, isDryRun = false) {
    if (this.isPaused) {
      console.log(`[SedeAgent:${this.sedeId}] [PAUSED] Sede pausada preventivamente por rate limit 429 activo en GHL.`);
      return 'PAUSED';
    }
    if (this.isConfigured === false) {
      console.warn(`[SedeAgent:${this.sedeId}] [NO-CONFIGURADA] Secreto/PIT ausente o inválido. Ruteo diferido (fail-safe).`);
      return 'RETRY';
    }
    return routeChatByContact(contactId, isLive, isDryRun, {
      locationId: this.ghl.locationId,
      sede: this.sedeId
    });
  }

  /**
   * Ejecuta un ciclo de curación Forward (tiempo real)
   */
  async runForward(options = {}) {
    if (!this.isActive || this.isPaused) return { status: 'paused', sede: this.sedeId };
    return runForwardCure(this.sedeId, options);
  }

  /**
   * Ejecuta un ciclo de curación Backward (histórico profundo)
   */
  async runBackward(options = {}) {
    if (!this.isActive || this.isPaused) return { status: 'paused', sede: this.sedeId };
    return runBackwardCure(this.sedeId, options);
  }

  /**
   * Obtiene el estado del cursor de curación
   */
  getCursorState() {
    return loadCursorState(this.sedeId);
  }
}

// Registry de agentes en memoria
const agentRegistry = new Map();

/**
 * Obtiene o crea la instancia de SedeAgent para una sede o locationId dado.
 *
 * IMPORTANTE: un nombre de sede ('PALACIOS') NO debe pasarse como locationId,
 * porque el gateway lo trataría como una subcuenta no registrada. Se decide
 * explícitamente qué campo usar según lo recibido.
 */
export function getSedeAgent(sedeIdOrLocationId = '') {
  const raw = String(sedeIdOrLocationId || '').trim();
  const isKnownSedeName = Boolean(SEDES_GATEWAY[raw.toUpperCase()]);

  const conf = isKnownSedeName
    ? resolveSedeContext({ sede: raw })
    : resolveSedeContext({ locationId: raw, sede: raw });

  if (!conf) return null;

  if (!agentRegistry.has(conf.sedeId)) {
    agentRegistry.set(conf.sedeId, new SedeAgent(conf));
  }
  return agentRegistry.get(conf.sedeId);
}

/**
 * Retorna todos los agentes correspondientes a sedes activas
 */
export function getActiveSedeAgents() {
  const activeConfigs = getActiveSedes();
  return activeConfigs.map(conf => getSedeAgent(conf.sedeId));
}
