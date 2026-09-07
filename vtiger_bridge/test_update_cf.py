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

# Find a contact with phone or a vtiger contact
url = f"https://services.leadconnectorhq.com/contacts/?locationId={location_id}&query=Pablo&limit=5"
res = httpx.get(url, headers=headers)
contacts = res.json().get("contacts", [])
if not contacts:
    # Get first contact
    res = httpx.get(f"https://services.leadconnectorhq.com/contacts/?locationId={location_id}&limit=5", headers=headers)
    contacts = res.json().get("contacts", [])

if contacts:
    c = contacts[0]
    cid = c["id"]
    print("Testing on contact:", cid, c.get("name"), c.get("phone"))

    payload = {
        "customFields": [
            {"id": "PNr3LsTpXAwmyvPnvI11", "value": "12x931199"},
            {"id": "eBE29SIhviHr2yDJT1Y6", "value": "CON164810"},
            {"id": "Rr3EXbJwnCOWgFU5FHM3", "value": "Artritis"},
            {"id": "RgE4PAKDFOP89VIZHavV", "value": "Artritis"},
            {"id": "WcrrCIL4A2203kIbeFsJ", "value": "Artritis"},
            {"id": "3L8KHJEp8fw8ELr081Kl", "value": 1},
            {"id": "OnhkGCi6yQkLnoSE1dnP", "value": 200.0},
            {"id": "cqmj8bfaRB2Gxug0U5Ql", "value": 200.0},
            {"id": "5js0Lfbh5XDLq87SDgdT", "value": "200.0"},
            {"id": "OJYOXVqKp33A6T5HZK5I", "value": "2023-05-04"},
            {"id": "cyn0Ar7GMvmzYBKw0SJu", "value": "2023-05-04"},
            {"id": "1U0XzfuI9HUQDqQVMeSV", "value": "2023-05-04"},
            {"id": "GZKRu2z1Z156lRUfyrpo", "value": "2023-05-04"},
            {"id": "SR85C3u6JfnvkdK9hUN6", "value": "PALACIOS-CLICK2RING-FB-MSGR-Artritis"},
            {"id": "PzuJCcBcrnu4oUq1zLnN", "value": "FB-MSGR"},
            {"id": "mgvnRNO04M8CtQ3Kc3fZ", "value": "STACY"},
            {"id": "8EQtKkiW7Z022bcN0vhS", "value": "CONVERTIDO"},
            {"id": "EulM7Gjuxt63t9i7qr1y", "value": "2023-05-04"},
            {"id": "50pTZdtYYYcF1Wtz4j4s", "value": "PALACIOS"},
            {"id": "cZu95uKBqVydDEh24enl", "value": "Historial vTiger verificado"}
        ]
    }
    
    update_res = httpx.put(f"https://services.leadconnectorhq.com/contacts/{cid}", headers=headers, json=payload)
    print("Update status:", update_res.status_code)
    print("Update response:", update_res.text)

    # Fetch back to verify
    get_res = httpx.get(f"https://services.leadconnectorhq.com/contacts/{cid}", headers=headers)
    get_data = get_res.json().get("contact", {})
    print("Verified customFields stored in GHL:")
    print(json.dumps(get_data.get("customFields", []), indent=2))
