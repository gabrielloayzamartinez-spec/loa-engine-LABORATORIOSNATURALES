import json
import sqlite3
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

DB_PATH = 'data/checkpoint.db'

HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LOA Engine - Monitor de Curación</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background-color: #0f172a;
            color: #e2e8f0;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
        }
        .container {
            background: #1e293b;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
            width: 80%;
            max-width: 800px;
            text-align: center;
        }
        h1 {
            color: #38bdf8;
            margin-bottom: 30px;
        }
        .stats {
            display: flex;
            justify-content: space-around;
            margin-bottom: 30px;
        }
        .stat-box {
            background: #334155;
            padding: 20px;
            border-radius: 8px;
            width: 30%;
        }
        .stat-value {
            font-size: 32px;
            font-weight: bold;
            color: #10b981;
        }
        .stat-label {
            font-size: 14px;
            color: #94a3b8;
            margin-top: 5px;
        }
        .progress-container {
            background: #334155;
            border-radius: 10px;
            height: 30px;
            width: 100%;
            overflow: hidden;
            margin-bottom: 15px;
        }
        .progress-bar {
            background: linear-gradient(90deg, #3b82f6 0%, #8b5cf6 100%);
            height: 100%;
            width: 0%;
            transition: width 0.5s ease-in-out;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            color: white;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        .footer {
            margin-top: 20px;
            font-size: 12px;
            color: #64748b;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 LOA Engine - Dashboard de Curación Masiva</h1>
        
        <div class="stats">
            <div class="stat-box">
                <div class="stat-value" id="val-total">0</div>
                <div class="stat-label">Total a Curar</div>
            </div>
            <div class="stat-box">
                <div class="stat-value" id="val-curados" style="color: #10b981;">0</div>
                <div class="stat-label">Completados con Éxito</div>
            </div>
            <div class="stat-box">
                <div class="stat-value" id="val-pendientes" style="color: #f59e0b;">0</div>
                <div class="stat-label">Pendientes</div>
            </div>
        </div>

        <div class="progress-container">
            <div class="progress-bar" id="prog-bar">0%</div>
        </div>
        <div class="stat-label" id="status-text">Cargando datos...</div>

        <div class="footer">Actualización en vivo cada 2 segundos. Conectado a la Base de Datos Local.</div>
    </div>

    <script>
        async function fetchData() {
            try {
                const response = await fetch('/api/stats');
                const data = await response.json();
                
                document.getElementById('val-total').innerText = data.total.toLocaleString();
                document.getElementById('val-curados').innerText = data.curados.toLocaleString();
                document.getElementById('val-pendientes').innerText = (data.total - data.curados).toLocaleString();
                
                let percent = 0;
                if(data.total > 0) {
                    percent = (data.curados / data.total) * 100;
                }
                
                document.getElementById('prog-bar').style.width = percent + '%';
                document.getElementById('prog-bar').innerText = percent.toFixed(2) + '%';
                
                document.getElementById('status-text').innerText = "Última actualización: " + new Date().toLocaleTimeString();
            } catch (error) {
                document.getElementById('status-text').innerText = "Error de conexión. Reintentando...";
            }
        }

        setInterval(fetchData, 2000);
        fetchData();
    </script>
</body>
</html>
"""

class MonitorHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Desactivar logs de requests en consola
        
    def do_GET(self):
        parsed_path = urlparse(self.path)
        
        if parsed_path.path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(HTML_TEMPLATE.encode('utf-8'))
            
        elif parsed_path.path == '/api/stats':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            
            try:
                conn = sqlite3.connect(DB_PATH)
                cur = conn.cursor()
                
                cur.execute("SELECT count(*) FROM migrated_contacts WHERE status='SUCCESS'")
                total = cur.fetchone()[0]
                
                curados = 0
                cur.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='healed_contacts'")
                if cur.fetchone()[0]:
                    cur.execute("SELECT count(*) FROM healed_contacts WHERE status='SUCCESS'")
                    curados = cur.fetchone()[0]
                    
                conn.close()
                
                response = {
                    "total": total,
                    "curados": curados
                }
            except Exception as e:
                response = {"total": 0, "curados": 0, "error": str(e)}
                
            self.wfile.write(json.dumps(response).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

def run_server():
    port = 8080
    server_address = ('', port)
    httpd = HTTPServer(server_address, MonitorHandler)
    print(f"✅ Dashboard Web corriendo en: http://localhost:{port}")
    print("Presiona Ctrl+C en esta consola para apagar el servidor.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()
    print("\nServidor apagado.")

if __name__ == '__main__':
    run_server()
