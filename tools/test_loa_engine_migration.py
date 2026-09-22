import asyncio
from pathlib import Path
from src.core.logger import logger, console
from src.agent_migration.data_extractor import extract_data_from_file
from src.agent_migration.custom_fields_provisioner import setup_custom_fields
from src.loa_engine.pipeline_orchestrator import PipelineOrchestrator

async def run_test():
    console.rule("[bold cyan]🧪 TESTING LOA ENGINE MIGRATION (10 CONTACTS)[/bold cyan]")
    
    logger.info("1. Configurando Custom Fields (Cache)...")
    field_map = await setup_custom_fields()
    
    logger.info("2. Inicializando LOA Pipeline Orchestrator...")
    orchestrator = PipelineOrchestrator(field_id_map=field_map, concurrency=2)
    orchestrator.start()
    
    logger.info("3. Extrayendo registros del CSV (Parte 1)...")
    file_path = Path("data/output/contactos_vtiger_ghl_parte_1.csv")
    records = extract_data_from_file(file_path)
    
    logger.info("4. Encolando 10 contactos al LOA Engine...")
    count = 0
    for record in records:
        await orchestrator.put(record)
        count += 1
        if count >= 10:
            break
            
    logger.info("5. Esperando a que el motor termine de procesar...")
    await orchestrator.join()
    
    stats = orchestrator.stats
    console.print("\n" + "="*60)
    console.print(f"[bold green]✨ Testing completado con éxito.[/bold green]")
    console.print(f"📊 [bold]Resultados LOA Engine:[/bold]")
    console.print(f"   • Procesados Totales: {stats['total']}")
    console.print(f"   • ✅ Exitosos (Migrados): {stats['success']}")
    console.print(f"   • ⏭️ Omitidos (Duplicados): {stats['skipped']}")
    console.print(f"   • ❌ Fallidos: {stats['failed']}")
    console.print("="*60 + "\n")

if __name__ == "__main__":
    asyncio.run(run_test())
