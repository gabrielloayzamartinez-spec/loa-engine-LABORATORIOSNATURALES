import asyncio
from src.core.ghl_client import GHLClient
from src.core.vtiger_client import VTigerClient
from src.agent_migration.full_transformer import transform_full_vtiger_record

# Pipeline historico que Robot 2 ya esta procesando con el nuevo formato. 
# Lo saltamos para evitar retrabajo/colisiones.
EXCLUDE_PIPELINE = "w62fzyP9nCmTBurH4HIi"

async def rename_all_pipelines():
    ghl_client = GHLClient()
    vtiger_client = VTigerClient()
    
    await vtiger_client.login()
    
    # Obtener todos los pipelines
    print("Obteniendo todos los pipelines...")
    res_pipes = await ghl_client._request("GET", f"opportunities/pipelines?locationId={ghl_client.location_id}")
    pipelines = res_pipes.get("pipelines", [])
    
    renamed_total = 0
    
    for pipeline in pipelines:
        pipeline_id = pipeline["id"]
        if pipeline_id == EXCLUDE_PIPELINE:
            continue
            
        print(f"\n--- Procesando Pipeline: {pipeline.get('name', pipeline_id)} ---")
        
        url = f"opportunities/search?location_id={ghl_client.location_id}&pipeline_id={pipeline_id}"
        
        while url:
            try:
                res = await ghl_client._request("GET", url)
                opps = res.get("opportunities", [])
                
                if not opps:
                    break
                    
                print(f"  Analizando página con {len(opps)} oportunidades...")
                
                for opp in opps:
                    old_name = opp.get("name", "")
                    
                    # Omitir si ya tiene formato Nombre - Canal - Dolencia (chequeo simple)
                    if " - " in old_name and " | " not in old_name:
                        continue
                        
                    contact_id = opp.get("contactId")
                    if not contact_id:
                        continue
                        
                    # Fetch contact
                    c_res = await ghl_client._request("GET", f"contacts/{contact_id}")
                    contact_data = c_res.get("contact", {})
                    
                    # Buscar vtiger_id
                    v_id = None
                    for cf in contact_data.get("customFields", []):
                        if cf.get("id") == "PNr3LsTpXAwmyvPnvI11":
                            v_id = cf.get("value")
                            break
                            
                    if not v_id:
                        continue
                        
                    # Fetch vTiger
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
                        print(f"  [RENOMBRANDO] {old_name} -> {new_name}")
                        payload = {
                            "name": new_name,
                            "pipelineId": opp.get("pipelineId"),
                            "pipelineStageId": opp.get("pipelineStageId"),
                            "status": opp.get("status"),
                            "contactId": contact_id
                        }
                        await ghl_client.update_opportunity(opp["id"], payload)
                        renamed_total += 1
                        
                meta = res.get("meta", {})
                next_url = meta.get("nextPageUrl")
                
                if next_url:
                    url = next_url.split("v1/")[1] if "v1/" in next_url else next_url
                else:
                    url = None
                    
            except Exception as e:
                print(f"Error: {e}")
                await asyncio.sleep(2)
                
    print(f"\n===========================")
    print(f"TOTAL RENOMBRADAS: {renamed_total}")
    print(f"===========================")
    await ghl_client.close()

if __name__ == "__main__":
    asyncio.run(rename_all_pipelines())
