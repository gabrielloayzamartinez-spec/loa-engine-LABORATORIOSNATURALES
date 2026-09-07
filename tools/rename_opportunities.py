import asyncio
import re
from src.core.ghl_client import GHLClient
from src.core.vtiger_client import VTigerClient
from src.agent_migration.full_transformer import transform_full_vtiger_record

PIPELINE_ID = "w62fzyP9nCmTBurH4HIi"

async def rename_existing_opps():
    ghl_client = GHLClient()
    vtiger_client = VTigerClient()
    
    try:
        await vtiger_client.login()
    except Exception as e:
        print(f"Error login vtiger: {e}")
        return

    url = f"opportunities/search?location_id={ghl_client.location_id}&pipeline_id={PIPELINE_ID}"
    renamed = 0
    
    # Matches: Name [Dolencia] | Asesor OR Name | Asesor
    pattern = re.compile(r"(.+?)(?: \[(.*?)\])? \| (.*)")
    
    while url:
        try:
            res = await ghl_client._request("GET", url)
            opps = res.get("opportunities", [])
            print(f"Página con {len(opps)} oportunidades...")
            
            for opp in opps:
                old_name = opp.get("name", "")
                
                # Check if it needs renaming (if it contains ' | ')
                if " | " in old_name:
                    # We need the contact's vTiger ID to get the canal. 
                    # The opp has contactId
                    contact_id = opp.get("contactId")
                    if not contact_id:
                        continue
                        
                    # Fetch contact from GHL to get vtiger_id
                    c_res = await ghl_client._request("GET", f"contacts/{contact_id}")
                    contact_data = c_res.get("contact", {})
                    
                    # Find vtiger_id in custom fields
                    v_id = None
                    for cf in contact_data.get("customFields", []):
                        if cf.get("id") == "PNr3LsTpXAwmyvPnvI11": # vtiger_id_cliente
                            v_id = cf.get("value")
                            break
                            
                    if not v_id:
                        continue
                        
                    # Fetch from vTiger
                    q = f"SELECT * FROM Contacts WHERE id = '{v_id}';"
                    res_v = await vtiger_client.query(q)
                    if not res_v:
                        continue
                        
                    raw_contact = res_v[0]
                    full_data = transform_full_vtiger_record(raw_contact)
                    
                    name = full_data.get("name", "Oportunidad Migrada")
                    condicion = full_data["vtiger_raw"].get("condicion", "")
                    canal = full_data["vtiger_raw"].get("canal_origen", "")
                    
                    new_name = name
                    if canal:
                        new_name += f" - {canal}"
                    if condicion:
                        new_name += f" - {condicion}"
                        
                    if new_name != old_name:
                        print(f"Renombrando: {old_name} -> {new_name}")
                        # Update opportunity
                        payload = {
                            "name": new_name,
                            "pipelineId": PIPELINE_ID,
                            "pipelineStageId": opp.get("pipelineStageId"),
                            "status": opp.get("status"),
                            "contactId": contact_id
                        }
                        await ghl_client.update_opportunity(opp["id"], payload)
                        renamed += 1
                        
            meta = res.get("meta", {})
            next_url = meta.get("nextPageUrl")
            
            if next_url:
                url = next_url.split("v1/")[1] if "v1/" in next_url else next_url
            else:
                url = None
                
        except Exception as e:
            print(f"Error: {e}")
            await asyncio.sleep(2)
            
    print(f"Total renombradas: {renamed}")
    await ghl_client.close()

if __name__ == "__main__":
    asyncio.run(rename_existing_opps())
