import asyncio
import os
import sys
import time
from pathlib import Path
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn, TimeRemainingColumn

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.core.logger import logger, console
from src.core.vtiger_client import vtiger_client
from src.core.ghl_client import ghl_client
from src.core.checkpoint_manager import checkpoint_db
from src.agent_migration.full_transformer import transform_full_vtiger_record
from src.agent_migration.custom_fields_provisioner import setup_custom_fields

CHUNK_SIZE = 100
MAX_CONCURRENT_API_CALLS = 10

async def process_single_contact(raw_contact, field_map):
    try:
        ghl_payload = transform_full_vtiger_record(raw_contact)
        v_id = raw_contact.get("id")
        phone = ghl_payload.get("phone", "")
        
        # Saltarse si ya fue migrado
        if checkpoint_db.is_already_migrated(str(v_id), phone):
            return {"status": "skipped", "id": v_id}
            
        # Extraer notas y eliminar datos sin procesar por GHL
        notes = ghl_payload.pop("notes", None)
        ghl_payload.pop("vtiger_raw", None)
        
        # Ensure locationId is present
        from src.config import settings
        ghl_payload["locationId"] = settings.ghl_location_id
        
        # Inject exact IDs from field_map for customFields
        for cf in ghl_payload.get("customFields", []):
            if "key" in cf and "id" not in cf:
                dict_key = cf["key"].replace("contact.", "")
                if dict_key in field_map:
                    cf["id"] = field_map[dict_key]
        
        res = await ghl_client.upsert_contact(ghl_payload)
        ghl_id = res.get("contact", {}).get("id") or res.get("id")
        
        # Add notes
        if ghl_id and notes:
            try:
                await ghl_client.add_note(ghl_id, notes)
            except Exception as e:
                logger.warning(f"Error subiendo nota al contacto {ghl_id}: {e}")

        if ghl_id:
            checkpoint_db.record_success(
                vitrail_id=str(v_id),
                ghl_contact_id=str(ghl_id),
                phone=phone,
                email=ghl_payload.get("email", ""),
                tags=",".join(ghl_payload.get("tags", []))
            )
            return {"status": "success", "id": v_id}
        else:
            return {"status": "error", "id": v_id, "error": "No GHL ID returned"}
    except Exception as e:
        v_id = raw_contact.get("id", "UNKNOWN")
        logger.error(f"Error procesando ID {v_id}: {e}")
        checkpoint_db.record_failure(
            vitrail_id=str(v_id),
            phone=raw_contact.get("mobile", ""),
            email=raw_contact.get("email", ""),
            error_message=str(e)
        )
        return {"status": "error", "id": v_id, "error": str(e)}

async def run_direct_injection():
    console.print("\n[bold cyan]🚀 INICIANDO INYECCIÓN DIRECTA MASIVA A GHL POR API[/bold cyan]")
    
    # Setup/Refresh Custom Fields First
    field_map = await setup_custom_fields()
    
    logged_in = await vtiger_client.login()
    if not logged_in:
        console.print("[red]❌ No se pudo autenticar en vTiger[/red]")
        return
        
    res_total = await vtiger_client.query("SELECT count(*) FROM Contacts;")
    total_in_db = int(res_total[0]["count"]) if res_total else 388540
    
    console.print(f"📊 Total de registros en vTiger a procesar: [bold yellow]{total_in_db:,}[/bold yellow]\n")

    offset = 0
    total_success = 0
    total_skipped = 0
    total_errors = 0
    
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_API_CALLS)
    
    async def bounded_process(raw_contact):
        async with semaphore:
            return await process_single_contact(raw_contact, field_map)

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]Inyectando a GHL..."),
        BarColumn(bar_width=40),
        TextColumn("[bold green]{task.completed:,}/{task.total:,}"),
        TextColumn(" (Exito: {task.fields[success]} | Omitidos: {task.fields[skipped]})"),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        console=console
    ) as progress:
        task = progress.add_task("Migrando", total=total_in_db, success=0, skipped=0)
        
        while True:
            limit = CHUNK_SIZE
            q = f"SELECT * FROM Contacts LIMIT {offset}, {limit};"
            
            batch = None
            for retry in range(3):
                try:
                    batch = await vtiger_client.query(q)
                    break
                except Exception as e:
                    await asyncio.sleep(2)
                    await vtiger_client.login()
                    
            if not batch:
                break
                
            tasks = [bounded_process(c) for c in batch]
            results = await asyncio.gather(*tasks)
            
            for r in results:
                if r["status"] == "success": total_success += 1
                elif r["status"] == "skipped": total_skipped += 1
                else: total_errors += 1
                
            progress.update(task, advance=len(batch), success=total_success, skipped=total_skipped)
            
            offset += limit
            if len(batch) < limit:
                break
                
            await asyncio.sleep(0.5) # Gentle pause for GHL rate limiting

    console.print(f"\n[bold green]✅ Inyección Directa Completada![/bold green]")
    console.print(f"Éxitos: {total_success} | Omitidos (ya existían): {total_skipped} | Errores: {total_errors}")

if __name__ == "__main__":
    asyncio.run(run_direct_injection())
