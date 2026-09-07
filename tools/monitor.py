import sqlite3
import json
import os
import glob
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

DB_PATH = Path("data/checkpoint.db")
LOGS_DIR = r"C:\Users\Lenovo\.gemini\antigravity-ide\brain\1b3cfbf3-7580-4458-bd64-64a37caeb513\.system_generated\tasks"


def get_latest_log_info():
    try:
        list_of_files = glob.glob(os.path.join(LOGS_DIR, '*.log'))
        if not list_of_files:
            return "No hay logs activos", 0
            
        # Ordenar por fecha de modificacion descendente
        list_of_files.sort(key=os.path.getmtime, reverse=True)
        
        target_log = None
        for fpath in list_of_files:
            # Buscar el log de la migracion (ignorando el log del monitor)
            with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
                first_lines = "".join(f.readlines(1000))
                if "run_all_migration_loa.py" in first_lines or "MIGRACI" in first_lines or "Procesando Archivo" in first_lines or "CURACIÓN" in first_lines:
                    target_log = fpath
                    break
                    
        if not target_log:
            return "No se encontro log de migracion", 0
            
        last_progress_line = ""
        archivos_procesados = 0
        
        with open(target_log, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()
            for line in lines:
                if "Procesando Archivo" in line:
                    archivos_procesados += 1
                if "Inyectando a GHL" in line or "saltando" in line.lower() or "procesando" in line.lower():
                    last_progress_line = line.strip()
                    
        # Limpiar caracteres raros de la terminal
        import re
        ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
        last_progress_line = ansi_escape.sub('', last_progress_line)
        
        return last_progress_line[-100:] if last_progress_line else "Iniciando/Escaneando...", archivos_procesados
    except Exception as e:
        return f"Error leyendo log: {e}", 0

class MonitorHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-type", "application/json; charset=utf-8")
        self.send_header("Refresh", "2") 
        self.end_headers()
        
        try:
            conn = sqlite3.connect(DB_PATH)
            cur = conn.cursor()
            
            cur.execute("SELECT count(*) FROM healed_contacts WHERE status='SUCCESS'")
            healed_success_count = cur.fetchone()[0]
            
            cur.execute("SELECT count(*) FROM healed_contacts WHERE status='FAILED'")
            healed_failed_count = cur.fetchone()[0]
            
            cur.execute("SELECT vitrail_id, status, updated_at FROM healed_contacts ORDER BY updated_at DESC LIMIT 5")
            recent = cur.fetchall()
            
            last_activity, archivos = get_latest_log_info()
            
            response = {
                "--- LOA ENGINE LIVE MONITOR ---": "RUNNING",
                "STATS_CURACION_GHL": {
                    "EXITOSOS_TOTALES": healed_success_count,
                    "FALLIDOS_TOTALES": healed_failed_count
                },
                "RITMO_DE_TRABAJO_INTERNO": {
                    "ARCHIVOS_INICIADOS": f"{archivos} de 13",
                    "ACTIVIDAD_EN_TIEMPO_REAL": last_activity.strip()
                },
                "INFO": "La pagina se actualiza sola cada 2 segundos.",
                "ULTIMOS_CONTACTOS_PROCESADOS": [
                    {"id_vtiger": r[0], "estado": r[1], "hora": r[2]} for r in recent
                ]
            }
            
            self.wfile.write(json.dumps(response, indent=4).encode("utf-8"))
        except Exception as e:
            self.wfile.write(json.dumps({"ERROR": str(e)}).encode("utf-8"))

def run():
    port = 8080
    server_address = ('', port)
    httpd = HTTPServer(server_address, MonitorHandler)
    print(f"Monitor en vivo iniciado en: http://localhost:{port}")
    httpd.serve_forever()

if __name__ == "__main__":
    run()
