import asyncio
import json
from src.core.ghl_client import GHLClient

async def get_pipelines():
    c = GHLClient()
    res = await c._request('GET', f'opportunities/pipelines?locationId={c.location_id}')
    print(json.dumps(res, indent=2))
    await c.close()

if __name__ == "__main__":
    asyncio.run(get_pipelines())
