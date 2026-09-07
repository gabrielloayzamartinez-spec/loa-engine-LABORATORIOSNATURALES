import asyncio
import glob
import os
from pathlib import Path
from src.core.logger import logger, console
from src.agent_migration.batch_migrator import run_batch_migration
from src.core.checkpoint_manager import checkpoint_db

async def main():
    console.rule("[bold red]🚨 INICIANDO ACTUALIZACIÓN FORZADA MASIVA (LOA ENGINE)[/bold red]")
    
    # 1. Limpiar la tabla de migrados para que el Radar procese y actualice TODOS
    console.print("[yellow]Forzando actualización: Limpiando historial de checkpoint.db...[/yellow]")
    try:
        with checkpoint_db._get_connection() as conn:
            conn.execute("DELETE FROM migrated_contacts")
            conn.commit()
        console.print("[green]✅ Historial limpiado. El sistema actualizará cada registro en GHL con la información completa.[/green]")
    except Exception as e:
        console.print(f"[red]Error limpiando DB: {e}[/red]")
        return

    # 2. Obtener todos los archivos CSV
    files = glob.glob("data/output/*.csv")
    
    def extract_part(filename):
        try:
            return int(filename.split('_parte_')[1].replace('.csv', ''))
        except:
            return 999
            
    files = sorted(files, key=extract_part)
    
    if not files:
        logger.error("❌ No se encontraron archivos CSV en data/output/")
        return
        
    # 3. Procesar archivo por archivo
    for idx, f in enumerate(files, 1):
        console.rule(f"[bold yellow]🔄 Actualizando Archivo [{idx}/{len(files)}]: {f}[/bold yellow]")
        try:
            stats = await run_batch_migration(Path(f), chunk_size=50)
            logger.info(f"✅ Archivo {f} completado. Actualizados: {stats.success_count}, Fallidos: {stats.error_count}")
        except Exception as e:
            logger.error(f"❌ Error fatal procesando {f}: {e}")

if __name__ == "__main__":
    asyncio.run(main())
