/**
 * ==============================================================================
 * SEGMENTACIÓN DERIVADA — REGLAS DE NEGOCIO PARA LAS LISTAS INTELIGENTES DE GHL
 * ==============================================================================
 * MOTIVO (pedido 27/11/2026): las campañas internas (SMS) necesitan segmentar por
 * fecha de creación, comprador / no comprador, recompra y producto. Eso NO puede
 * depender de que alguien copie y pegue: tiene que calcularse con una regla y
 * recalcularse cuando el CRM cambie.
 *
 * REGLAS (una sola definición, usada por el sync y por la auditoría)
 *   PROSPECTO  : 0 compras confirmadas.
 *   NUEVO      : 1 compra  → "Fuente Última Orden" = 'Primera Compra'.
 *   RECOMPRA   : 2+ compras → "Fuente Última Orden" = 'Mi Re-Orden'.
 *
 * El campo "Fuente Última Orden" YA existe en GHL (Palacios y Benavides) pero no
 * tenía ningún escritor: estaba al 0%. Aquí se le da semántica y se publica.
 * ==============================================================================
 */

/** Tipos de cliente para segmentación. */
export const TIPO_CLIENTE = {
  PROSPECTO: 'PROSPECTO',
  NUEVO: 'NUEVO',
  RECOMPRA: 'RECOMPRA'
};

/** Valores del campo GHL "Fuente Última Orden". */
export const FUENTE_ORDEN = {
  PRIMERA: 'Primera Compra',
  REORDEN: 'Mi Re-Orden'
};

/**
 * Clasifica al contacto por su historial de compras (PURA).
 *
 * @param {object} p
 * @param {number} p.numCompras  compras confirmadas (spl_num_compras o nº real de órdenes)
 * @param {Array}  [p.ordenes]   órdenes normalizadas (si se conocen)
 * @returns {{tipo:string, fuenteUltimaOrden:string, esComprador:boolean, esRecompra:boolean}}
 */
export function clasificarCliente({ numCompras = 0, ordenes = null } = {}) {
  const porOrdenes = Array.isArray(ordenes) ? ordenes.length : 0;
  const n = Math.max(parseInt(numCompras, 10) || 0, porOrdenes);

  if (n <= 0) {
    return { tipo: TIPO_CLIENTE.PROSPECTO, fuenteUltimaOrden: '', esComprador: false, esRecompra: false };
  }
  if (n === 1) {
    return { tipo: TIPO_CLIENTE.NUEVO, fuenteUltimaOrden: FUENTE_ORDEN.PRIMERA, esComprador: true, esRecompra: false };
  }
  return { tipo: TIPO_CLIENTE.RECOMPRA, fuenteUltimaOrden: FUENTE_ORDEN.REORDEN, esComprador: true, esRecompra: true };
}

/**
 * Campos derivados que se publican en GHL para las Listas Inteligentes.
 * Devuelve pares lógicos (no IDs): el llamador resuelve el ID por sede.
 *
 * @param {object} p
 * @param {object} p.vContact    registro de vTiger
 * @param {number} [p.numCompras]
 * @param {Array}  [p.ordenes]
 * @param {string} [p.ultimaFechaCompra] ISO/AAAA-MM-DD
 * @returns {Array<{logico:string, valor:string}>}
 */
export function camposDerivadosDeSegmentacion({ vContact = {}, numCompras = 0, ordenes = null, ultimaFechaCompra = '' } = {}) {
  const clasif = clasificarCliente({ numCompras, ordenes });
  const salida = [];

  // Comprador / No comprador (vocabulario del negocio, NO el estado de vTiger).
  salida.push({ logico: 'estadoCompra', valor: clasif.esComprador ? 'Comprador' : 'No Comprador' });

  // Recompra: es la señal que dispara las campañas de re-orden.
  if (clasif.fuenteUltimaOrden) {
    salida.push({ logico: 'fuenteUltimaOrden', valor: clasif.fuenteUltimaOrden });
  }

  // Fecha de creación en su campo DATE (las Listas Inteligentes filtran por rango
  // de fechas; un TEXT no sirve para "entre el 1 y el 31").
  const creacion = String(vContact.createdtime || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(creacion)) {
    salida.push({ logico: 'fechaCreacionFecha', valor: creacion });
  }

  // Fecha de la última compra: alimenta "compró en los últimos N días".
  const ultima = String(ultimaFechaCompra || vContact.spl_fecha_ultima_compra || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(ultima) && clasif.esComprador) {
    salida.push({ logico: 'fechaUltimaCompra', valor: ultima });
  }

  return salida;
}

/**
 * Etiquetas de segmentación (opcionales, para vistas de conversación).
 * Se mantienen alineadas con el contrato de `domain/ghl_tags.js`: nada de ruido.
 */
export function etiquetasDeSegmentacion({ numCompras = 0, ordenes = null } = {}) {
  const clasif = clasificarCliente({ numCompras, ordenes });
  if (clasif.esRecompra) return ['recompra'];
  if (clasif.esComprador) return ['primera-compra'];
  return [];
}

/**
 * Recetas de Listas Inteligentes que estos campos habilitan.
 * Se expone para que el equipo de marketing las cree iguales en GHL.
 */
export const RECETAS_SMART_LIST = [
  {
    nombre: 'Compradores (clientes)',
    filtro: 'Estado de Compra = Comprador',
    campo: 'estadoCompra'
  },
  {
    nombre: 'No compradores (prospectos)',
    filtro: 'Estado de Compra = No Comprador',
    campo: 'estadoCompra'
  },
  {
    nombre: 'Recompra (2+ compras)',
    filtro: "Fuente Última Orden = Mi Re-Orden  (o Total Compras >= 2)",
    campo: 'fuenteUltimaOrden'
  },
  {
    nombre: 'Clientes nuevos (1 compra)',
    filtro: 'Fuente Última Orden = Primera Compra',
    campo: 'fuenteUltimaOrden'
  },
  {
    nombre: 'Creados este mes',
    filtro: 'Fecha Creación (Fecha) entre el 1 y el último día del mes',
    campo: 'fechaCreacionFecha'
  },
  {
    nombre: 'Compró en los últimos 30 días',
    filtro: 'Fecha Última Compra >= hoy − 30 días',
    campo: 'fechaUltimaCompra'
  },
  {
    nombre: 'SMS por sede y producto',
    filtro: 'Sede Asignada = <sede> Y Tratamiento comprado = <producto> Y Tiene Teléfono = Sí',
    campo: 'sedeAsignada + tratamientoComprado + tieneTelefono'
  }
];
