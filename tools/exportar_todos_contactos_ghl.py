"""
Script de Exportación Masiva Inteligente de Contactos vTiger CRM ➡️ GoHighLevel (GHL)
Extrae el catálogo completo de contactos de vTiger, limpia y normaliza teléfonos a E.164 (+1 USA),
genera etiquetas inteligentes, calcula el LTV y genera archivos CSV listos para el Importador Nativo de GHL.
"""

import sys
import os
import csv
import time
import asyncio
from pathlib import Path
from typing import Dict, List, Any, Optional

from rich.console import Console
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn, TimeRemainingColumn

from src.config import settings, DATA_DIR
from src.core.logger import logger
from src.core.vtiger_client import vtiger_client
from src.agent_migration.full_transformer import transform_full_vtiger_record

sys.stdout.reconfigure(encoding='utf-8')
console = Console()

OUTPUT_DIR = DATA_DIR / "output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

CHUNK_SIZE = 100  # vTiger API maximum safe limit per query
ROWS_PER_CSV = 30000  # Optimal chunk size for GoHighLevel Smart CSV Importer


def map_record_to_ghl_csv_row(transformed: Dict[str, Any]) -> Dict[str, Any]:
    """Flattens transformed dictionary into clean CSV columns recognized by GoHighLevel."""
    v_raw = transformed.get("vtiger_raw", {})
    tags_str = ", ".join(transformed.get("tags", []))
    
    return {
        "First Name": transformed.get("firstName", ""),
        "Last Name": transformed.get("lastName", ""),
        "Phone": transformed.get("phone", ""),
        "Email": transformed.get("email", "") or "",
        "City": transformed.get("city", "") or "",
        "State": transformed.get("state", "") or "",
        "Timezone": transformed.get("timezone", "America/New_York"),
        "Tags": tags_str,
        "Notes": transformed.get("notes", ""),
        "vTiger ID Cliente": v_raw.get("id", ""),
        "vTiger Contact No": v_raw.get("contact_no", ""),
        "vTiger Producto Condicion": v_raw.get("condicion", ""),
        "vTiger Total Compras": v_raw.get("num_compras", "1"),
        "vTiger Monto Ultima Compra USD": f"{v_raw.get('monto_usd', 0.0):.2f}",
        "vTiger Total Historico Gastado USD": f"{v_raw.get('monto_usd', 0.0):.2f}",
        "vTiger Fecha Primera Compra": v_raw.get("fecha_primera", ""),
        "vTiger Fecha Ultima Compra": v_raw.get("fecha_ultima", ""),
        "vTiger Campana Origen": v_raw.get("campana", ""),
        "vTiger Canal Captacion": v_raw.get("canal_origen", ""),
        "vTiger Asesor Asignado": v_raw.get("asesor", ""),
        "vTiger Estado Comercial": v_raw.get("estado_comercial", ""),
        "vTiger Fecha Creacion": v_raw.get("fecha_creacion", ""),
        "vTiger Sede / Tienda Compra": v_raw.get("estado_usa", ""),
        "vTiger Última Compra Producto": v_raw.get("condicion", "")
    }


async def run_full_export(
    max_records: Optional[int] = None,
    filter_year: Optional[int] = None,
    filter_converted_only: bool = False
):
    console.print("\n[bold cyan]╔════════════════════════════════════════════════════════════════════════════════════╗[/bold cyan]")
    console.print("[bold cyan]║  🚀 EXPORTADOR MASIVO ENRIQUECIDO VTIGER CRM ➡️ GOHIGHLEVEL (GHL)              ║[/bold cyan]")
    console.print("[bold cyan]╚════════════════════════════════════════════════════════════════════════════════════╝[/bold cyan]\n")

    # 1. Authenticate with vTiger
    logged_in = await vtiger_client.login()
    if not logged_in:
        console.print("[bold red]❌ No se pudo autenticar en vTiger CRM. Verifica las credenciales en .env.[/bold red]")
        return

    # 2. Determine total records
    where_clauses = []
    if filter_year:
        where_clauses.append(f"createdtime >= '{filter_year}-01-01 00:00:00'")
    if filter_converted_only:
        where_clauses.append("cf_1876 = 'CONVERTIDO'")

    where_str = f" WHERE {' AND '.join(where_clauses)}" if where_clauses else ""
    
    count_query = f"SELECT count(*) FROM Contacts{where_str};"
    total_in_db = 0
    try:
        count_res = await vtiger_client.query(count_query)
        if count_res and isinstance(count_res, list) and "count" in count_res[0]:
            total_in_db = int(count_res[0]["count"])
    except Exception as e:
        logger.warning(f"No se pudo obtener el count exacto: {e}")
        total_in_db = 388000

    target_total = min(total_in_db, max_records) if max_records else total_in_db
    console.print(f"📊 [bold green]Total de contactos a exportar:[/bold green] [bold yellow]{target_total:,}[/bold yellow] registros\n")

    # CSV headers matching exact GHL Custom Field names
    csv_headers = [
        "First Name", "Last Name", "Phone", "Email", "City", "State", "Timezone",
        "Tags", "Notes", "vTiger ID Cliente", "vTiger Contact No",
        "vTiger Producto Condicion", "vTiger Total Compras",
        "vTiger Monto Ultima Compra USD", "vTiger Total Historico Gastado USD",
        "vTiger Fecha Primera Compra", "vTiger Fecha Ultima Compra",
        "vTiger Campana Origen", "vTiger Canal Captacion", "vTiger Asesor Asignado",
        "vTiger Estado Comercial", "vTiger Fecha Creacion",
        "vTiger Sede / Tienda Compra", "vTiger Última Compra Producto"
    ]

    offset = 0
    file_part = 1
    current_file_rows = 0
    total_exported = 0
    
    current_csv_path = OUTPUT_DIR / f"contactos_vtiger_ghl_parte_{file_part}.csv"
    current_file = open(current_csv_path, mode="w", newline="", encoding="utf-8-sig")
    writer = csv.DictWriter(current_file, fieldnames=csv_headers)
    writer.writeheader()

    generated_files = [current_csv_path]

    start_time = time.time()

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]{task.description}"),
        BarColumn(bar_width=40),
        TextColumn("[bold green]{task.completed:,}/{task.total:,}"),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        console=console
    ) as progress:
        task = progress.add_task("📥 Extrayendo y transformando registros...", total=target_total)

        while True:
            limit = min(CHUNK_SIZE, target_total - offset) if target_total else CHUNK_SIZE
            if limit <= 0:
                break

            q = f"SELECT * FROM Contacts{where_str} LIMIT {offset}, {limit};"
            
            batch = None
            for retry_attempt in range(1, 6):
                try:
                    batch = await vtiger_client.query(q)
                    break
                except Exception as e:
                    wait_sec = retry_attempt * 2
                    logger.warning(f"⚠️ Reintento {retry_attempt}/5 en lote offset {offset}: {e}. Esperando {wait_sec}s...")
                    await asyncio.sleep(wait_sec)
                    try:
                        await vtiger_client.login()
                    except Exception:
                        pass

            if batch is None:
                logger.error(f"❌ No se pudo recuperar el lote offset {offset} tras 5 intentos. Continuando...")
                offset += limit
                continue

            if not batch:
                break

            for raw_contact in batch:
                transformed = transform_full_vtiger_record(raw_contact)
                row = map_record_to_ghl_csv_row(transformed)
                writer.writerow(row)
                
                current_file_rows += 1
                total_exported += 1
                progress.update(task, advance=1)

                # Check if current CSV reached split threshold
                if current_file_rows >= ROWS_PER_CSV and total_exported < target_total:
                    current_file.close()
                    file_part += 1
                    current_file_rows = 0
                    current_csv_path = OUTPUT_DIR / f"contactos_vtiger_ghl_parte_{file_part}.csv"
                    current_file = open(current_csv_path, mode="w", newline="", encoding="utf-8-sig")
                    writer = csv.DictWriter(current_file, fieldnames=csv_headers)
                    writer.writeheader()
                    generated_files.append(current_csv_path)

            current_file.flush()

            if len(batch) < limit:
                break

            offset += limit
            if max_records and total_exported >= max_records:
                break

            # Gentle sleep to respect CRM server capacity
            await asyncio.sleep(0.05)

    current_file.close()
    elapsed = time.time() - start_time

    # Summary Display
    console.print("\n[bold green]╔════════════════════════════════════════════════════════════════════════════════════╗[/bold green]")
    console.print(f"[bold green]║  ✅ EXPORTACIÓN EXITOSA: {total_exported:,} CONTACTOS LISTOS PARA GHL             ║[/bold green]")
    console.print("[bold green]╚════════════════════════════════════════════════════════════════════════════════════╝[/bold green]\n")

    summary_table = Table(title="📁 Archivos CSV Generados Listos para GoHighLevel", show_header=True, header_style="bold magenta")
    summary_table.add_column("#", style="bold", width=4)
    summary_table.add_column("Nombre de Archivo", style="cyan")
    summary_table.add_column("Ubicación", style="yellow")
    summary_table.add_column("Tamaño", justify="right")

    for idx, fpath in enumerate(generated_files, 1):
        if fpath.exists():
            size_mb = fpath.stat().st_size / (1024 * 1024)
            summary_table.add_row(str(idx), fpath.name, str(fpath.parent), f"{size_mb:.2f} MB")

    console.print(summary_table)
    console.print(f"\n⏱️ [bold]Tiempo total:[/bold] {elapsed:.1f}s | 🚀 [bold]Rendimiento:[/bold] {total_exported / max(elapsed, 0.001):.1f} contactos/segundo\n")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Exportador Masivo vTiger CRM a GHL")
    parser.add_argument("--limit", type=int, default=None, help="Límite de contactos a exportar (ej: 100, 1000)")
    parser.add_argument("--year", type=int, default=None, help="Filtrar desde un año específico (ej: 2023)")
    parser.add_argument("--converted-only", action="store_true", help="Exportar solo clientes con estado CONVERTIDO")

    args = parser.parse_args()

    asyncio.run(run_full_export(
        max_records=args.limit,
        filter_year=args.year,
        filter_converted_only=args.converted_only
    ))
