import asyncio
from src.core.ghl_client import GHLClient

PIPELINE_ID = "w62fzyP9nCmTBurH4HIi"

async def delete_all_new():
    ghl_client = GHLClient()
    
    url = f"opportunities/search?location_id={ghl_client.location_id}&pipeline_id={PIPELINE_ID}"
    deleted = 0
    
    while url:
        try:
            res = await ghl_client._request("GET", url)
            opps = res.get("opportunities", [])
            print(f"Borrando página con {len(opps)} oportunidades...")
            
            if not opps:
                break
            
            for opp in opps:
                await ghl_client.delete_opportunity(opp["id"])
                deleted += 1
                
        except Exception as e:
            print(f"Error: {e}")
            await asyncio.sleep(2)
            
    print(f"Total borradas: {deleted}")
    await ghl_client.close()

if __name__ == "__main__":
    asyncio.run(delete_all_new())
