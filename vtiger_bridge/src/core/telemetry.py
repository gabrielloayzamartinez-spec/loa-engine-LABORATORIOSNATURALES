import sqlite3
import os
from pathlib import Path
import time
from urllib.parse import urlparse

# Ruta a la base de datos de telemetría (1 nivel arriba de vtiger_bridge)
DB_PATH = Path(__file__).parent.parent.parent.parent / "telemetry.db"

def init_telemetry_db():
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute('PRAGMA journal_mode = WAL;')
        
        conn.execute("""
            CREATE TABLE IF NOT EXISTS api_telemetry (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                system TEXT NOT NULL,
                method TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                status_code INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL
            );
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_endpoint ON api_telemetry(endpoint);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_time ON api_telemetry(timestamp);")
        conn.commit()
        return conn
    except Exception as e:
        print(f"❌ Error inicializando Telemetry DB (Python): {e}")
        return None

def log_api_telemetry(system: str, method: str, full_url: str, status_code: int, duration_ms: int):
    try:
        conn = sqlite3.connect(DB_PATH)
        # Extraer solo la ruta del endpoint
        parsed = urlparse(full_url)
        endpoint = parsed.path

        conn.execute(
            "INSERT INTO api_telemetry (system, method, endpoint, status_code, duration_ms) VALUES (?, ?, ?, ?, ?)",
            (system, method.upper(), endpoint, status_code, duration_ms)
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"⚠️ Fallo silencioso al registrar telemetría (Python): {e}")
