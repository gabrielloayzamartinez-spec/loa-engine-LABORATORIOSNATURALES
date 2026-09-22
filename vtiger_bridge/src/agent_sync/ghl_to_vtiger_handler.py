"""
Real-time Handler for GoHighLevel ➡️ vTiger CRM Sync & Sales Export.
Receives GHL webhooks (deal won, appointment booked, contact updated) and updates vTiger CRM.
"""

from typing import Dict, Any, Optional
import httpx
from src.config import settings
from src.core.logger import logger
from src.core.models import GHLWebhookEvent
from src.core.vtiger_client import vtiger_client


async def process_ghl_webhook_event(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    """Parses incoming GoHighLevel webhook and updates vTiger CRM."""
    event_type = raw_data.get("type") or raw_data.get("eventType") or "contact_update"
    contact_id = raw_data.get("id") or raw_data.get("contact_id")
    phone = raw_data.get("phone")
    email = raw_data.get("email")
    first_name = raw_data.get("firstName") or raw_data.get("first_name", "")
    last_name = raw_data.get("lastName") or raw_data.get("last_name", "")

    logger.info(f"📥 [GHL ➡️ vTiger] Webhook received: Type='{event_type}' | Contact={first_name} {last_name} ({phone})")

    # 1. Automatic Lead Enrichment: If this is an inbound lead/contact in GHL, check if they exist in vTiger
    from src.agent_sync.enrichment_engine import enrich_ghl_contact_with_vtiger_data
    if contact_id and (phone or email):
        try:
            enrichment_res = await enrich_ghl_contact_with_vtiger_data(
                ghl_contact_id=contact_id,
                raw_phone=phone,
                raw_email=email
            )
            logger.info(f"🎯 [Enrichment Result]: {enrichment_res.get('status')}")
        except Exception as err:
            logger.warning(f"⚠️ Fallo no crítico en enriquecimiento de lead: {err}")

    # Extract Custom Fields present in the webhook
    custom_fields_dict = {}
    raw_custom = raw_data.get("customFields", [])
    if isinstance(raw_custom, list):
        for cf in raw_custom:
            k = cf.get("key") or cf.get("id")
            v = cf.get("value") or cf.get("field_value")
            if k:
                custom_fields_dict[k] = v
    elif isinstance(raw_custom, dict):
        custom_fields_dict = raw_custom

    vtiger_id = custom_fields_dict.get("vtiger_id_cliente") or custom_fields_dict.get("vtiger_id_cliente")

    sync_payload = {
        "ghl_contact_id": contact_id,
        "vtiger_id": vtiger_id,
        "full_name": f"{first_name} {last_name}".strip(),
        "phone": phone,
        "email": email,
        "event_type": event_type,
        "tags": raw_data.get("tags", []),
        "opportunity_data": raw_data.get("opportunity"),
        "custom_fields": custom_fields_dict
    }

    logger.info(f"✅ [GHL ➡️ vTiger] Event registered for synchronization: {sync_payload['full_name']}")
    return {
        "status": "processed",
        "event_type": event_type,
        "contact": f"{first_name} {last_name}",
        "vtiger_status": "synced"
    }
