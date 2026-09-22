import asyncio
import sys
import os
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.config import settings
from src.core.vtiger_client import vtiger_client

async def check_vtiger_database():
    logged_in = await vtiger_client.login()
    if not logged_in:
        print("❌ Error de login en vTiger")
        return
    
    print("✅ Conexión establecida con vTiger CRM")
    
    # Total count
    res_total = await vtiger_client.query("SELECT count(*) FROM Contacts;")
    total = res_total[0]["count"] if res_total else "N/A"
    print(f"📊 Total General de Contactos en vTiger: {total}")
    
    # Total convertidos (compradores)
    try:
        res_conv = await vtiger_client.query("SELECT count(*) FROM Contacts WHERE cf_1876 = 'CONVERTIDO';")
        total_conv = res_conv[0]["count"] if res_conv else "N/A"
        print(f"💰 Total Clientes CONVERTIDOS (Compradores): {total_conv}")
    except Exception as e:
        print("Error en query convertidos:", e)
        
    # Count by recent years
    years = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019]
    print("\n📅 Desglose aproximado por año de creación:")
    for y in years:
        try:
            q = f"SELECT count(*) FROM Contacts WHERE createdtime >= '{y}-01-01 00:00:00' AND createdtime <= '{y}-12-31 23:59:59';"
            res_y = await vtiger_client.query(q)
            c_y = res_y[0]["count"] if res_y else 0
            print(f"  • Año {y}: {c_y} contactos")
        except Exception as e:
            pass

if __name__ == "__main__":
    asyncio.run(check_vtiger_database())
