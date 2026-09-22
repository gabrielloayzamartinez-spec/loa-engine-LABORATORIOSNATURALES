import { resolveSedeCustomFields, resolveSedeContext } from '../config/index.js';

export function getCommercialFieldIdsForSede({ locationId = '', sede = '' } = {}) {
  const cf = resolveSedeCustomFields({ locationId, sede });
  return {
    ESTADO_COMERCIAL: cf.estadoComercial,
    STATUS_CONTACTO: cf.statusContacto,
    FECHA_ASIGNACION: cf.fechaAsignacion,
    FECHA_COMPRA: cf.fechaCompra,
    FECHA_PRIMERA_COMPRA: cf.fechaPrimeraCompra,
    FECHA_ULTIMA_COMPRA: cf.fechaUltimaCompra,
    FECHA_ULTIMA_FACTURA: cf.fechaUltimaFactura,
    PRECIO_VENTA: cf.precioVenta,
    NUM_COMPRAS: cf.numCompras,
    ESTADO_COMPRA_LISTA: cf.estadoCompraLista,
    SEDE_TIENDA_COMPRA: cf.sedeTiendaCompra,
    ANOTACIONES_REDES: cf.anotacionesRedes,
    CANAL_CAPTACION: cf.canalCaptacion,
    CONTACT_NO: cf.contactNo,
    FECHA_CREACION_VT: (sede === 'BENAVIDES' || (locationId && locationId.includes('QXcNBK6XCgpQaZ81Z8pv'))) ? cf.ultimaInteraccion : cf.fechaAsignacion,
    ID_CLIENTE_VT: cf.idCliente,
    TIENE_TELEFONO: cf.tieneTelefono,
    SEDE_ASIGNADA: cf.sedeAsignada,
    ORIGEN_LEAD: cf.origenLead,
    HISTORIAL_COMPLETO: cf.historialCompleto
  };
}

export const COMMERCIAL_FIELD_IDS = getCommercialFieldIdsForSede({ sede: 'PALACIOS' });
export const COMMERCIAL_FIELD_IDS_BENAVIDES = getCommercialFieldIdsForSede({ sede: 'BENAVIDES' });

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
  
  // [REGLA ESTRICTA]: Una compra real DEBE tener monto mayor a 0 o estatus cobrado
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
export function buildSanitizedCommercialFields(ghlContact = {}, vContact = null, locationId = null) {
  const targetLoc = locationId || ghlContact?.locationId || '';
  const isBenavides = Boolean(
    (targetLoc && targetLoc.includes('QXcNBK6XCgpQaZ81Z8pv')) ||
    (ghlContact?.locationId && ghlContact.locationId.includes('QXcNBK6XCgpQaZ81Z8pv'))
  );
  const expectedSede = isBenavides ? 'BENAVIDES' : 'PALACIOS';

  // [SEDE-SHIELD]: Validar que el vContact pertenezca a la misma sede de la subcuenta GHL
  let validVContact = vContact;
  if (validVContact && validVContact.cf_3451) {
    const vSede = String(validVContact.cf_3451).trim().toUpperCase();
    if (vSede && vSede !== expectedSede) {
      console.warn(`[CommercialEngine] [SEDE-SHIELD] Bloqueado vContact ${validVContact.id} (${vSede}) para subcuenta de ${expectedSede}.`);
      validVContact = null;
    }
  }

  const truth = evaluateCommercialTruth(ghlContact, validVContact);
  const fields = [];
  const fieldIds = getCommercialFieldIdsForSede({ locationId: targetLoc, sede: expectedSede });

  // Estado comercial y estatus del contacto
  if (fieldIds.ESTADO_COMERCIAL) {
    fields.push({
      id: fieldIds.ESTADO_COMERCIAL,
      key: 'contact.vtiger_estado_comercial',
      field_value: truth.commercialStatus
    });
  }

  if (fieldIds.STATUS_CONTACTO) {
    fields.push({
      id: fieldIds.STATUS_CONTACTO,
      key: 'contact.vtiger_status_del_contacto',
      field_value: truth.contactStatus
    });
  }

  // Campo personalizado para Listas Inteligentes
  if (fieldIds.ESTADO_COMPRA_LISTA) {
    fields.push({
      id: fieldIds.ESTADO_COMPRA_LISTA,
      key: 'contact.estado_de_compra',
      field_value: truth.isWon ? 'Comprador' : 'No Comprador'
    });
  }

  if (!truth.isWon) {
    // [PROSPECTO SIN VENTA]:
    // Purgar de raíz cualquier fecha de compra ficticia y establecer fecha de asignación limpia
    const today = new Date().toISOString().split('T')[0];
    if (fieldIds.FECHA_ASIGNACION) fields.push({ id: fieldIds.FECHA_ASIGNACION, key: 'contact.fecha_ultima_asignacion', field_value: today });
    if (fieldIds.FECHA_COMPRA) fields.push({ id: fieldIds.FECHA_COMPRA, key: 'contact.fecha_compra', field_value: '' });
    if (fieldIds.FECHA_PRIMERA_COMPRA) fields.push({ id: fieldIds.FECHA_PRIMERA_COMPRA, key: 'contact.vtiger_fecha_primera_compra', field_value: '' });
    if (fieldIds.FECHA_ULTIMA_COMPRA) fields.push({ id: fieldIds.FECHA_ULTIMA_COMPRA, key: 'contact.vtiger_fecha_ultima_compra', field_value: '' });
    if (fieldIds.FECHA_ULTIMA_FACTURA) fields.push({ id: fieldIds.FECHA_ULTIMA_FACTURA, key: 'contact.vtiger_fecha_ultima_factura', field_value: '' });
    if (fieldIds.PRECIO_VENTA) fields.push({ id: fieldIds.PRECIO_VENTA, key: 'contact.precio_venta', field_value: '' });
  } else {
    // [CLIENTE CON VENTA REAL]: Preservar fechas y totales de facturación
    if (truth.realFirstPurchaseDate) {
      if (fieldIds.FECHA_COMPRA) fields.push({ id: fieldIds.FECHA_COMPRA, key: 'contact.fecha_compra', field_value: truth.realFirstPurchaseDate });
      if (fieldIds.FECHA_PRIMERA_COMPRA) fields.push({ id: fieldIds.FECHA_PRIMERA_COMPRA, key: 'contact.vtiger_fecha_primera_compra', field_value: truth.realFirstPurchaseDate });
    }
    if (truth.realLastPurchaseDate) {
      if (fieldIds.FECHA_ULTIMA_COMPRA) fields.push({ id: fieldIds.FECHA_ULTIMA_COMPRA, key: 'contact.vtiger_fecha_ultima_compra', field_value: truth.realLastPurchaseDate });
      if (fieldIds.FECHA_ULTIMA_FACTURA) fields.push({ id: fieldIds.FECHA_ULTIMA_FACTURA, key: 'contact.vtiger_fecha_ultima_factura', field_value: truth.realLastPurchaseDate });
    }
    if (truth.salesCount > 0 && fieldIds.NUM_COMPRAS) {
      fields.push({ id: fieldIds.NUM_COMPRAS, key: 'contact.spl_num_compras', field_value: String(truth.salesCount) });
    }
    if (truth.totalSpent > 0 && fieldIds.PRECIO_VENTA) {
      fields.push({ id: fieldIds.PRECIO_VENTA, key: 'contact.precio_venta', field_value: String(truth.totalSpent.toFixed(2)) });
    }
  }

  if (validVContact) {
    // Inyección de nuevos campos extendidos de vTiger legítimos de la misma sede
    if (validVContact.cf_3451 && fieldIds.SEDE_TIENDA_COMPRA) {
      fields.push({ id: fieldIds.SEDE_TIENDA_COMPRA, key: 'contact.vtiger_sede__tienda_compra', field_value: validVContact.cf_3451 });
    }
    
    // Anotaciones Redes (incluyendo Sexo y Proveedor si existen)
    let anotaciones = String(validVContact.cf_2471 || '').trim();
    if (validVContact.cf_2821 && validVContact.cf_2821 !== '--') {
      anotaciones += ` / SEXO: ${validVContact.cf_2821}`;
    }
    if (validVContact.cf_2572) {
      let prov = String(validVContact.cf_2572).trim();
      if (/pikalex|pikales/i.test(prov)) prov = 'CLICK2RING';
      anotaciones += ` / PROVEEDOR: ${prov}`;
    }
    anotaciones = anotaciones.replace(/^ \/ /, '').trim();
    
    if (fieldIds.ANOTACIONES_REDES) {
      fields.push({ id: fieldIds.ANOTACIONES_REDES, key: 'contact.vtiger_anotaciones_redes', field_value: anotaciones });
    }

    if (validVContact.cf_3507 && fieldIds.CANAL_CAPTACION) {
      fields.push({ id: fieldIds.CANAL_CAPTACION, key: 'contact.vtiger_canal_captacion', field_value: validVContact.cf_3507 });
    }
    if (validVContact.contact_no && fieldIds.CONTACT_NO) {
      fields.push({ id: fieldIds.CONTACT_NO, key: 'contact.vtiger_contact_no', field_value: validVContact.contact_no });
    }
    if (validVContact.createdtime && fieldIds.FECHA_CREACION_VT) {
      fields.push({ id: fieldIds.FECHA_CREACION_VT, key: 'contact.vtiger_fecha_creacion', field_value: validVContact.createdtime });
    }
    if (validVContact.id && fieldIds.ID_CLIENTE_VT) {
      fields.push({ id: fieldIds.ID_CLIENTE_VT, key: 'contact.vtiger_id_cliente', field_value: validVContact.id });
    }
  } else {
    // [PURGA QUIRÚRGICA DE CAMPOS CONTAMINADOS]:
    // Si el contacto no tiene registro en vTiger para esta sede, pero en GHL tenía datos heredados erróneamente de otra oficina,
    // purgar de raíz sede ajena, contact_no ajeno, id_cliente ajeno y anotaciones de otra sede.
    const existingCFs = ghlContact.customFields || [];
    const existingSede = existingCFs.find(f => f.id === fieldIds.SEDE_TIENDA_COMPRA)?.value;
    const existingIdVT = existingCFs.find(f => f.id === fieldIds.ID_CLIENTE_VT)?.value;
    const existingContactNo = existingCFs.find(f => f.id === fieldIds.CONTACT_NO)?.value;

    if (existingSede && String(existingSede).toUpperCase().trim() !== expectedSede) {
      if (fieldIds.SEDE_TIENDA_COMPRA) fields.push({ id: fieldIds.SEDE_TIENDA_COMPRA, key: 'contact.vtiger_sede__tienda_compra', field_value: '' });
      if (existingContactNo && fieldIds.CONTACT_NO) fields.push({ id: fieldIds.CONTACT_NO, key: 'contact.vtiger_contact_no', field_value: '' });
      if (existingIdVT && fieldIds.ID_CLIENTE_VT) fields.push({ id: fieldIds.ID_CLIENTE_VT, key: 'contact.vtiger_id_cliente', field_value: '' });
      if (fieldIds.ANOTACIONES_REDES) fields.push({ id: fieldIds.ANOTACIONES_REDES, key: 'contact.vtiger_anotaciones_redes', field_value: '' });
    }
  }

  return fields;
}
