import asyncio
import time
from src.core.vtiger_client import vtiger_client

async def main():
    print("Conectando a vTiger...")
    success = await vtiger_client.login()
    if not success:
        print("Error de login")
        return

    # Contar SalesOrders
    print("Obteniendo 1 SalesOrder...")
    start = time.time()
    try:
        res = await vtiger_client.query("SELECT contact_id, createdtime, cf_1055, cf_1069, quantity, hdnGrandTotal FROM SalesOrder LIMIT 1;")
        print("Response:", res)
    except Exception as e:
        print("Error al obtener:", e)
    except Exception as e:
        print("Error al contar:", e)

    print(f"Tiempo: {time.time() - start:.2f}s")

if __name__ == '__main__':
    asyncio.run(main())
