import sys
import os
import asyncio
import httpx
from datetime import datetime, timezone

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.config import settings
from src.core.vtiger_client import vtiger_client
from src.agent_migration.full_transformer import transform_full_vtiger_record

async def run():
    print("Iniciando sesión en vTiger...")
    logged_in = await vtiger_client.login()
    if not logged_in:
        print("Fallo login")
        return

    print("Buscando contactos con monto > 0...")
    # Buscamos contactos que tengan monto mayor a 0 o que tengan condicion COMPRA
    q = "SELECT * FROM Contacts WHERE condicion LIKE '%COMPRA%';"
    contacts = await vtiger_client.query(q)
    
    print(f"Se encontraron {len(contacts)} compradores. Enviando a Node...")
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        for idx, raw_c in enumerate(contacts):
            full_data = transform_full_vtiger_record(raw_c)
            v_meta = full_data["vtiger_raw"]
            name = full_data.get("name", "")
            
            contact_payload = {
                "locationId": settings.ghl_location_id,
                "firstName": full_data.get("firstName", ""),
                "lastName": full_data.get("lastName", ""),
                "name": name,
                "phone": full_data.get("phone", ""),
                "email": full_data.get("email", ""),
                "source": "vTiger CRM",
                "tags": full_data.get("tags", []),
                "customFields": full_data.get("customFields", []),
                "notes": full_data.get("notes", "")
            }
            
            payload = contact_payload
            
            res = await client.post("http://localhost:3000/webhook/vtiger_watcher", json=payload)
            if res.status_code in [200, 201, 202]:
                print(f"✅ {name} enviado.")
            else:
                print(f"❌ Error con {name}: {res.status_code}")
                
            await asyncio.sleep(0.5)

asyncio.run(run())
