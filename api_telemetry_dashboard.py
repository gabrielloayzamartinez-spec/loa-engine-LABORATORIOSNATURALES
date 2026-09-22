import sqlite3
import os
import sys
from pathlib import Path
from datetime import datetime, timedelta

# Fix Windows console encoding for emojis
sys.stdout.reconfigure(encoding='utf-8')

DB_PATH = Path(__file__).parent / "telemetry.db"

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def get_stats():
    if not DB_PATH.exists():
        print(f"⚠️ La base de datos no existe aún: {DB_PATH}")
        print("Realiza al menos una llamada a GHL a través de Node o Python para que se genere.")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Totales últimas 24h
    cur.execute("SELECT COUNT(*) as total FROM api_telemetry WHERE timestamp >= datetime('now', '-1 day')")
    total_24h = cur.fetchone()['total']

    # Errores y Rate Limits (429, 500)
    cur.execute("SELECT status_code, COUNT(*) as count FROM api_telemetry WHERE status_code >= 400 GROUP BY status_code")
    errors = cur.fetchall()

    # Top 5 Endpoints
    cur.execute("""
        SELECT endpoint, method, COUNT(*) as count, AVG(duration_ms) as avg_ms 
        FROM api_telemetry 
        GROUP BY endpoint, method 
        ORDER BY count DESC 
        LIMIT 5
    """)
    top_endpoints = cur.fetchall()

    # Consumo por sistema
    cur.execute("SELECT system, COUNT(*) as count FROM api_telemetry GROUP BY system")
    systems = cur.fetchall()

    conn.close()

    print("=" * 60)
    print(f"📡 PANEL DE TELEMETRÍA API GHL - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)
    
    print(f"\n📊 Peticiones totales (últimas 24h): {total_24h}")
    
    print("\n🖥️ Consumo por Sistema:")
    for sys_row in systems:
        print(f"  - {sys_row['system']}: {sys_row['count']} llamadas")
        
    print("\n⚠️ Alertas y Errores:")
    if not errors:
        print("  ✅ Cero errores o bloqueos detectados.")
    else:
        for err in errors:
            print(f"  - HTTP {err['status_code']}: {err['count']} veces")

    print("\n🔥 Top 5 Endpoints más consumidos:")
    for ep in top_endpoints:
        print(f"  - [{ep['method']}] {ep['endpoint']}")
        print(f"    └ Llamadas: {ep['count']} | Tiempo prom: {int(ep['avg_ms'])}ms")
        
    print("\n" + "=" * 60)
    print("💡 Optimización sugerida: Si algún endpoint tiene un número desproporcionado")
    print("   de llamadas (ej. más de 5000 al día), considera aplicar caché local.")
    print("=" * 60 + "\n")

if __name__ == "__main__":
    clear_screen()
    get_stats()
