import asyncio
import os
import sys
import glob
import time
import pandas as pd
from typing import Dict, Any
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
from src.core.ghl_client import ghl_client
from src.core.checkpoint_manager import checkpoint_db
from fase1_barrido_contactos import build_golden_contact_payload

# Constantes del Pipeline Maestro
PIPELINE_ID = "w62fzyP9nCmTBurH4HIi"
REMARKETING_STAGE_ID = "20081fdf-d8d6-48ed-85fc-24b485e37fa5"
GANADO_STAGE_ID = "64ea754f-59e4-4437-be01-ab52cf9f3671"
CHUNK_SIZE = 500
MAX_CONCURRENT_API_CALLS = 10

def load_all_csv_records() -> Dict[str, Dict[str, Any]]:
    console.print("📂 [bold cyan]Indexando archivos CSV de vTiger en memoria para inyección rápida O(1)...[/bold cyan]")
    t0 = time.time()
    files = sorted(glob.glob("data/output/*.csv"), key=lambda x: int(x.split('_parte_')[1].replace('.csv','')) if '_parte_' in x else 999)
    
    csv_map = {}
    for f in files:
        df = pd.read_csv(f, dtype=str)
        for row in df.to_dict(orient="records"):
            vt_id = str(row.get("vTiger ID Cliente", "") or "").strip()
            if vt_id and vt_id != "nan":
                csv_map[vt_id] = row
                
    console.print(f"✨ [bold green]{len(csv_map):,} registros vTiger indexados[/bold green] en {time.time()-t0:.2f} segundos.\n")
    return csv_map

async def process_opportunity(vitrail_id: str, ghl_contact_id: str, csv_map: Dict[str, Any]):
    if checkpoint_db.is_opportunity_migrated(ghl_contact_id):
        return {"status": "skipped"}
        
    try:
        row = csv_map.get(vitrail_id)
        if not row:
             return {"status": "error", "msg": "Not found in CSV mapping"}
             
        golden = build_golden_contact_payload(row)
        if not golden:
            return {"status": "error", "msg": "Failed to build golden payload"}
            
        name = golden["payload"].get("name", "Oportunidad Migrada")
        condicion = golden["condicion"]
        monto = float(golden["monto"])
        canal = golden["canal"]
        
        # Format: nombre - canal - dolencia
        opp_name = name
        if canal:
            opp_name += f" - {canal}"
        if condicion:
            opp_name += f" - {condicion}"
        
        if monto > 0:
            stage_id = GANADO_STAGE_ID
            status = "won"
        else:
            stage_id = REMARKETING_STAGE_ID
            status = "open"
        
        payload = {
            "pipelineId": PIPELINE_ID,
            "pipelineStageId": stage_id,
            "contactId": ghl_contact_id,
            "status": status,
            "name": opp_name,
            "monetaryValue": monto
        }
        
        res = await ghl_client.create_opportunity(payload)
        opp_id = res.get("opportunity", {}).get("id") or res.get("id", "UNKNOWN")
        
        checkpoint_db.record_opportunity_success(ghl_contact_id, opp_id)
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error creando oportunidad para {ghl_contact_id}: {e}")
        checkpoint_db.record_opportunity_failure(ghl_contact_id)
        return {"status": "error"}

async def run_opportunities_injection():
    console.print("\n[bold magenta]🚀 INICIANDO INYECCIÓN MASIVA DE OPORTUNIDADES AL PIPELINE[/bold magenta]")
    
    checkpoint_db.init_opportunities_table()
    csv_map = load_all_csv_records()
    
    # Obtener SÓLO contactos que son Clientes (Tienen compras o estado convertido)
    with checkpoint_db._get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT vitrail_id, ghl_contact_id FROM migrated_contacts WHERE status = 'SUCCESS' AND ghl_contact_id IS NOT NULL AND tags LIKE '%cliente-convertido%'")
        all_contacts = [{"v_id": row["vitrail_id"], "g_id": row["ghl_contact_id"]} for row in cur.fetchall()]
        
    total_in_db = len(all_contacts)
    console.print(f"📊 Total de contactos listos para volverse oportunidades: [bold yellow]{total_in_db:,}[/bold yellow]\n")

    total_success = 0
    total_skipped = 0
    total_errors = 0
        
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_API_CALLS)
    
    async def bounded_process(c):
        async with semaphore:
            return await process_opportunity(c["v_id"], c["g_id"], csv_map)

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]Creando Oportunidades..."),
        BarColumn(bar_width=40),
        TextColumn("[bold green]{task.completed:,}/{task.total:,}"),
        TextColumn(" (Exito: {task.fields[success]} | Omitidos: {task.fields[skipped]})"),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        console=console
    ) as progress:
        task = progress.add_task("Migrando", total=total_in_db, success=0, skipped=0)
        
        # Procesar en chunks
        for i in range(0, len(all_contacts), CHUNK_SIZE):
            batch = all_contacts[i:i+CHUNK_SIZE]
            
            tasks = [bounded_process(cid) for cid in batch]
            results = await asyncio.gather(*tasks)
            
            for r in results:
                if r["status"] == "success": total_success += 1
                elif r["status"] == "skipped": total_skipped += 1
                else: total_errors += 1
                
            progress.update(task, advance=len(batch), success=total_success, skipped=total_skipped)
            # await asyncio.sleep(0.5)

    console.print(f"\n[bold green]✅ Inyección de Oportunidades Completada![/bold green]")
    console.print(f"Éxitos: {total_success} | Omitidos (ya existían): {total_skipped} | Errores: {total_errors}")

if __name__ == "__main__":
    asyncio.run(run_opportunities_injection())
