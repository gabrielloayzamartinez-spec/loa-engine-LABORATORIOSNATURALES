"""
Pilot Runner for Agent 1: Controlled Test Migration Batch.
Executes a dry-run or live pilot batch of 10-50 contacts and displays full validation details.
"""

import asyncio
from pathlib import Path
from typing import List, Optional
from rich.table import Table

from src.config import settings, INPUT_DIR
from src.core.logger import logger, console
from src.core.ghl_client import ghl_client
from src.core.checkpoint_manager import checkpoint_db
from src.core.models import VTigerRawRecord
from src.agent_migration.data_extractor import extract_data_from_file, list_available_input_files
from src.agent_migration.custom_fields_provisioner import setup_custom_fields
from src.agent_migration.transformer import transform_record


def create_sample_pilot_records() -> List[VTigerRawRecord]:
    """Generates realistic sample vTiger CRM records for instant test flights (USA Market)."""
    samples = [
        VTigerRawRecord(
            id_cliente="VIT-US-2019-001",
            nombres="Michael John",
            apellidos="Anderson",
            telefono="(305) 789-1234",
            email="michael.anderson@gmail.com",
            direccion="742 Evergreen Terrace",
            ciudad="Miami, FL",
            producto="Progressive Digital Lenses + Crizal Anti-Glare",
            fecha_compra="2019-05-14",
            monto=450.00,
            total_gastado=1350.00,
            sede="Miami Store",
            graduacion_notas="OD: +1.50 -0.50 x 90 | OI: +1.25 -0.75 x 85 | Add: +2.00"
        ),
        VTigerRawRecord(
            id_cliente="VIT-US-2022-104",
            nombres="Emily Rose",
            apellidos="Davis",
            telefono="213-456-7890",
            email="emily.davis@outlook.com",
            direccion="1200 Grand Ave",
            ciudad="Los Angeles, CA",
            producto="Titanium Designer Frame + Blue Light Filter",
            fecha_compra="2022-11-20",
            monto=380.00,
            total_gastado=380.00,
            sede="Los Angeles Store",
            graduacion_notas="OD: -2.00 | OI: -2.25 | Blue Light Block 420nm"
        ),
        VTigerRawRecord(
            id_cliente="VIT-US-2024-550",
            nombres="David Robert",
            apellidos="Miller",
            telefono="7135550198",
            email="david.miller@techcorp.com",
            direccion="500 Westheimer Rd",
            ciudad="Houston, TX",
            producto="Acuvue Oasys Monthly Contact Lenses (6-pack)",
            fecha_compra="2024-08-10",
            monto=220.00,
            total_gastado=660.00,
            sede="Houston Store",
            graduacion_notas="OD: -3.50 -1.25 x 180 | OI: -3.25 -1.00 x 175"
        ),
        VTigerRawRecord(
            id_cliente="VIT-US-2026-012",
            nombres="Jennifer Marie",
            apellidos="Taylor",
            telefono="+1 (407) 987-6543",
            email="jennifer.taylor@gmail.com",
            direccion="350 Orange Blossom Trail",
            ciudad="Orlando, FL",
            producto="High Index 1.67 Transitions Gen 8 Lenses",
            fecha_compra="2026-02-15",
            monto=590.00,
            total_gastado=1590.00,
            sede="Orlando Store",
            graduacion_notas="OD: +2.25 -1.00 x 45 | OI: +2.00 -1.25 x 135 | Add: +2.50"
        )
    ]
    return samples


async def run_pilot_migration(file_path: Optional[Path] = None, limit: int = 10, dry_run: bool = False):
    """Executes a controlled pilot batch."""
    console.rule("[bold cyan]🚀 AGENTE 1: INICIANDO PRUEBA PILOTO CONTROLADA[/bold cyan]")
    
    # 1. Ensure Custom Fields are provisioned in GHL
    if not dry_run:
        field_map = await setup_custom_fields()
    else:
        field_map = {}

    # 2. Extract Records
    if file_path and file_path.exists():
        raw_records = extract_data_from_file(file_path)[:limit]
    else:
        logger.info("ℹ️ No se especificó archivo. Usando lote de prueba sintético de alta fidelidad.")
        raw_records = create_sample_pilot_records()

    table = Table(title=f"🔬 Lote Piloto ({len(raw_records)} Contactos)", show_header=True, header_style="bold magenta")
    table.add_column("ID vTiger CRM", style="cyan")
    table.add_column("Nombre Completo")
    table.add_column("Teléfono E.164", style="green")
    table.add_column("Producto & Monto")
    table.add_column("Smart Tags", style="yellow")
    table.add_column("Resultado", style="bold")

    success_count = 0
    error_count = 0

    for record in raw_records:
        normalized, ghl_payload = transform_record(record, field_map)
        tags_str = ", ".join(normalized.tags[:4]) + ("..." if len(normalized.tags) > 4 else "")
        prod_monto = f"{normalized.ultima_compra_producto or 'N/A'} (S/ {normalized.monto_ultima_compra:.2f})"

        if dry_run:
            table.add_row(
                normalized.vtiger_id,
                f"{normalized.first_name} {normalized.last_name}",
                normalized.phone or "[dim]Sin teléfono[/dim]",
                prod_monto,
                tags_str,
                "🔍 Dry Run OK"
            )
            success_count += 1
            continue

        try:
            logger.info(f"📤 Enviando a GHL: {normalized.first_name} {normalized.last_name} ({normalized.phone})...")
            res = await ghl_client.upsert_contact(ghl_payload)
            ghl_id = res.get("contact", {}).get("id") or res.get("id", "OK")
            
            # Save to checkpoint
            checkpoint_db.record_success(
                vtiger_id=normalized.vtiger_id,
                ghl_contact_id=str(ghl_id),
                phone=normalized.phone,
                email=normalized.email,
                tags=normalized.tags
            )
            table.add_row(
                normalized.vtiger_id,
                f"{normalized.first_name} {normalized.last_name}",
                normalized.phone or "[dim]Sin teléfono[/dim]",
                prod_monto,
                tags_str,
                f"✅ Inyectado (ID: {str(ghl_id)[:8]}...)"
            )
            success_count += 1
        except Exception as e:
            logger.error(f"❌ Error inyectando {normalized.vtiger_id}: {e}")
            checkpoint_db.record_failure(
                vtiger_id=normalized.vtiger_id,
                phone=normalized.phone,
                email=normalized.email,
                error_message=str(e)
            )
            table.add_row(
                normalized.vtiger_id,
                f"{normalized.first_name} {normalized.last_name}",
                normalized.phone or "[dim]Sin teléfono[/dim]",
                prod_monto,
                tags_str,
                f"❌ Error: {str(e)[:30]}"
            )
            error_count += 1

    console.print(table)
    console.print(f"\n[bold]Resumen Piloto:[/bold] ✅ {success_count} Exitosos | ❌ {error_count} Fallidos\n")
