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

# Fetch the last created/updated contact from GHL to test
url = f"https://services.leadconnectorhq.com/contacts/?locationId={location_id}&limit=5"
res = httpx.get(url, headers=headers)
contacts = res.json().get("contacts", [])
if contacts:
    c = contacts[0]
    print("Contact ID:", c.get("id"), "Name:", c.get("name"), "Phone:", c.get("phone"))
    print("Current Custom Fields on contact:")
    print(json.dumps(c.get("customFields", []), indent=2))
