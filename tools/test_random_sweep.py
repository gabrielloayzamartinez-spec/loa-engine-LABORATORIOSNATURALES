import asyncio
import random
from pathlib import Path
from src.core.logger import logger, console
from src.agent_migration.data_extractor import extract_data_from_file
from src.agent_migration.custom_fields_provisioner import setup_custom_fields
from src.loa_engine.pipeline_orchestrator import PipelineOrchestrator

async def run_random_test():
    console.rule("[bold cyan]🧪 PRUEBA RANDOM - LOA ENGINE (5 CONTACTOS)[/bold cyan]")
    
    logger.info("1. Configurando Custom Fields en GHL...")
    field_map = await setup_custom_fields()
    
    logger.info("2. Inicializando LOA Pipeline Orchestrator...")
    orchestrator = PipelineOrchestrator(field_id_map=field_map, concurrency=2)
    orchestrator.start()
    
    logger.info("3. Extrayendo registros del CSV (Parte 1)...")
    file_path = Path("data/output/contactos_vtiger_ghl_parte_1.csv")
    records = extract_data_from_file(file_path)
    
    # Seleccionar 5 registros aleatorios
    random_records = random.sample(records, 5)
    
    logger.info(f"4. Procesando 5 contactos aleatorios (mostrando ID de vTiger)...")
    for r in random_records:
        logger.info(f"   👉 ID Cliente: {r.id_cliente} - Nombre: {r.nombre_completo}")
        await orchestrator.put(r)
            
    logger.info("5. Esperando respuesta de la API de GHL...")
    await orchestrator.join()
    
    stats = orchestrator.stats
    console.print("\n" + "="*60)
    console.print(f"[bold green]✨ Prueba completada.[/bold green]")
    console.print(f"📊 [bold]Resultados LOA Engine:[/bold]")
    console.print(f"   • Procesados Totales: {stats['total']}")
    console.print(f"   • ✅ Exitosos (Actualizados en GHL): {stats['success']}")
    console.print(f"   • ⏭️ Omitidos (Caché local): {stats['skipped']}")
    console.print(f"   • ❌ Fallidos: {stats['failed']}")
    console.print("="*60 + "\n")
    
    logger.info("Para verificar, revisa estos contactos en tu cuenta de GHL.")

if __name__ == "__main__":
    asyncio.run(run_random_test())
