import asyncio
import json
from src.core.ghl_client import ghl_client

async def run():
    fields = await ghl_client.get_custom_fields()
    mapping = {f['name']: f['id'] for f in fields}
    print(json.dumps(mapping, indent=2))
    
    with open('data/custom_fields_map.json', 'w') as f:
        json.dump(mapping, f, indent=2)

if __name__ == "__main__":
    asyncio.run(run())
