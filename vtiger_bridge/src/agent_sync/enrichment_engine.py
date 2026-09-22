"""
Real-time Customer Intelligence & Enrichment Engine for GoHighLevel.
When an inbound lead enters GHL (via Facebook Ads, WhatsApp, Instagram, Web Chat),
this engine cross-references vTiger CRM, detects if it's a historical customer,
and instantly injects their purchase history, optical prescription, and VIP tags into GHL.
"""

from typing import Dict, Any, Optional
from src.core.logger import logger
from src.core.models import NormalizedContact
from src.core.ghl_client import ghl_client
from src.core.vtiger_client import vtiger_client
from src.core.phone_normalizer import normalize_phone
from src.agent_migration.transformer import transform_record
from src.agent_migration.custom_fields_provisioner import get_cached_field_map


async def enrich_ghl_contact_with_vtiger_data(ghl_contact_id: str, raw_phone: Optional[str], raw_email: Optional[str]) -> Dict[str, Any]:
    """
    Looks up contact in vTiger CRM by Phone or Email.
    If found, enriches GHL contact card with full purchase history, custom fields, and a VIP note.
    """
    clean_phone, is_valid_phone = normalize_phone(raw_phone, default_country_code="+1")
    email = (raw_email or "").strip().lower()

    if not clean_phone and not email:
        logger.info("ℹ️ Contacto en GHL sin teléfono ni email. No se puede cruzar con vTiger.")
        return {"status": "skipped", "reason": "no_identifiers"}

    logger.info(f"🔍 [Enrichment Radar] Buscando coincidencia en vTiger para: Tel={clean_phone} | Email={email}...")

    # 1. Search in vTiger by Phone or Email
    vtiger_match = None
    try:
        # Search by phone in vTiger (cleaning formatting for query)
        if clean_phone:
            digits_10 = clean_phone.lstrip("+1")
            q_phone = f"SELECT * FROM Contacts WHERE mobile LIKE '%{digits_10}%' OR phone LIKE '%{digits_10}%' LIMIT 0, 1;"
            res = await vtiger_client.query(q_phone)
            if res:
                vtiger_match = res[0]

        # Search by email if not found by phone
        if not vtiger_match and email:
            q_email = f"SELECT * FROM Contacts WHERE email = '{email}' LIMIT 0, 1;"
            res = await vtiger_client.query(q_email)
            if res:
                vtiger_match = res[0]

    except Exception as e:
        logger.error(f"❌ Error consultando vTiger CRM: {e}")
        return {"status": "error", "error": str(e)}

    # If contact is not an existing historical customer in vTiger
    if not vtiger_match:
        logger.info(f"ℹ️ [Enrichment Radar] Lead {clean_phone} es un prospecto nuevo (no existe en histórico vTiger).")
        return {"status": "new_prospect", "matched": False}

    # 2. MATCH FOUND! Retrieve full sales history from vTiger
    vtiger_id = vtiger_match.get("id")
    logger.info(f"🎯 [MATCH ENCONTRADO] El lead es cliente histórico en vTiger (ID: {vtiger_id})!")

    # Fetch purchases
    sales = []
    try:
        q_sales = f"SELECT * FROM Invoice WHERE contact_id = '{vtiger_id}';"
        sales = await vtiger_client.query(q_sales)
        if not sales:
            q_sales_order = f"SELECT * FROM SalesOrder WHERE contact_id = '{vtiger_id}';"
            sales = await vtiger_client.query(q_sales_order)
    except Exception as e:
        logger.warning(f"⚠️ No se pudieron consultar ventas para {vtiger_id}: {e}")

    # Calculate LTV and latest purchase
    last_product = "Optometría / Lentes"
    last_date = vtiger_match.get("createdtime", "")[:10]
    last_amount = 0.0
    total_spent = 0.0
    branch = vtiger_match.get("assigned_user_id", "General")

    if sales:
        sales.sort(key=lambda x: str(x.get("createdtime", "") or x.get("invoicedate", "")), reverse=True)
        latest = sales[0]
        last_product = latest.get("subject") or "Lentes Recetados"
        last_date = (latest.get("invoicedate") or latest.get("createdtime") or last_date)[:10]
        last_amount = float(latest.get("hdnGrandTotal") or latest.get("total") or 0.0)
        total_spent = sum(float(s.get("hdnGrandTotal") or s.get("total") or 0.0) for s in sales)

    # Prescription notes
    notes_parts = [f"{k}: {v}" for k, v in vtiger_match.items() if k.startswith("cf_") and v]
    prescription = " | ".join(notes_parts) if notes_parts else "Fórmula estándar en ficha clínica"

    # 3. Build enriched GHL payload
    field_map = get_cached_field_map()
    custom_fields_payload = []

    def add_cf(key: str, value: Any):
        if value is None or value == "":
            return
        ghl_field_id = field_map.get(key)
        if ghl_field_id:
            custom_fields_payload.append({"id": ghl_field_id, "field_value": value})
        else:
            custom_fields_payload.append({"key": key, "field_value": value})

    add_cf("vtiger_id_cliente", str(vtiger_id))
    add_cf("vtiger_ultima_compra_producto", last_product)
    add_cf("vtiger_fecha_ultima_compra", last_date)
    add_cf("vtiger_monto_ultima_compra", last_amount)
    add_cf("vtiger_total_historico_gastado", total_spent)
    add_cf("vtiger_sede_compra", str(branch))
    add_cf("vtiger_graduacion_notas", prescription)

    # 4. Update GHL contact card with Custom Fields & Smart Tags
    tags = [
        "cliente-historico-vtiger",
        "recontacto-activo",
        "recompra-potencial-anual"
    ]
    if total_spent >= 500 or last_amount >= 400:
        tags.append("cliente-vip-alto-valor")

    update_payload = {
        "customFields": custom_fields_payload,
        "tags": tags
    }

    try:
        # Update contact in GHL
        await ghl_client._request("PUT", f"contacts/{ghl_contact_id}", json=update_payload)
        logger.info(f"✨ [GHL Enriquecido] Ficha de contacto {ghl_contact_id} actualizada con historial vTiger!")

        return {
            "status": "enriched",
            "matched": True,
            "vtiger_id": vtiger_id,
            "last_product": last_product,
            "total_spent_usd": total_spent,
            "tags_applied": tags
        }
    except Exception as e:
        logger.error(f"❌ Error actualizando contacto en GHL: {e}")
        return {"status": "error", "error": str(e)}
