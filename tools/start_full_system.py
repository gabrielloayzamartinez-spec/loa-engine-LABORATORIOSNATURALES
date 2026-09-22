import sys
import os
import time
import atexit
import subprocess
from rich.console import Console

console = Console()

# Variables para almacenar los subprocesos
sync_server_process = None
monitor_process = None

def cleanup_processes():
    """Cierra los procesos en segundo plano al salir."""
    console.print("\n[yellow]Apagando los sistemas en segundo plano...[/yellow]")
    if sync_server_process and sync_server_process.poll() is None:
        sync_server_process.terminate()
        console.print("[green]✓ Servidor de Webhooks (Ads) detenido.[/green]")
        
    if monitor_process and monitor_process.poll() is None:
        monitor_process.terminate()
        console.print("[green]✓ Monitor en Vivo detenido.[/green]")

# Registrar la función de limpieza para que se ejecute siempre que el script termine
atexit.register(cleanup_processes)

def start_background_services():
    """Inicia el servidor web y el monitor como subprocesos desvinculados de la consola principal."""
    global sync_server_process, monitor_process
    
    console.rule("[bold cyan]INICIALIZANDO ECOSISTEMA COMPLETO[/bold cyan]")
    
    # Iniciar Servidor de Webhooks (Agente 2)
    console.print("[cyan]Iniciando Servidor de Sincronización (Ads/Tiempo Real)...[/cyan]")
    sync_server_process = subprocess.Popen(
        [sys.executable, "-m", "src.agent_sync.server"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    console.print("[green]✓ Servidor activo en http://localhost:8000[/green]")
    
    # Iniciar Monitor en Vivo
    console.print("[cyan]Iniciando Monitor Dashboard...[/cyan]")
    monitor_process = subprocess.Popen(
        [sys.executable, "monitor.py"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    console.print("[green]✓ Monitor activo en http://localhost:8888[/green]")
    
    console.print("\n[dim]Espera un par de segundos mientras los servidores arrancan...[/dim]\n")
    time.sleep(2)

def main():
    # 1. Configurar encoding (para Windows)
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

    # Agregar el directorio actual al PYTHONPATH
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    
    # 2. Encender Servicios Secundarios
    start_background_services()
    
    # 3. Lanzar el CLI en primer plano
    from src.cli.menu import main as menu_main
    menu_main()

if __name__ == "__main__":
    main()
