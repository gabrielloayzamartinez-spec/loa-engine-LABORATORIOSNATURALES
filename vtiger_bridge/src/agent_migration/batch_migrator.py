"""
High-Performance Historic Batch Migration Engine (vTiger CRM ➡️ GoHighLevel 2019-2026).
Processes thousands of contacts with Rate Limiting, Checkpoints, and Live Progress Monitoring.
"""

import asyncio
import csv
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn, TimeRemainingColumn

from src.config import settings, LOGS_DIR
from src.core.logger import logger, console
from src.core.ghl_client import ghl_client
from src.core.checkpoint_manager import checkpoint_db
from src.core.models import VTigerRawRecord, MigrationBatchResult
from src.agent_migration.data_extractor import extract_data_from_file
from src.agent_migration.custom_fields_provisioner import setup_custom_fields
from src.agent_migration.transformer import transform_record


async def process_single_contact(
    record: VTigerRawRecord,
    field_map: dict,
    progress: Progress,
    task_id: int,
    stats: MigrationBatchResult
):
    """Worker function for a single contact migration with checkpoint safety."""
    normalized, ghl_payload = transform_record(record, field_map)

    # 1. Check if already migrated
    if checkpoint_db.is_already_migrated(normalized.vtiger_id, normalized.phone):
        stats.skipped_count += 1
        progress.advance(task_id)
        return

    # 2. Ingest to GoHighLevel
    try:
        res = await ghl_client.upsert_contact(ghl_payload)
        ghl_id = res.get("contact", {}).get("id") or res.get("id", "OK")

        checkpoint_db.record_success(
            vtiger_id=normalized.vtiger_id,
            ghl_contact_id=str(ghl_id),
            phone=normalized.phone,
            email=normalized.email,
            tags=normalized.tags
        )
        stats.success_count += 1
    except Exception as e:
        logger.error(f"❌ Error migrando ID {normalized.vtiger_id} ({normalized.phone}): {e}")
        checkpoint_db.record_failure(
            vtiger_id=normalized.vtiger_id,
            phone=normalized.phone,
            email=normalized.email,
            error_message=str(e)
        )
        stats.error_count += 1
        stats.errors.append({
            "vtiger_id": normalized.vtiger_id,
            "phone": normalized.phone,
            "name": f"{normalized.first_name} {normalized.last_name}",
            "error": str(e)
        })
    finally:
        stats.total_processed += 1
        progress.advance(task_id)


async def run_batch_migration(file_path: Path, chunk_size: int = 50) -> MigrationBatchResult:
    """Executes the full massive historical migration."""
    console.rule("[bold cyan]📦 AGENTE 1: MIGRACIÓN HISTÓRICA MASIVA (2019-2026)[/bold cyan]")
    
    # 1. Setup / Refresh Custom Fields in GHL
    field_map = await setup_custom_fields()

    # 2. Extract Data
    records = extract_data_from_file(file_path)
    total_records = len(records)
    logger.info(f"🚀 Iniciando procesamiento masivo de {total_records} registros históricos...")

    stats = MigrationBatchResult()

    # 3. Rich Live Progress Bar
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        TextColumn("• ({task.completed}/{task.total})"),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        console=console
    ) as progress:
        task_id = progress.add_task("[green]Migrando a GoHighLevel...", total=total_records)

        # Process in asynchronous chunks to optimize memory and connection lifecycle
        for i in range(0, total_records, chunk_size):
            chunk = records[i:i + chunk_size]
            tasks = [
                process_single_contact(rec, field_map, progress, task_id, stats)
                for rec in chunk
            ]
            await asyncio.gather(*tasks)

    # 4. Generate CSV Audit Report
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_file = LOGS_DIR / f"migration_report_{timestamp}.csv"
    with open(report_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Métrica", "Valor"])
        writer.writerow(["Total Registros Archivo", total_records])
        writer.writerow(["Exitosos Inyectados", stats.success_count])
        writer.writerow(["Omitidos (Previamente Migrados)", stats.skipped_count])
        writer.writerow(["Fallidos con Error", stats.error_count])
        if stats.errors:
            writer.writerow([])
            writer.writerow(["ID vTiger CRM", "Nombre", "Teléfono", "Detalle del Error"])
            for err in stats.errors:
                writer.writerow([err["vtiger_id"], err["name"], err["phone"], err["error"]])

    console.print(f"\n[bold green]✨ Migración completada.[/bold green]")
    console.print(f"📊 [bold]Resultados:[/bold] Exitosos: {stats.success_count} | Omitidos: {stats.skipped_count} | Fallidos: {stats.error_count}")
    console.print(f"📄 Reporte de auditoría guardado en: [cyan]{report_file}[/cyan]\n")

    return stats
