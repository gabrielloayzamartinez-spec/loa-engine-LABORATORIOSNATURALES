import asyncio
from src.core.ghl_client import GHLClient

async def get_stages():
    ghl = GHLClient()
    res = await ghl._request("GET", "opportunities/pipelines")
    for p in res.get("pipelines", []):
        if p["id"] == "w62fzyP9nCmTBurH4HIi":
            for stage in p["stages"]:
                print(f"Stage: {stage['name']} | ID: {stage['id']}")
    await ghl.close()

if __name__ == "__main__":
    asyncio.run(get_stages())
