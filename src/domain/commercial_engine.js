/**
 * LOA ENGINE - DOMAIN SERVICE: COMMERCIAL STATUS ENGINE
 * 
 * Centraliza la única fuente de la verdad para el estado comercial de contactos.
 * Garantiza que prospectos sin compras en vTiger nunca tengan fechas de compra falsas,
 * y que clientes reales convertidos mantengan su historial de facturación íntegro.
 */

export const COMMERCIAL_FIELD_IDS = {
  ESTADO_COMERCIAL: '8EQtKkiW7Z022bcN0vhS', // contact.vtiger_estado_comercial
  STATUS_CONTACTO: '5TY5AIOpu1c8f6WosyF2',  // contact.vtiger_status_del_contacto
  FECHA_ASIGNACION: 'RLxFOTXkICXLWShjaLaB', // contact.fecha_ultima_asignacion
  FECHA_COMPRA: 'GZKRu2z1Z156lRUfyrpo',     // contact.fecha_compra
  FECHA_PRIMERA_COMPRA: 'OJYOXVqKp33A6T5HZK5I', // contact.vtiger_fecha_primera_compra
  FECHA_ULTIMA_COMPRA: 'cyn0Ar7GMvmzYBKw0SJu',  // contact.vtiger_fecha_ultima_compra
  FECHA_ULTIMA_FACTURA: '1U0XzfuI9HUQDqQVMeSV', // contact.vtiger_fecha_ultima_factura
  PRECIO_VENTA: '5js0Lfbh5XDLq87SDgdT',     // contact.precio_venta
  NUM_COMPRAS: '3L8KHJEp8fw8ELr081Kl',      // contact.spl_num_compras
  ESTADO_COMPRA_LISTA: 'jfaxRCXTLZQCuzsTl49v', // contact.estado_de_compra (Smart List Filter)
  
  // Nuevos Campos Extendidos
  SEDE_TIENDA_COMPRA: '50pTZdtYYYcF1Wtz4j4s',  // vTiger Sede / Tienda Compra (cf_3451)
  ANOTACIONES_REDES: 'lvPAFxRot6hrsBztMkLn',   // vTiger Anotaciones Redes (cf_2471)
  CANAL_CAPTACION: 'PzuJCcBcrnu4oUq1zLnN',     // vTiger Canal Captacion (cf_3507)
  CONTACT_NO: 'eBE29SIhviHr2yDJT1Y6',          // vTiger Contact No (contact_no)
  FECHA_CREACION_VT: 'EulM7Gjuxt63t9i7qr1y',   // vTiger Fecha Creacion (createdtime)
  ID_CLIENTE_VT: 'PNr3LsTpXAwmyvPnvI11'        // vTiger ID Cliente (id)
};

/**
 * Evalúa la verdad comercial de un contacto contrastando vTiger CRM y GoHighLevel.
 * @param {Object} ghlContact - Objeto de contacto de GHL
 * @param {Object|null} vContact - Objeto de contacto de vTiger (si existe)
 * @returns {Object} Veredicto comercial unificado
 */
export function evaluateCommercialTruth(ghlContact = {}, vContact = null) {
  // 1. Verdad de Facturación en vTiger CRM
  const vSalesCount = parseInt(vContact?.spl_num_compras || '0', 10);
  const totalSpent = parseFloat(vContact?.cf_3392 || vContact?.cf_3238 || '0');
  
  const vStatus = String(vContact?.cf_994 || '').trim();
  const vStatusWon = ['vendido', 'cliente', 'cobrado'].some(s => vStatus.toLowerCase().includes(s));
  
  // 🛡️ REGLA ESTRICTA: Una compra real DEBE tener monto mayor a 0 o estatus cobrado
  const isVtigerWon = (vSalesCount > 0 && totalSpent > 0) || vStatusWon;

  // 2. Verdad Secundaria: Tags en GHL
  const existingTags = (ghlContact.tags || []).map(t => String(t).toLowerCase());
  const isGhlWon = existingTags.includes('cliente-comprador') || existingTags.includes('venta-cerrada');

  // 3. Veredicto Final: AUTORIDAD DE VTIGER
  let isWon = false;
  if (vContact) {
    // Si existe en vTiger, vTiger TIENE LA ÚLTIMA PALABRA. Cura las ventas falsas de $0 de GHL.
    isWon = isVtigerWon;
  } else {
    // Si aún no está en vTiger, confiamos temporalmente en GHL.
    isWon = isGhlWon;
  }

  return {
    isWon,
    commercialStatus: isWon ? 'CONVERTIDO' : 'SIN VENTA',
    contactStatus: vStatus || (isWon ? 'VENDIDO' : 'SIN TRABAJAR'),
    realFirstPurchaseDate: isWon ? (vContact?.spl_fecha_primera_compra || null) : null,
    realLastPurchaseDate: isWon ? (vContact?.spl_fecha_ultima_compra || null) : null,
    salesCount: isWon ? vSalesCount : 0,
    totalSpent: isWon ? totalSpent : 0
  };
}

/**
 * Genera el conjunto de customFields sanitizados para actualizar en GHL.
 * Si es SIN VENTA: purga fechas y precios falsos.
 * Si es CONVERTIDO: preserva los datos de compra reales.
 * @param {Object} ghlContact 
 * @param {Object|null} vContact 
 * @returns {Array<Object>} Lista de campos con { id, key, field_value }
 */
export function buildSanitizedCommercialFields(ghlContact = {}, vContact = null) {
  const truth = evaluateCommercialTruth(ghlContact, vContact);
  const fields = [];

  // Estado comercial y estatus del contacto
  fields.push({
    id: COMMERCIAL_FIELD_IDS.ESTADO_COMERCIAL,
    key: 'contact.vtiger_estado_comercial',
    field_value: truth.commercialStatus
  });

  fields.push({
    id: COMMERCIAL_FIELD_IDS.STATUS_CONTACTO,
    key: 'contact.vtiger_status_del_contacto',
    field_value: truth.contactStatus
  });

  // Campo personalizado para Listas Inteligentes
  fields.push({
    id: COMMERCIAL_FIELD_IDS.ESTADO_COMPRA_LISTA,
    key: 'contact.estado_de_compra',
    field_value: truth.isWon ? 'Comprador' : 'No Comprador'
  });

  if (!truth.isWon) {
    // 🛡️ PROSPECTO SIN VENTA:
    // Purgar de raíz cualquier fecha de compra ficticia y establecer fecha de asignación limpia
    const today = new Date().toISOString().split('T')[0];
    fields.push({ id: COMMERCIAL_FIELD_IDS.FECHA_ASIGNACION, key: 'contact.fecha_ultima_asignacion', field_value: today });
    fields.push({ id: COMMERCIAL_FIELD_IDS.FECHA_COMPRA, key: 'contact.fecha_compra', field_value: '' });
    fields.push({ id: COMMERCIAL_FIELD_IDS.FECHA_PRIMERA_COMPRA, key: 'contact.vtiger_fecha_primera_compra', field_value: '' });
    fields.push({ id: COMMERCIAL_FIELD_IDS.FECHA_ULTIMA_COMPRA, key: 'contact.vtiger_fecha_ultima_compra', field_value: '' });
    fields.push({ id: COMMERCIAL_FIELD_IDS.FECHA_ULTIMA_FACTURA, key: 'contact.vtiger_fecha_ultima_factura', field_value: '' });
    fields.push({ id: COMMERCIAL_FIELD_IDS.PRECIO_VENTA, key: 'contact.precio_venta', field_value: '' });
  } else {
    // 👑 CLIENTE CON VENTA REAL: Preservar fechas y totales de facturación
    if (truth.realFirstPurchaseDate) {
      fields.push({ id: COMMERCIAL_FIELD_IDS.FECHA_COMPRA, key: 'contact.fecha_compra', field_value: truth.realFirstPurchaseDate });
      fields.push({ id: COMMERCIAL_FIELD_IDS.FECHA_PRIMERA_COMPRA, key: 'contact.vtiger_fecha_primera_compra', field_value: truth.realFirstPurchaseDate });
    }
    if (truth.realLastPurchaseDate) {
      fields.push({ id: COMMERCIAL_FIELD_IDS.FECHA_ULTIMA_COMPRA, key: 'contact.vtiger_fecha_ultima_compra', field_value: truth.realLastPurchaseDate });
      fields.push({ id: COMMERCIAL_FIELD_IDS.FECHA_ULTIMA_FACTURA, key: 'contact.vtiger_fecha_ultima_factura', field_value: truth.realLastPurchaseDate });
    }
    if (truth.salesCount > 0) {
      fields.push({ id: COMMERCIAL_FIELD_IDS.NUM_COMPRAS, key: 'contact.spl_num_compras', field_value: String(truth.salesCount) });
    }
    if (truth.totalSpent > 0) {
      fields.push({ id: COMMERCIAL_FIELD_IDS.PRECIO_VENTA, key: 'contact.precio_venta', field_value: String(truth.totalSpent.toFixed(2)) });
    }
  }

  if (vContact) {
    // Inyección de nuevos campos extendidos de vTiger
    if (vContact.cf_3451) {
      fields.push({ id: COMMERCIAL_FIELD_IDS.SEDE_TIENDA_COMPRA, key: 'contact.vtiger_sede__tienda_compra', field_value: vContact.cf_3451 });
    }
    
    // Anotaciones Redes (incluyendo Sexo y Proveedor si existen)
    let anotaciones = String(vContact.cf_2471 || '').trim();
    if (vContact.cf_2821 && vContact.cf_2821 !== '--') {
      anotaciones += ` / SEXO: ${vContact.cf_2821}`;
    }
    if (vContact.cf_2572) {
      anotaciones += ` / PROVEEDOR: ${vContact.cf_2572}`;
    }
    anotaciones = anotaciones.replace(/^ \/ /, '').trim(); // Clean leading slash if cf_2471 was empty
    
    if (anotaciones) {
      fields.push({ id: COMMERCIAL_FIELD_IDS.ANOTACIONES_REDES, key: 'contact.vtiger_anotaciones_redes', field_value: anotaciones });
    }

    if (vContact.cf_3507) {
      fields.push({ id: COMMERCIAL_FIELD_IDS.CANAL_CAPTACION, key: 'contact.vtiger_canal_captacion', field_value: vContact.cf_3507 });
    }
    if (vContact.contact_no) {
      fields.push({ id: COMMERCIAL_FIELD_IDS.CONTACT_NO, key: 'contact.vtiger_contact_no', field_value: vContact.contact_no });
    }
    if (vContact.createdtime) {
      fields.push({ id: COMMERCIAL_FIELD_IDS.FECHA_CREACION_VT, key: 'contact.vtiger_fecha_creacion', field_value: vContact.createdtime });
    }
    if (vContact.id) {
      fields.push({ id: COMMERCIAL_FIELD_IDS.ID_CLIENTE_VT, key: 'contact.vtiger_id_cliente', field_value: vContact.id });
    }
  }

  return fields;
}
