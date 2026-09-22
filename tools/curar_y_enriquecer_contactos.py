"""
LOA ENGINE - MÓDULO DE CURACIÓN Y ENRIQUECIMIENTO EXHAUSTIVO (HEALER)
Asegura que el 100% de los contactos ya migrados a GoHighLevel tengan TODOS
los datos completos idénticos al estándar de Yaquelin Villanueva (23 Custom Fields):
- Montos Reales ($438.00 o $0.00 en Monto Última Compra, Total Histórico y Precio Venta)
- Status del Contacto: '1-POR ASIGNAR'
- Anotaciones Redes completas
- Tratamiento Comprado y Producto Condición
- Campaña e ID de Anuncio
- Fechas de Primera y Última Compra
- Notas con formato estructurado vTiger
"""

import sys
import os
import glob
import time
import asyncio
import sqlite3
import argparse
import pandas as pd
from pathlib import Path
from typing import Dict, Any, List, Optional
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
from src.core.ghl_client import ghl_client, DailyRateLimitExceededException
from fase1_barrido_contactos import build_golden_contact_payload, CF_MAP

DB_PATH = Path("data/checkpoint.db")


def init_healer_db():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS healed_contacts (
            ghl_contact_id TEXT PRIMARY KEY,
            vitrail_id TEXT,
            phone TEXT,
            fields_count INTEGER,
            status TEXT DEFAULT 'SUCCESS',
            error_message TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_healed_vitrail ON healed_contacts(vitrail_id);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_healed_status ON healed_contacts(status);")
    conn.commit()
    conn.close()


def load_all_csv_records() -> Dict[str, Dict[str, Any]]:
    console.print("📂 [bold cyan]Indexando archivos CSV de vTiger en memoria para cruce O(1)...[/bold cyan]")
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


async def heal_single_contact(ghl_id: str, vt_id: str, row: Dict[str, Any], semaphore: asyncio.Semaphore) -> bool:
    async with semaphore:
        golden = build_golden_contact_payload(row)
        if not golden:
            return False
            
        custom_fields = golden["payload"].get("customFields", [])
        
        # Enviar actualización a GHL por ID exacto
        update_payload = {
            "customFields": custom_fields
        }
        
        try:
            res = await ghl_client.update_contact(ghl_id, update_payload)
            if res:
                conn = sqlite3.connect(DB_PATH)
                conn.execute("""
                    INSERT OR REPLACE INTO healed_contacts (ghl_contact_id, vitrail_id, phone, fields_count, status, updated_at)
                    VALUES (?, ?, ?, ?, 'SUCCESS', CURRENT_TIMESTAMP)
                """, (ghl_id, vt_id, golden["payload"].get("phone"), len(custom_fields)))
                conn.commit()
                conn.close()
                return True
            return False
        except DailyRateLimitExceededException:
            raise
        except Exception as e:
            conn = sqlite3.connect(DB_PATH)
            conn.execute("""
                INSERT OR REPLACE INTO healed_contacts (ghl_contact_id, vitrail_id, phone, fields_count, status, error_message, updated_at)
                VALUES (?, ?, ?, 0, 'FAILED', ?, CURRENT_TIMESTAMP)
            """, (ghl_id, vt_id, golden["payload"].get("phone"), str(e)[:150]))
            conn.commit()
            conn.close()
            return False


async def run_healer(limit: Optional[int] = None):
    console.rule("[bold magenta]🌟 LOA ENGINE - CURACIÓN Y ENRIQUECIMIENTO TOTAL DE CAMPOS GHL[/bold magenta]")
    console.print("🎯 [bold yellow]Estándar Activo:[/bold yellow] 23 Custom Fields completos (Montos, Tratamientos, Status '1-POR ASIGNAR', Anotaciones y Notas)\n")
    
    init_healer_db()
    csv_map = load_all_csv_records()
    
    # Obtener contactos migrados que aún no han sido curados
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT ghl_contact_id FROM healed_contacts WHERE status='SUCCESS'")
    already_healed = set(row[0] for row in cur.fetchall() if row[0])
    
    cur.execute("SELECT ghl_contact_id, vitrail_id FROM migrated_contacts WHERE status='SUCCESS' AND ghl_contact_id IS NOT NULL")
    migrated = cur.fetchall()
    conn.close()
    
    pending = [(ghl_id, vt_id) for ghl_id, vt_id in migrated if ghl_id not in already_healed and vt_id in csv_map]
    
    console.print(f"📊 Total Contactos en GHL: [bold cyan]{len(migrated):,}[/bold cyan]")
    console.print(f"✅ Ya Curados / Completos: [bold green]{len(already_healed):,}[/bold green]")
    console.print(f"⏳ Pendientes de Enriquecer: [bold yellow]{len(pending):,}[/bold yellow]\n")
    
    if limit and limit > 0:
        pending = pending[:limit]
        console.print(f"🧪 [bold cyan]Modo Prueba / Límite activo:[/bold cyan] Procesando únicamente {len(pending)} contactos.\n")
        
    if not pending:
        console.print("🎉 [bold green]¡Todos los contactos en GoHighLevel ya cuentan con el estándar completo al 100%![/bold green]\n")
        return

    CHUNK_SIZE = 50
    semaphore = asyncio.Semaphore(8)
    total_success = 0
    total_failed = 0

    try:
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(bar_width=40),
            TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
            TextColumn("• ({task.completed}/{task.total})"),
            TimeElapsedColumn(),
            TimeRemainingColumn(),
            console=console
        ) as progress:
            task = progress.add_task("[magenta]Curando contactos en GHL...", total=len(pending))
            
            for i in range(0, len(pending), CHUNK_SIZE):
                chunk = pending[i:i + CHUNK_SIZE]
                tasks = [heal_single_contact(ghl_id, vt_id, csv_map[vt_id], semaphore) for ghl_id, vt_id in chunk]
                results = await asyncio.gather(*tasks)
                
                for r in results:
                    if r: total_success += 1
                    else: total_failed += 1
                    
                progress.advance(task, advance=len(chunk))
                
        console.rule("[bold green]✅ PROCESO DE ENRIQUECIMIENTO FINALIZADO[/bold green]")
        console.print(f"🏆 Contactos Actualizados Exitosamente con 23 Campos: [bold green]{total_success:,}[/bold green]")
        console.print(f"⚠️ Fallidos: [bold red]{total_failed:,}[/bold red]\n")
        
    except DailyRateLimitExceededException as e:
        console.print(f"\n🛑 [bold red]PAUSA DE SEGURIDAD - CUOTA DIARIA DE GHL ALCANZADA[/bold red]\n[yellow]{e}[/yellow]")
        console.print("🛡️ [bold green]Progreso salvado automáticamente.[/bold green] Puedes reanudar mañana y continuará exactamente donde se quedó.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Curador y Enriquecedor de Contactos en GHL")
    parser.add_argument("--limit", type=int, default=None, help="Límite de contactos a procesar (ej. para pruebas)")
    args = parser.parse_args()
    
    asyncio.run(run_healer(limit=args.limit))
