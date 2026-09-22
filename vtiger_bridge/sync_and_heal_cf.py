import httpx
import os
import sys
import json
import asyncio
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding='utf-8')
load_dotenv()

api_key = os.getenv("GHL_API_KEY")
location_id = os.getenv("GHL_LOCATION_ID")

headers = {
    "Authorization": f"Bearer {api_key}",
    "Version": "2021-07-28",
    "Content-Type": "application/json",
    "Accept": "application/json"
}

def parse_vtiger_notes(note_text: str) -> dict:
    parsed = {}
    for line in note_text.split("\n"):
        line = line.strip("• ").strip()
        if ":" in line:
            parts = line.split(":", 1)
            k = parts[0].strip().lower()
            v = parts[1].strip()
            parsed[k] = v
    return parsed

async def process_single_contact(client, sem, c):
    async with sem:
        cid = c["id"]
        cf_list = c.get("customFields", [])
        existing_cf_map = {item["id"]: item.get("value") for item in cf_list if "id" in item}
        
        # Check custom field cZu95uKBqVydDEh24enl (Receta Notas)
        note_text = existing_cf_map.get("cZu95uKBqVydDEh24enl", "")
        
        # If not in custom field, check contact notes API
        if not note_text:
            try:
                notes_res = await client.get(f"https://services.leadconnectorhq.com/contacts/{cid}/notes", headers=headers)
                notes_data = notes_res.json().get("notes", [])
                if notes_data:
                    note_text = notes_data[0].get("body", "")
            except Exception:
                pass
                
        if not note_text or "VTIGER" not in note_text.upper():
            return False, None
            
        parsed = parse_vtiger_notes(note_text)
        vtiger_id_full = parsed.get("id vtiger", "")
        vtiger_id = vtiger_id_full.split("(")[0].strip() if "(" in vtiger_id_full else vtiger_id_full
        contact_no = vtiger_id_full.split("(")[1].replace(")", "").strip() if "(" in vtiger_id_full else ""
        
        estado_comercial = parsed.get("estado comercial", "CONVERTIDO")
        producto_condicion = parsed.get("producto / condición", parsed.get("producto / condicion", "Salud / Tratamiento"))
        campana = parsed.get("campaña origen", parsed.get("campana origen", ""))
        canal_metodo = parsed.get("canal", "")
        canal = canal_metodo.split("|")[0].strip() if "|" in canal_metodo else canal_metodo
        asesor = parsed.get("asesor asignado", "")
        
        total_compras_str = parsed.get("total compras", "1")
        try:
            total_compras = int(total_compras_str)
        except:
            total_compras = 1
            
        monto_str = parsed.get("monto total invertido", "$0.00")
        monto_clean = monto_str.replace("$", "").replace("USD", "").strip()
        try:
            monto = float(monto_clean)
        except:
            monto = 0.0
            
        primera_compra = parsed.get("primera compra", "")
        ultima_compra = parsed.get("última compra", parsed.get("ultima compra", primera_compra))
        estado_tz = parsed.get("estado / zona horaria", "")
        estado_usa = estado_tz.split("(")[0].strip() if "(" in estado_tz else estado_tz
        fecha_registro = parsed.get("fecha registro vtiger", "")[:10]
        
        new_cfs = [
            {"id": "PNr3LsTpXAwmyvPnvI11", "value": vtiger_id},
            {"id": "eBE29SIhviHr2yDJT1Y6", "value": contact_no},
            {"id": "Rr3EXbJwnCOWgFU5FHM3", "value": producto_condicion},
            {"id": "RgE4PAKDFOP89VIZHavV", "value": producto_condicion},
            {"id": "WcrrCIL4A2203kIbeFsJ", "value": producto_condicion},
            {"id": "3L8KHJEp8fw8ELr081Kl", "value": total_compras},
            {"id": "OnhkGCi6yQkLnoSE1dnP", "value": monto},
            {"id": "cqmj8bfaRB2Gxug0U5Ql", "value": monto},
            {"id": "5js0Lfbh5XDLq87SDgdT", "value": f"{monto:.2f}"},
            {"id": "SR85C3u6JfnvkdK9hUN6", "value": campana},
            {"id": "6w3yMjLgIw6npUKWIosr", "value": campana},
            {"id": "PzuJCcBcrnu4oUq1zLnN", "value": canal},
            {"id": "mgvnRNO04M8CtQ3Kc3fZ", "value": asesor},
            {"id": "8EQtKkiW7Z022bcN0vhS", "value": estado_comercial},
            {"id": "50pTZdtYYYcF1Wtz4j4s", "value": estado_usa},
            {"id": "cZu95uKBqVydDEh24enl", "value": note_text}
        ]
        
        if primera_compra and len(primera_compra) >= 10:
            new_cfs.append({"id": "OJYOXVqKp33A6T5HZK5I", "value": primera_compra[:10]})
            new_cfs.append({"id": "GZKRu2z1Z156lRUfyrpo", "value": primera_compra[:10]})
        if ultima_compra and len(ultima_compra) >= 10:
            new_cfs.append({"id": "cyn0Ar7GMvmzYBKw0SJu", "value": ultima_compra[:10]})
            new_cfs.append({"id": "1U0XzfuI9HUQDqQVMeSV", "value": ultima_compra[:10]})
        if fecha_registro and len(fecha_registro) >= 10:
            new_cfs.append({"id": "EulM7Gjuxt63t9i7qr1y", "value": fecha_registro[:10]})
            
        up_res = await client.put(f"https://services.leadconnectorhq.com/contacts/{cid}", headers=headers, json={"customFields": new_cfs})
        if up_res.status_code == 200:
            name = c.get("name") or c.get("firstName") or cid
            print(f"  --> ✨ [{name}] Custom fields acomodados y poblados con éxito!", flush=True)
            return True, cid
        else:
            print(f"  --> ⚠️ Error actualizando {cid}: {up_res.status_code}", flush=True)
            return False, None

async def heal_all():
    print("🔍 Consultando lista de contactos en GoHighLevel...", flush=True)
    async with httpx.AsyncClient(timeout=25.0) as client:
        res = await client.get(f"https://services.leadconnectorhq.com/contacts/?locationId={location_id}&limit=100", headers=headers)
        contacts = res.json().get("contacts", [])
        print(f"📊 {len(contacts)} contactos obtenidos. Procesando...", flush=True)
        
        sem = asyncio.Semaphore(8)
        tasks = [process_single_contact(client, sem, c) for c in contacts]
        results = await asyncio.gather(*tasks)
        
        success_count = sum(1 for success, _ in results if success)
        print(f"\n=======================================================", flush=True)
        print(f"✅ ¡FINALIZADO! Se acomodaron los campos de {success_count} contactos.", flush=True)
        print(f"=======================================================", flush=True)

if __name__ == "__main__":
    asyncio.run(heal_all())
