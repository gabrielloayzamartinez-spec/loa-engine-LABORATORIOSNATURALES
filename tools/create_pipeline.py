import asyncio
import json
from src.core.ghl_client import GHLClient

async def create_pipeline():
    c = GHLClient()
    payload = {
        "name": "🗄️ Archivo Histórico vTiger",
        "locationId": c.location_id,
        "stages": [
            {
                "name": "♻️ Remarketing Histórico (Venta 0)",
                "position": 1
            },
            {
                "name": "💰 Ventas Históricas (Ganadas)",
                "position": 2
            }
        ]
    }
    try:
        res = await c._request('POST', 'opportunities/pipelines', json=payload)
        print(json.dumps(res, indent=2))
    except Exception as e:
        print(f"Error: {e}")
    finally:
        await c.close()

if __name__ == "__main__":
    asyncio.run(create_pipeline())
