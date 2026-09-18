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
    this.isUniversalCentral = Boolean(sedeDescriptor.isUniversalCentral);
    this.allowActiveRouting = sedeDescriptor.allowActiveRouting !== false;
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
    if (!this.allowActiveRouting) {
      console.log(`[SedeAgent:${this.sedeId}] [CENTRAL GUARD] Ruteo bloqueado para cuenta pasiva.`);
      return 'UNCHANGED';
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
    if (!this.isActive) return { status: 'inactive' };
    return runForwardCure(this.sedeId, options);
  }

  /**
   * Ejecuta un ciclo de curación Backward (histórico profundo)
   */
  async runBackward(options = {}) {
    if (!this.isActive) return { status: 'inactive' };
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
 * Obtiene o crea la instancia de SedeAgent para una sede o locationId dado
 */
export function getSedeAgent(sedeIdOrLocationId = '') {
  const conf = resolveSedeContext({
    locationId: sedeIdOrLocationId,
    sede: sedeIdOrLocationId
  });
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
