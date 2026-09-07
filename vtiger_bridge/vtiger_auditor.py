"""
SYSTEM LABORATORIOS NATURALES by LOA
Auditor Autónomo (En Vivo) de Integridad vTiger ↔ GHL
"""

import sys
import os
import asyncio
import httpx
from datetime import datetime

# Asegurar que los módulos de la carpeta src se carguen
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.config import settings
from src.core.logger import logger
from src.core.vtiger_client import vtiger_client
from src.agent_migration.full_transformer import transform_full_vtiger_record

sys.stdout.reconfigure(encoding='utf-8')

GHL_HEADERS = {
    "Authorization": f"Bearer {settings.ghl_api_key}",
    "Version": "2021-07-28",
    "Accept": "application/json"
}

WEBHOOK_URL = "http://localhost:3000/webhook/ghl-contact"
MASTER_PIPELINE_ID = 'yDWAU0AGW3QiivEz4VJg'
EXPECTED_STAGE_GANADO = 'b7b26459-ae47-4249-a45f-0a0c5506e30e' # Venta Cerrada (Ganado)
EXPECTED_STAGE_NEGOCIACION = '41af4766-3534-49c4-8b62-6161de562a33' # En Llamada / Negociación
MONTO_FIELD_ID = '5js0Lfbh5XDLq87SDgdT'

async def fetch_vtiger_contact_by_id(vtiger_id: str):
    if not vtiger_id:
        return None
        
    q = f"SELECT * FROM Contacts WHERE id = '{vtiger_id}' LIMIT 1;"
    try:
        results = await vtiger_client.query(q)
        if results:
            return results[0]
    except Exception as e:
        logger.error(f"Error consultando vTiger por ID {vtiger_id}: {e}")
    return None

async def re_inject_to_maestro(vtiger_raw_contact):
    full_data = transform_full_vtiger_record(vtiger_raw_contact)
    v_meta = full_data["vtiger_raw"]
    
    ghl_custom_fields = [
        {"id": "PNr3LsTpXAwmyvPnvI11", "value": v_meta.get("id", "")},
        {"id": "RgE4PAKDFOP89VIZHavV", "value": v_meta.get("condicion", "")},
        {"id": "1U0XzfuI9HUQDqQVMeSV", "value": v_meta.get("fecha_ultima") or v_meta.get("fecha_primera", "")},
        {"id": "50pTZdtYYYcF1Wtz4j4s", "value": v_meta.get("estado_usa", "")},
        {"id": "cZu95uKBqVydDEh24enl", "value": full_data.get("notes", "")[:1000]},
        {"id": "WcrrCIL4A2203kIbeFsJ", "value": v_meta.get("condicion", "")},
        {"id": "5js0Lfbh5XDLq87SDgdT", "value": float(v_meta.get("monto_usd", 0.0))},
        {"id": "GZKRu2z1Z156lRUfyrpo", "value": v_meta.get("fecha_primera", "")},
        {"id": "6w3yMjLgIw6npUKWIosr", "value": v_meta.get("campana", "")},
    ]

    contact_payload = {
        "locationId": settings.ghl_location_id,
        "firstName": full_data.get("firstName", ""),
        "lastName": full_data.get("lastName", ""),
        "name": full_data.get("name", ""),
        "phone": full_data.get("phone", ""),
        "email": full_data.get("email", ""),
        "city": full_data.get("city", ""),
        "state": full_data.get("state", ""),
        "timezone": full_data.get("timezone", "America/New_York"),
        "source": full_data.get("source", "vTiger CRM"),
        "tags": full_data.get("tags", []),
        "customFields": ghl_custom_fields
    }
    
    async with httpx.AsyncClient() as client:
        res = await client.post(WEBHOOK_URL, json=contact_payload)
        if res.status_code in [200, 201, 202]:
            return True
        return False

async def run_live_auditor():
    logger.info("==================================================================")
    logger.info("🕵️‍♂️ LIVE AUDITOR INICIADO - Patrullando discrepancias GHL <-> vTiger")
    logger.info("==================================================================")
    
    logged_in = await vtiger_client.login()
    if not logged_in:
        logger.error("❌ No se pudo autenticar en vTiger CRM. Auditor detenido.")
        return

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Paginación en GHL
        next_url = f"https://services.leadconnectorhq.com/contacts/?locationId={settings.ghl_location_id}&query=vtiger&limit=50"
        
        reparados = 0
        revisados = 0
        
        while next_url:
            res = await client.get(next_url, headers=GHL_HEADERS)
            if not res.is_success:
                logger.error(f"Error consultando GHL: {res.text}")
                break
                
            data = res.json()
            contacts = data.get("contacts", [])
            
            for c in contacts:
                revisados += 1
                c_id = c.get("id")
                c_fields = c.get("customFields", [])
                
                # Check monto_usd
                needs_repair = False
                reason = []
                
                monto_val = next((cf.get("value") for cf in c_fields if cf.get("id") == MONTO_FIELD_ID), None)
                numeric_monto = 0
                if monto_val is None or str(monto_val).strip() == "":
                    needs_repair = True
                    reason.append("Monto ausente")
                else:
                    try:
                        numeric_monto = float(monto_val)
                    except ValueError:
                        pass

                target_stage = EXPECTED_STAGE_GANADO if numeric_monto > 0 else EXPECTED_STAGE_NEGOCIACION
                
                # 2. Verificar Oportunidad / Etapa
                opp_url = f"https://services.leadconnectorhq.com/opportunities/search?location_id={settings.ghl_location_id}&contact_id={c_id}"
                opp_res = await client.get(opp_url, headers=GHL_HEADERS)
                
                if opp_res.is_success:
                    opportunities = opp_res.json().get("opportunities", [])
                    m_opp = next((o for o in opportunities if o.get('pipelineId') == MASTER_PIPELINE_ID), None)
                    if m_opp:
                        current_stage = m_opp.get('pipelineStageId')
                        if current_stage != target_stage:
                            needs_repair = True
                            reason.append(f"Etapa incorrecta (actual: {current_stage}, esperada: {target_stage})")
                    else:
                        needs_repair = True
                        reason.append("Sin oportunidad en Pipeline Maestro")
                
                if needs_repair:
                    logger.warning(f"⚠️ Anomalía en {c.get('contactName', c.get('firstName'))}: {', '.join(reason)}. Intentando reparación...")
                    v_id_val = next((cf.get("value") for cf in c_fields if cf.get("id") == "PNr3LsTpXAwmyvPnvI11"), None)
                    if v_id_val:
                        v_contact = await fetch_vtiger_contact_by_id(v_id_val)
                        if v_contact:
                            success = await re_inject_to_maestro(v_contact)
                            if success:
                                logger.info(f"   ✅ Reparación exitosa: Re-inyectado al Maestro.")
                                reparados += 1
                            else:
                                logger.error(f"   ❌ Falló la re-inyección.")
                        else:
                            logger.error(f"   ❌ No se encontró en vTiger (ID: {v_id_val}).")
                    else:
                        logger.error(f"   ❌ El contacto no tiene ID de vTiger guardado en GHL.")
                
                await asyncio.sleep(0.5)
            
            next_url = data.get("meta", {}).get("nextPageUrl")
            if next_url:
                logger.info("➡️ Pasando a la siguiente página de GHL...")

        logger.info("==================================================================")
        logger.info(f"🏁 PATRULLAJE COMPLETADO. Revisados: {revisados} | Reparados: {reparados}")
        logger.info("==================================================================")

if __name__ == "__main__":
    asyncio.run(run_live_auditor())
