import httpx
import os
import sys
import json
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding='utf-8')
load_dotenv()

api_key = os.getenv("GHL_API_KEY")
headers = {
    "Authorization": f"Bearer {api_key}",
    "Version": "2021-07-28"
}

res = httpx.get("https://services.leadconnectorhq.com/contacts/YH9rW5hrsAMyZUa0A3r2", headers=headers)
c = res.json().get("contact", {})
print("Contact:", c.get("name"), "| Phone:", c.get("phone"))
print("Tags:", c.get("tags"))
print(f"Custom Fields Total ({len(c.get('customFields', []))}):")
for cf in c.get("customFields", []):
    print(f"  • ID {cf.get('id')}: {cf.get('value')}")
