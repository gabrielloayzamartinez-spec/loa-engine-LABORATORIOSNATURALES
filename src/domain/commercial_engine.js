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
  NUM_COMPRAS: '3L8KHJEp8fw8ELr081Kl'       // contact.spl_num_compras
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
  const vHasSale = vSalesCount > 0 || Boolean(vContact?.spl_fecha_primera_compra);
  const vStatus = String(vContact?.cf_994 || '').trim();
  const vStatusWon = ['vendido', 'cliente', 'cobrado'].some(s => vStatus.toLowerCase().includes(s));
  const isVtigerWon = vHasSale || vStatusWon;

  // 2. Verdad Secundaria: Tags en GHL
  const existingTags = (ghlContact.tags || []).map(t => String(t).toLowerCase());
  const isGhlWon = existingTags.includes('cliente-comprador') || existingTags.includes('venta-cerrada');

  // 3. Veredicto Final
  const isWon = Boolean(isVtigerWon || isGhlWon);

  return {
    isWon,
    commercialStatus: isWon ? 'CONVERTIDO' : 'SIN VENTA',
    contactStatus: vStatus || (isWon ? 'VENDIDO' : 'SIN TRABAJAR'),
    realFirstPurchaseDate: isWon ? (vContact?.spl_fecha_primera_compra || null) : null,
    realLastPurchaseDate: isWon ? (vContact?.spl_fecha_ultima_compra || null) : null,
    salesCount: isWon ? vSalesCount : 0,
    totalSpent: isWon ? parseFloat(vContact?.cf_3392 || vContact?.cf_3238 || '0') : 0
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

  return fields;
}
