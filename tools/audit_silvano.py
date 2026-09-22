import asyncio
import os
import sys
import json
from pathlib import Path
from pprint import pprint

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.core.vtiger_client import vtiger_client
from src.core.ghl_client import ghl_client
from src.agent_migration.full_transformer import transform_full_vtiger_record
from src.agent_migration.custom_fields_provisioner import get_cached_field_map

async def audit_silvano():
    await vtiger_client.login()
    print("⏳ Buscando a Silvano Reyes en vTiger...")
    
    # ID exacto de Silvano Reyes (de la búsqueda anterior)
    q = "SELECT * FROM Contacts WHERE id = '12x931199';"
    res = await vtiger_client.query(q)
    
    if not res:
        print("❌ No se encontró a SILVANO REYES.")
        return
        
    raw_contact = res[0]
    
    print("\n🔄 Transformando contacto con las nuevas reglas (Lead/Customer, Redes, etc.)...")
    ghl_payload = transform_full_vtiger_record(raw_contact)
    
    notes = ghl_payload.pop("notes", None)
    ghl_payload.pop("vtiger_raw", None)
    ghl_payload["locationId"] = os.getenv("GHL_LOCATION_ID")
    
    field_map = get_cached_field_map()
    for cf in ghl_payload.get("customFields", []):
        if "key" in cf and "id" not in cf:
            dict_key = cf["key"].replace("contact.", "")
            if dict_key in field_map:
                cf["id"] = field_map[dict_key]
                
    print("\n📦 Payload JSON resultante para GHL:")
    print(json.dumps(ghl_payload, indent=2, ensure_ascii=False))
    print(f"\n📝 Notas que se inyectarán:\n{notes}")
    
    print("\n🚀 Inyectando en GoHighLevel...")
    try:
        ghl_res = await ghl_client.upsert_contact(ghl_payload)
        ghl_id = ghl_res.get("contact", {}).get("id") or ghl_res.get("id")
        print(f"✅ Contacto inyectado en GHL con ID: {ghl_id}")
        
        if ghl_id and notes:
            await ghl_client.add_note(ghl_id, notes)
            print("✅ Nota macro (Historial) anclada al contacto con éxito.")
            
    except Exception as e:
        print(f"❌ Error al inyectar en GHL: {e}")

if __name__ == "__main__":
    asyncio.run(audit_silvano())
