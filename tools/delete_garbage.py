import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from src.core.ghl_client import ghl_client

async def delete_garbage():
    print("Buscando Oportunidades Basura ('Oportunidad Migrada')...")
    
    deleted_count = 0
    # ID del Pipeline Maestro antiguo donde inyectamos por error
    old_pipeline_id = "yDWAU0AGW3QiivEz4VJg"
    url = f"opportunities/search?location_id={ghl_client.location_id}&pipeline_id={old_pipeline_id}"
    
    import re
    pattern = re.compile(r"\[.*\] \| .*")
    
    while url:
        try:
            res = await ghl_client._request("GET", url)
            opps = res.get("opportunities", [])
            print(f"Analizando página: {len(opps)} oportunidades.")
            
            for opp in opps:
                if opp.get("name") == "Oportunidad Migrada" or pattern.search(opp.get("name", "")):
                    print(f"Borrando basura: {opp['id']}")
                    await ghl_client.delete_opportunity(opp["id"])
                    deleted_count += 1
            
            meta = res.get("meta", {})
            next_url = meta.get("nextPageUrl")
            if next_url:
                # GHL nextPageUrl is usually absolute, but _request prepends base_url
                # So we must strip base_url if present
                if next_url.startswith(ghl_client.base_url):
                    url = next_url[len(ghl_client.base_url):]
                else:
                    url = next_url
            else:
                url = None
                
        except Exception as e:
            print(f"Error en la petición: {e}")
            break
            
    print(f"¡Limpieza terminada! Se borraron {deleted_count} tarjetas basura.")

if __name__ == "__main__":
    asyncio.run(delete_garbage())
