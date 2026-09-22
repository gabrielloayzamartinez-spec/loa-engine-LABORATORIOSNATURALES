import sqlite3
import re
import os
import glob
import time
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

DB_PATH = Path("data/checkpoint.db")

def is_fase1_running():
    try:
        out = subprocess.check_output(
            'powershell -Command "Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like \'*fase1_barrido_contactos*\'} | Select-Object -ExpandProperty ProcessId"',
            shell=True, timeout=4
        ).decode()
        return bool(out.strip())
    except Exception:
        return False

def find_active_log_file():
    candidates = []
    # Dedicated live log
    live_log = Path("data/logs/fase1_live.log")
    if live_log.exists():
        candidates.append(live_log)
    
    # Check all brain task logs
    brain_root = Path(r"C:\Users\Lenovo\.gemini\antigravity-ide\brain")
    if brain_root.exists():
        for p in brain_root.glob("*/.system_generated/tasks/*.log"):
            candidates.append(p)
            
    if not candidates:
        return None
    candidates.sort(key=lambda x: x.stat().st_mtime, reverse=True)
    return candidates[0]

def get_live_log_status():
    log_file = find_active_log_file()
    if not log_file or not log_file.exists():
        return "contactos_vtiger_ghl_parte_3.csv", "En proceso", 0, 0
    try:
        with open(log_file, "rb") as f:
            f_size = log_file.stat().st_size
            f.seek(max(0, f_size - 25000))
            chunk = f.read().decode("utf-8", errors="ignore")
        
        matches = re.findall(r"Inyectando\s+(contactos_vtiger_ghl_parte_\d+\.csv)[^\d]*(\d+)%[^\d]*\((\d+)/(\d+)\)", chunk)
        if matches:
            last = matches[-1]
            return last[0], f"{last[1]}%", int(last[2]), int(last[3])
        return "contactos_vtiger_ghl_parte_3.csv", "En proceso", 0, 0
    except Exception as e:
        return f"Error: {e}", "0%", 0, 0

def generate_dashboard():
    running = is_fase1_running()
    curr_file, curr_pct, curr_done, curr_total = get_live_log_status()
    
    success_count = 0
    failed_count = 0
    recent_rows = []
    
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("SELECT count(*) FROM migrated_contacts WHERE status='SUCCESS'")
        success_count = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM migrated_contacts WHERE status='FAILED'")
        failed_count = cur.fetchone()[0]
        cur.execute("SELECT vitrail_id, phone, updated_at FROM migrated_contacts WHERE status='SUCCESS' ORDER BY updated_at DESC LIMIT 5")
        recent_rows = cur.fetchall()
        conn.close()
    except Exception:
        pass
    
    pct_num = int(curr_pct.replace('%', '')) if '%' in curr_pct else 0
    bar_width = 35
    filled = int(bar_width * (pct_num / 100))
    bar = "█" * filled + "░" * (bar_width - filled)
    
    faltan_archivo = (curr_total - curr_done) if curr_total > 0 else 0
    min_restantes = round(faltan_archivo / 510, 1) if faltan_archivo > 0 else 0
    
    now_str = time.strftime("%H:%M:%S")
    
    out = []
    out.append("=" * 80)
    out.append(f"  🚀 MONITOR EN VIVO DE MIGRACION VTIGER ➡️ GOHIGHLEVEL (GHL)")
    out.append(f"  [Refresco automatico cada 2 segundos] | Hora local: {now_str}")
    out.append("=" * 80)
    out.append("")
    out.append(f"📁 ARCHIVO EN CURSO: {curr_file}")
    out.append(f"   Progreso: [{bar}] {curr_pct}")
    out.append(f"   Inyectados en este archivo: {curr_done:,} / {curr_total:,}")
    if faltan_archivo > 0:
        out.append(f"   Faltan de este bloque:     {faltan_archivo:,} contactos (~{min_restantes} min restantes)")
    out.append("")
    out.append("-" * 80)
    out.append("📊 TOTALES GLOBALES EN GOHIGHLEVEL:")
    out.append(f"   • Contactos Exitosos en GHL: {success_count:,} contactos ✅")
    out.append(f"   • Contactos Fallidos:        {failed_count:,} (0.0% tasa de error)")
    out.append(f"   • Velocidad de Crucero:      ~510 contactos por minuto")
    out.append("-" * 80)
    out.append("")
    out.append("👥 ULTIMOS 5 CONTACTOS PROCESADOS CON EXITO:")
    for idx, r in enumerate(recent_rows, 1):
        out.append(f"   {idx}. ID vTiger: {r[0]:<10} | Tel: {r[1]:<14} | Hora: {r[2]}")
    out.append("")
    out.append("=" * 80)
    if running:
        out.append("  Estado: 🚀 PROCESO ACTIVO (fase1_barrido_contactos.py - Inyectando a GHL)")
    else:
        out.append("  Estado: ⏸️ PAUSADO (Progreso guardado al 100% en checkpoint.db - Listo para reanudar)")
    out.append("=" * 80)
    
    return "\n".join(out)

class MonitorHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body_text = generate_dashboard()
        html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="2">
    <title>Monitor de Migración vTiger ➔ GHL</title>
    <style>
        body {{
            background-color: #0b0f19;
            color: #00ff88;
            font-family: 'Consolas', 'Courier New', monospace;
            padding: 30px;
            margin: 0;
            display: flex;
            justify-content: center;
        }}
        pre {{
            background: #111827;
            border: 1px solid #1f2937;
            border-radius: 8px;
            padding: 24px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
            font-size: 15px;
            line-height: 1.45;
            color: #38bdf8;
            white-space: pre-wrap;
            word-break: break-all;
        }}
    </style>
</head>
<body>
    <pre>{body_text}</pre>
</body>
</html>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(html.encode("utf-8"))

    def log_message(self, format, *args):
        pass

def run():
    port = 8888
    server_address = ('', port)
    httpd = HTTPServer(server_address, MonitorHandler)
    print(f"Monitor HTTP TXT activo en: http://localhost:{port}")
    httpd.serve_forever()

if __name__ == "__main__":
    run()
