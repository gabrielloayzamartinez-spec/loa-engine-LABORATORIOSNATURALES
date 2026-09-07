import asyncio
import time
import json
import os
from pathlib import Path
from src.core.vtiger_client import vtiger_client

OUTPUT_FILE = Path(r"C:\Users\Lenovo\Desktop\LOA_ENGINE_LABORATORIOS_NATURALES\scratch\sales_orders.json")

async def main():
    print("Conectando a vTiger...")
    success = await vtiger_client.login()
    if not success:
        print("Error de login en vTiger")
        return

    print("Obteniendo total de facturas (SalesOrders)...")
    try:
        count_res = await vtiger_client.query("SELECT count(*) FROM SalesOrder;")
        total_records = int(count_res[0]['count'])
        print(f"✅ Total de facturas en vTiger: {total_records}")
    except Exception as e:
        print("Error al contar:", e)
        return

    all_orders = []
    limit = 100
    offset = 0

    print("Descargando facturas en bloques de 100...")
    start_time = time.time()
    
    while offset < total_records:
        query = f"SELECT contact_id, createdtime, cf_1055, cf_1069, quantity, hdnGrandTotal FROM SalesOrder LIMIT {offset}, {limit};"
        try:
            res = await vtiger_client.query(query)
            if not res:
                break
            all_orders.extend(res)
            print(f"Descargados: {len(all_orders)} / {total_records}")
        except Exception as e:
            print(f"Error en bloque offset {offset}: {e}")
            await asyncio.sleep(2)
            continue
            
        offset += limit
        await asyncio.sleep(0.05) # Rate limiting de seguridad
        
    print(f"Extracción completada en {time.time() - start_time:.2f} segundos.")
    print(f"Guardando {len(all_orders)} facturas en {OUTPUT_FILE}...")
    
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(all_orders, f, ensure_ascii=False, indent=2)
        
    print("✅ Guardado completado con éxito.")

if __name__ == '__main__':
    asyncio.run(main())
