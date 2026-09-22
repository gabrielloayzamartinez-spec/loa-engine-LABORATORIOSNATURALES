import httpx
import os
import json
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("GHL_API_KEY")
location_id = os.getenv("GHL_LOCATION_ID")

headers = {
    "Authorization": f"Bearer {api_key}",
    "Version": "2021-07-28",
    "Content-Type": "application/json",
    "Accept": "application/json"
}

url = f"https://services.leadconnectorhq.com/locations/{location_id}/customFields"
res = httpx.get(url, headers=headers)
data = res.json()
fields = data.get("customFields", [])
print(f"Total Custom Fields in GHL: {len(fields)}")
for f in fields:
    print(f"ID: {f.get('id')} | Name: '{f.get('name')}' | Key: '{f.get('fieldKey')}' | Type: {f.get('dataType')}")
