"""
Interactive Rich Terminal CLI & Master Control Panel for vTiger CRM ↔ GoHighLevel Suite.
"""

import asyncio
import sys
import csv
from pathlib import Path
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.prompt import Prompt, Confirm

from src.config import settings, INPUT_DIR, DATA_DIR
from src.core.logger import console, logger
from src.core.checkpoint_manager import checkpoint_db
from src.core.ghl_client import ghl_client
from src.agent_migration.custom_fields_provisioner import setup_custom_fields
from src.agent_migration.data_extractor import list_available_input_files
from src.agent_migration.pilot_runner import run_pilot_migration
from src.agent_migration.batch_migrator import run_batch_migration
from src.agent_sync.server import start_sync_server


def generate_sample_template_csv():
    """Creates a sample CSV file in data/input for operators (USA Format)."""
    template_path = INPUT_DIR / "plantilla_vTiger CRM_historico.csv"
    headers = [
        "id_cliente", "nombres", "apellidos", "celular", "email",
        "direccion", "ciudad", "producto", "fecha_compra", "monto",
        "total_gastado", "sede", "graduacion_notas"
    ]
    rows = [
        [
            "VIT-US-2019-001", "Michael", "Anderson", "(305) 789-1234", "michael.anderson@gmail.com",
            "742 Evergreen Terrace", "Miami, FL", "Progressive Digital Lenses + Crizal", "2019-05-14", "450.00",
            "1350.00", "Miami Store", "OD: +1.50 | OI: +1.25 | Add: +2.00"
        ],
        [
            "VIT-US-2023-045", "Emily", "Davis", "213-456-7890", "emily.davis@outlook.com",
            "1200 Grand Ave", "Los Angeles, CA", "Titanium Frame + Blue Light Defense", "2023-11-20", "380.00",
            "380.00", "Los Angeles Store", "OD: -2.00 | OI: -2.25"
        ],
        [
            "VIT-US-2026-003", "David", "Miller", "713-555-0198", "david.miller@techcorp.com",
            "500 Westheimer Rd", "Houston, TX", "Acuvue Oasys Monthly Contact Lenses", "2026-01-10", "220.00",
            "660.00", "Houston Store", "OD: -3.50 | OI: -3.25"
        ]
    ]
    with open(template_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        writer.writerows(rows)

    console.print(f"✨ [bold green]Plantilla generada con éxito en:[/bold green] [cyan]{template_path}[/cyan]\n")


async def show_system_diagnostics():
    """Displays connection status and SQLite statistics."""
    console.rule("[bold cyan]🔍 DIAGNÓSTICO DEL SISTEMA & SALUD[/bold cyan]")
    
    # 1. GHL Status
    table_ghl = Table(title="📡 Estado de Configuración GoHighLevel", show_header=True, header_style="bold green")
    table_ghl.add_column("Parámetro")
    table_ghl.add_column("Valor")
    
    masked_key = f"{settings.ghl_api_key[:6]}...{settings.ghl_api_key[-4:]}" if len(settings.ghl_api_key) > 10 else "[dim]No configurada[/dim]"
    table_ghl.add_row("GHL Location ID", settings.ghl_location_id or "[dim]No configurado[/dim]")
    table_ghl.add_row("GHL API Key", masked_key)
    table_ghl.add_row("Base URL", settings.ghl_api_base_url)
    table_ghl.add_row("Rate Limit Configurado", f"{settings.rate_limit_calls_per_10s} req / 10s (Margen de seguridad)")
    console.print(table_ghl)

    # 2. Checkpoint SQLite Stats
    stats = checkpoint_db.get_summary_stats()
    table_db = Table(title="💾 Base de Datos de Checkpoints (SQLite)", show_header=True, header_style="bold blue")
    table_db.add_column("Métrica")
    table_db.add_column("Total Registros")
    table_db.add_row("Contactos Migrados Exitosamente", f"[green]{stats['success']}[/green]")
    table_db.add_row("Contactos Fallidos con Error", f"[red]{stats['failed']}[/red]")
    table_db.add_row("Total en Registro Persistente", f"[bold]{stats['total']}[/bold]")
    console.print(table_db)

    # 3. Failed details if any
    failed = checkpoint_db.get_failed_records(limit=5)
    if failed:
        table_err = Table(title="⚠️ Últimos Errores Registrados", show_header=True, header_style="bold red")
        table_err.add_column("ID vTiger CRM")
        table_err.add_column("Teléfono")
        table_err.add_column("Detalle del Error")
        for f_rec in failed:
            table_err.add_row(f_rec["vtiger_id"], f_rec.get("phone") or "N/A", f_rec.get("error_message", "")[:40])
        console.print(table_err)


async def main_menu():
    """Main CLI event loop."""
    while True:
        console.print("\n")
        console.print(Panel.fit(
            "[bold white]🚀 vTiger CRM ↔ GOHIGHLEVEL (GHL) ENTERPRISE SUITE[/bold white]\n"
            "[dim]Sistema Integral de Migración Histórica (2019-2026) y Sincronizador Bidireccional[/dim]",
            border_style="cyan"
        ))

        console.print("[bold]1.[/bold] [cyan]📋 [Setup][/cyan] Crear / Validar Custom Fields en GoHighLevel")
        console.print("[bold]2.[/bold] [magenta]🔬 [Piloto][/magenta] Ejecutar Prueba Piloto de Migración (Agente 1)")
        console.print("[bold]3.[/bold] [green]📦 [Masivo CSV/Excel][/green] Ejecutar Migración Masiva desde Archivo (2019-2026)")
        console.print("[bold]4.[/bold] [bold blue]🌐 [vTiger Live API][/bold blue] Extraer y Migrar Directo desde vTiger CRM")
        console.print("[bold]5.[/bold] [yellow]🔄 [Sincronizador][/yellow] Iniciar Servidor de Webhooks 24/7 (Agente 2)")
        console.print("[bold]6.[/bold] [blue]📊 [Diagnóstico][/blue] Ver Salud del Sistema y Estadísticas de Checkpoints")
        console.print("[bold]7.[/bold] [cyan]📁 [Plantilla][/cyan] Generar Archivo CSV de Ejemplo en data/input/")
        console.print("[bold]8.[/bold] [red]🚪 Salir[/red]\n")

        choice = Prompt.ask("Selecciona una opción (1-8)", choices=["1", "2", "3", "4", "5", "6", "7", "8"], default="1")

        if choice == "1":
            console.rule("[bold cyan]Aprovisionamiento de Custom Fields[/bold cyan]")
            await setup_custom_fields(force_refresh=True)

        elif choice == "2":
            files = list_available_input_files()
            selected_file = None
            if files:
                console.print("\n[bold]Archivos disponibles en data/input/:[/bold]")
                for idx, f in enumerate(files, 1):
                    console.print(f"  {idx}. {f.name} ({f.stat().st_size / 1024:.1f} KB)")
                console.print(f"  0. Usar lote de prueba sintético predeterminado")
                file_idx = Prompt.ask("Elige el número de archivo", default="0")
                try:
                    if int(file_idx) > 0 and int(file_idx) <= len(files):
                        selected_file = files[int(file_idx) - 1]
                except ValueError:
                    pass

            dry_run = Confirm.ask("¿Deseas ejecutar en modo SIMULACIÓN (Dry Run) sin escribir en GHL?", default=False)
            await run_pilot_migration(file_path=selected_file, limit=10, dry_run=dry_run)

        elif choice == "3":
            files = list_available_input_files()
            if not files:
                console.print("[yellow]⚠️ No se encontraron archivos en data/input/. Coloca un archivo CSV o Excel (.xlsx) primero.[/yellow]")
                if Confirm.ask("¿Deseas generar la plantilla de ejemplo ahora?", default=True):
                    generate_sample_template_csv()
                continue

            console.print("\n[bold]Archivos listos para migración histórica:[/bold]")
            for idx, f in enumerate(files, 1):
                console.print(f"  {idx}. [bold cyan]{f.name}[/bold cyan] ({f.stat().st_size / 1024:.1f} KB)")
            file_idx = Prompt.ask("Selecciona el archivo para migrar masivamente", choices=[str(i) for i in range(1, len(files) + 1)])
            target_file = files[int(file_idx) - 1]

            if Confirm.ask(f"¿Confirmas el inicio de la migración de '{target_file.name}' hacia GoHighLevel?", default=True):
                await run_batch_migration(target_file)

        elif choice == "4":
            from src.agent_migration.vtiger_extractor import extract_from_vtiger_live
            console.rule("[bold blue]Conexión Directa a vTiger CRM (https://www.vtiger.com)[/bold blue]")
            if not settings.vtiger_url or not settings.vtiger_username or not settings.vtiger_access_key:
                console.print("[red]❌ Faltan credenciales de vTiger en el archivo .env[/red]")
                console.print("[yellow]Debes configurar VTIGER_URL, VTIGER_USERNAME y VTIGER_ACCESS_KEY en tu .env[/yellow]")
                continue

            from_year_str = Prompt.ask("¿Desde qué año deseas extraer los datos?", default="2019")
            from_year = int(from_year_str) if from_year_str.isdigit() else 2019
            
            try:
                vtiger_records = await extract_from_vtiger_live(from_year=from_year)
                console.print(f"✅ Se extrajeron [bold green]{len(vtiger_records)}[/bold green] registros desde vTiger CRM.")
                if Confirm.ask("¿Deseas iniciar la migración masiva de estos registros a GoHighLevel?", default=True):
                    # Save temporary extraction and run batch
                    temp_csv = DATA_DIR / "input" / f"vtiger_export_{from_year}_2026.csv"
                    import pandas as pd
                    df = pd.DataFrame([r.model_dump() for r in vtiger_records])
                    df.to_csv(temp_csv, index=False)
                    await run_batch_migration(temp_csv)
            except Exception as e:
                console.print(f"[red]❌ Error conectando a vTiger CRM: {e}[/red]")

        elif choice == "5":
            start_sync_server()

        elif choice == "6":
            await show_system_diagnostics()

        elif choice == "7":
            generate_sample_template_csv()

        elif choice == "8":
            console.print("👋 [bold cyan]Hasta pronto.[/bold cyan] Cerrando panel de control.")
            sys.exit(0)


def main():
    asyncio.run(main_menu())


if __name__ == "__main__":
    main()
