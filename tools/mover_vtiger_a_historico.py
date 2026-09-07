import asyncio
import json
import os
from datetime import datetime
from src.core.ghl_client import GHLClient

PIPELINE_HISTORICO_ID = "w62fzyP9nCmTBurH4HIi"
LOG_FILE = "data/logs/mudanza_live.jsonl"

def log_progress(data):
    data["timestamp"] = datetime.now().isoformat()
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(data) + "\n")

async def mover_fast():
    ghl = GHLClient()
    
    # 1. Fetch Pipelines
    while True:
        try:
            p_res = await ghl._request("GET", "opportunities/pipelines")
            pipelines = p_res.get("pipelines", [])
            break
        except Exception as e:
            print("Retrying pipelines fetch...")
            await asyncio.sleep(2)
            
    maestro_pipeline_id = None
    maestro_stages = []
    
    historico_stage_ganada = None
    historico_stage_remarketing = None
    
    for p in pipelines:
        if p["id"] == PIPELINE_HISTORICO_ID:
            for s in p["stages"]:
                if "Ganada" in s["name"]: historico_stage_ganada = s["id"]
                elif "Remarketing" in s["name"]: historico_stage_remarketing = s["id"]
        elif "Maestro" in p["name"]:
            maestro_pipeline_id = p["id"]
            for s in p["stages"]:
                if "REMARKETING" in s["name"].upper() or "Venta Cerrada" in s["name"]:
                    maestro_stages.append(s["id"])
                    
    print(f"Maestro Pipeline ID: {maestro_pipeline_id}")
    print(f"Maestro Target Stages: {maestro_stages}")
    
    if not maestro_pipeline_id or not maestro_stages:
        print("Could not find Maestro pipeline or stages.")
        return

    url = f"opportunities/search?pipeline_id={maestro_pipeline_id}&location_id={ghl.location_id}"
    
    while url:
        try:
            res = await ghl._request("GET", url)
            opps = res.get("opportunities", [])
            if not opps:
                break
                
            for opp in opps:
                if opp.get("pipelineStageId") in maestro_stages:
                    status = opp.get("status", "open")
                    
                    # Determine target stage based on status or original stage name
                    # If it has 0 value, it's remarketing. If > 0 it's won.
                    monto = float(opp.get("monetaryValue", 0))
                    new_stage = historico_stage_ganada if monto > 0 else historico_stage_remarketing
                    new_status = "won" if monto > 0 else "open"
                    
                    payload = {
                        "name": opp.get("name"),
                        "pipelineId": PIPELINE_HISTORICO_ID,
                        "pipelineStageId": new_stage,
                        "status": new_status,
                        "monetaryValue": monto
                    }
                    
                    while True:
                        try:
                            await ghl.update_opportunity(opp["id"], payload)
                            log_progress({
                                "original_name": opp.get("name"),
                                "new_name": opp.get("name"),
                                "monto": monto,
                                "old_pipeline": "Pipeline Maestro",
                                "status": new_status,
                                "action": "Movimiento Rápido"
                            })
                            print(f"Moved: {opp.get('name')}")
                            break
                        except Exception as e:
                            if "429" in str(e):
                                print(f"429 updating {opp.get('name')}, retrying...")
                                await asyncio.sleep(2)
                            else:
                                print(f"Fatal Error moving {opp.get('name')}: {e}")
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
                await asyncio.sleep(2)
                
    await ghl.close()

if __name__ == "__main__":
    asyncio.run(mover_fast())
