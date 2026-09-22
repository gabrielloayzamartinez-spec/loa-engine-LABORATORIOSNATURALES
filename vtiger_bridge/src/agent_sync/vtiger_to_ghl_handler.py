"""
Real-time Handler for vTiger CRM ➡️ GoHighLevel Sales & Customer Updates.
Translates real-time vTiger events into GHL Contact upserts, Custom Fields and tags.
"""

from datetime import datetime
from typing import Dict, Any
from src.core.logger import logger
from src.core.models import VTigerSaleEvent, VTigerRawRecord
from src.core.ghl_client import ghl_client
from src.core.checkpoint_manager import checkpoint_db
from src.agent_migration.transformer import transform_record
from src.agent_migration.custom_fields_provisioner import get_cached_field_map


async def process_vtiger_sale_event(event: VTigerSaleEvent) -> Dict[str, Any]:
    """Processes an incoming sale event from vTiger CRM into GoHighLevel."""
    logger.info(f"⚡ [vTiger ➡️ GHL] Ingesting sale for client: {event.customer_name} ({event.customer_phone})")
    
    # 1. Convert event to raw record structure
    raw_record = VTigerRawRecord(
        id_cliente=event.customer_id,
        nombre_completo=event.customer_name,
        telefono=event.customer_phone,
        email=event.customer_email,
        producto=event.product_name,
        fecha_compra=event.timestamp.strftime("%Y-%m-%d"),
        monto=event.amount,
        sede=event.branch_name,
        graduacion_notas=event.prescription_notes
    )

    # 2. Transform and normalize
    field_map = get_cached_field_map()
    normalized, ghl_payload = transform_record(raw_record, field_map)
    
    # Add real-time purchase tag
    ghl_payload.tags.append("compra-reciente-vtiger")
    ghl_payload.tags.append("cliente-activo")

    # 3. Upsert into GHL
    try:
        res = await ghl_client.upsert_contact(ghl_payload)
        ghl_contact_id = res.get("contact", {}).get("id") or res.get("id")

        # Save to checkpoint
        checkpoint_db.record_success(
            vtiger_id=normalized.vtiger_id,
            ghl_contact_id=str(ghl_contact_id),
            phone=normalized.phone,
            email=normalized.email,
            tags=ghl_payload.tags
        )

        logger.info(f"✅ [vTiger ➡️ GHL] Contact {normalized.first_name} synced to GHL (ID: {ghl_contact_id})")
        return {
            "status": "success",
            "ghl_contact_id": ghl_contact_id,
            "vtiger_id": normalized.vtiger_id
        }
    except Exception as e:
        logger.error(f"❌ [vTiger ➡️ GHL] Failed to sync sale event: {e}")
        checkpoint_db.record_failure(
            vtiger_id=normalized.vtiger_id,
            phone=normalized.phone,
            email=normalized.email,
            error_message=str(e)
        )
        raise


# Alias for backward compatibility
process_vtiger_sale_event = process_vtiger_sale_event
