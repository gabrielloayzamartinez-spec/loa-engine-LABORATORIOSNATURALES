import asyncio
import os
import sys
import json
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.core.vtiger_client import vtiger_client

async def inspect_silvano():
    await vtiger_client.login()
    
    q = "SELECT * FROM Contacts WHERE firstname LIKE '%SILVANO%' AND lastname LIKE '%REYES%';"
    res = await vtiger_client.query(q)
    
    if not res:
        print("No se encontró a SILVANO REYES")
        return
        
    for c in res:
        print(f"--- Contacto ID: {c.get('id')} ---")
        for k, v in c.items():
            if v and str(v).strip() != "":
                print(f"{k}: {v}")
        print("\n\n")

if __name__ == "__main__":
    asyncio.run(inspect_silvano())
