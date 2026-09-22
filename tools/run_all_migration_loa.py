import asyncio
import glob
from pathlib import Path
from src.core.logger import logger, console
from src.agent_migration.batch_migrator import run_batch_migration

async def main():
    console.rule("[bold magenta]🚀 INICIANDO MIGRACIÓN HISTÓRICA MASIVA (LOA ENGINE)[/bold magenta]")
    
    # We sort by name but we want to ensure parte_1, parte_2 order is correct if possible
    # A simple sort is enough for now, or just glob
    files = glob.glob("data/output/*.csv")
    
    # Sort files properly by the part number in the filename
    def extract_part(filename):
        try:
            return int(filename.split('_parte_')[1].replace('.csv', ''))
        except:
            return 999
            
    files = sorted(files, key=extract_part)
    
    if not files:
        logger.error("❌ No CSV files found in data/output/")
        return
        
    for idx, f in enumerate(files, 1):
        console.rule(f"[bold yellow]🔄 Procesando Archivo [{idx}/{len(files)}]: {f}[/bold yellow]")
        try:
            stats = await run_batch_migration(Path(f), chunk_size=50)
            logger.info(f"✅ Archivo {f} completado. Éxitos: {stats.success_count}, Omitidos: {stats.skipped_count}, Fallidos: {stats.error_count}")
        except Exception as e:
            logger.error(f"❌ Error fatal procesando {f}: {e}")

if __name__ == "__main__":
    asyncio.run(main())
