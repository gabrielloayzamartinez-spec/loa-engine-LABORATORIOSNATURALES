import asyncio
import re
from src.core.ghl_client import GHLClient
from src.core.vtiger_client import VTigerClient
from src.agent_migration.full_transformer import transform_full_vtiger_record

PIPELINE_HISTORICO_ID = "w62fzyP9nCmTBurH4HIi"

async def test_mover_vtiger():
    ghl = GHLClient()
    vt = VTigerClient()
    await vt.login()
    
    # Get all pipelines to find Maestro
    p_res = await ghl._request("GET", "opportunities/pipelines")
    pipelines = p_res.get("pipelines", [])
    
    stage_ganada_id = None
    stage_remarketing_id = None
    
    for p in pipelines:
        if p["id"] == PIPELINE_HISTORICO_ID:
            for s in p["stages"]:
                if "Ganada" in s["name"]:
                    stage_ganada_id = s["id"]
                elif "Remarketing" in s["name"]:
                    stage_remarketing_id = s["id"]
                    
    print(f"Stages Histórico - Ganada: {stage_ganada_id} | Remarketing: {stage_remarketing_id}")
    
    # We will search the first 50 contacts across all pipelines EXCEPT Historico
    # Actually, let's just search opportunities by searching all of them and skipping Historico
    url = f"opportunities/search?location_id={ghl.location_id}"
    
    found_infiltrados = []
    
    while url and len(found_infiltrados) < 5:
        try:
            res = await ghl._request("GET", url)
            opps = res.get("opportunities", [])
            if not opps:
                break
                
            for opp in opps:
                if opp.get("pipelineId") == PIPELINE_HISTORICO_ID:
                    continue # Already in the right place
                    
                # Check if it has vtiger ID
                contact_id = opp.get("contactId")
                if not contact_id:
                    continue
                    
                c_res = await ghl._request("GET", f"contacts/{contact_id}")
                v_id = next((cf['value'] for cf in c_res.get('contact', {}).get('customFields', []) if cf['id'] == 'PNr3LsTpXAwmyvPnvI11'), None)
                
                if v_id:
                    # Found an infiltrado!
                    vt_res = await vt.query(f"SELECT * FROM Contacts WHERE id = '{v_id}'")
                    if not vt_res: continue
                        
                    fd = transform_full_vtiger_record(vt_res[0])
                    canal = fd['vtiger_raw'].get('canal_origen', '')
                    cond = fd['vtiger_raw'].get('condicion', '')
                    monto = fd['vtiger_raw'].get('monto_usd', 0)
                    
                    nn = f"{fd.get('name')} - {canal} - {cond}" if canal and cond else fd.get('name')
                    status = opp.get('status')
                    new_stage = stage_ganada_id if status == 'won' else stage_remarketing_id
                    
                    found_infiltrados.append({
                        "original_name": opp.get("name"),
                        "new_name": nn,
                        "monto": monto,
                        "old_pipeline": opp.get("pipelineId"),
                        "new_pipeline": PIPELINE_HISTORICO_ID,
                        "status": status,
                        "new_stage_id": new_stage
                    })
                    
                    if len(found_infiltrados) >= 5:
                        break
                        
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
                await asyncio.sleep(2)
            else:
                break
                
    print("\n--- REPORTE DE INFILTRADOS ENCONTRADOS (MAX 5) ---")
    for inf in found_infiltrados:
        print(f"Detectado en pipeline: {inf['old_pipeline']}")
        print(f"Nombre Original : {inf['original_name']}")
        print(f"Nombre Corregido: {inf['new_name']}")
        print(f"Monto Rest.     : ${inf['monto']}")
        print(f"Se mudará a     : Archivo Histórico vTiger (Status: {inf['status']})")
        print("-" * 50)
        
    await ghl.close()

if __name__ == "__main__":
    asyncio.run(test_mover_vtiger())
