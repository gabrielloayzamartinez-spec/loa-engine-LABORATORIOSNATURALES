import asyncio
import re
from src.core.ghl_client import GHLClient
from src.core.vtiger_client import VTigerClient
from src.agent_migration.full_transformer import transform_full_vtiger_record

PIPELINE_ID = "w62fzyP9nCmTBurH4HIi"

async def rename_historical():
    ghl_client = GHLClient()
    vtiger_client = VTigerClient()
    await vtiger_client.login()
    
    url = f"opportunities/search?location_id={ghl_client.location_id}&pipeline_id={PIPELINE_ID}"
    renamed = 0
    
    print("Iniciando renombrado in-situ del Pipeline Histórico...")
    
    while url:
        try:
            res = await ghl_client._request("GET", url)
            opps = res.get("opportunities", [])
            if not opps:
                break
                
            for opp in opps:
                old_name = opp.get("name", "")
                
                # If it already has the new format, skip it
                if " - " in old_name and " | " not in old_name:
                    continue
                    
                contact_id = opp.get("contactId")
                if not contact_id:
                    continue
                    
                # Fetch contact to get vTiger ID
                c_res = await ghl_client._request("GET", f"contacts/{contact_id}")
                contact_data = c_res.get("contact", {})
                
                v_id = None
                for cf in contact_data.get("customFields", []):
                    if cf.get("id") == "PNr3LsTpXAwmyvPnvI11":
                        v_id = cf.get("value")
                        break
                        
                if not v_id:
                    continue
                    
                q = f"SELECT * FROM Contacts WHERE id = '{v_id}';"
                res_v = await vtiger_client.query(q)
                if not res_v:
                    continue
                    
                full_data = transform_full_vtiger_record(res_v[0])
                name = full_data.get("name", "Oportunidad Migrada")
                condicion = full_data["vtiger_raw"].get("condicion", "")
                canal = full_data["vtiger_raw"].get("canal_origen", "")
                monto = float(full_data["vtiger_raw"].get("monto_usd", 0))
                
                new_name = name
                if canal:
                    new_name += f" - {canal}"
                if condicion:
                    new_name += f" - {condicion}"
                    
                # Always update to ensure monetaryValue is restored to original vTiger value
                print(f"Validando: {old_name} -> {new_name} (Monto: {monto})")
                payload = {
                    "name": new_name,
                    "pipelineId": PIPELINE_ID,
                    "pipelineStageId": opp.get("pipelineStageId"),
                    "status": opp.get("status"),
                    "contactId": contact_id,
                    "monetaryValue": monto
                }
                await ghl_client.update_opportunity(opp["id"], payload)
                renamed += 1
                    
            meta = res.get("meta", {})
            next_url = meta.get("nextPageUrl")
            if next_url:
                if "services.leadconnectorhq.com/" in next_url:
                    url = next_url.split("services.leadconnectorhq.com/")[1]
                else:
                    url = next_url
            else:
                url = None
                
        except Exception as e:
            if "429" in str(e):
                await asyncio.sleep(5)
            else:
                print(f"Error: {e}")
                
    print(f"Terminado. Total renombradas: {renamed}")
    await ghl_client.close()

if __name__ == "__main__":
    asyncio.run(rename_historical())
