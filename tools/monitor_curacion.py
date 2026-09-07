import sqlite3
import time
import os
import sys
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn

def monitor_progress():
    console = Console()
    db_path = 'data/checkpoint.db'
    
    if not os.path.exists(db_path):
        console.print("[red]Base de datos no encontrada.[/red]")
        return

    # Total migrados (objetivo a curar)
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT count(*) FROM migrated_contacts WHERE status='SUCCESS'")
        total_migrados = cur.fetchone()[0]
        conn.close()
    except Exception as e:
        console.print(f"[red]Error leyendo base de datos: {e}[/red]")
        return
        
    console.print(f"[bold cyan]🔍 Monitoreando Curación de Contactos en Tiempo Real[/bold cyan]")
    console.print(f"Objetivo Total: [bold yellow]{total_migrados:,}[/bold yellow] contactos.\n")

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(bar_width=50),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        TextColumn("• ({task.completed}/{task.total})"),
        TimeElapsedColumn(),
        console=console
    ) as progress:
        task = progress.add_task("[magenta]Contactos Curados (Actualizados a GHL)...", total=total_migrados)
        
        last_count = 0
        while True:
            try:
                conn = sqlite3.connect(db_path)
                cur = conn.cursor()
                cur.execute("SELECT count(*) FROM healed_contacts WHERE status='SUCCESS'")
                curados = cur.fetchone()[0]
                
                # Check fallidos
                cur.execute("SELECT count(*) FROM healed_contacts WHERE status='FAILED'")
                fallidos = cur.fetchone()[0]
                conn.close()
                
                # Actualizar barra
                if curados > last_count:
                    progress.update(task, completed=curados)
                    last_count = curados
                
                if curados + fallidos >= total_migrados:
                    progress.update(task, completed=total_migrados)
                    break
                    
                time.sleep(2)
            except sqlite3.OperationalError:
                # La tabla podría estar bloqueada temporalmente por el otro script, reintentamos
                time.sleep(2)
            except KeyboardInterrupt:
                break
                
    console.print("\n[bold green]✅ Monitoreo finalizado.[/bold green]")

if __name__ == "__main__":
    try:
        monitor_progress()
    except KeyboardInterrupt:
        sys.exit(0)
