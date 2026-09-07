"""
SYSTEM LABORATORIOS NATURALES by LOA
Demonio de Sincronización Automática: vTiger ➡️ GHL Pipeline Maestro
Con Spider Buffer (Cola de Seguridad)
"""

import sys
import os
import json
import asyncio
import httpx
from datetime import datetime, timezone

# Asegurar que los módulos de la carpeta src se carguen
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.config import settings
from src.core.logger import logger
from src.core.vtiger_client import vtiger_client
from src.agent_migration.full_transformer import transform_full_vtiger_record
from src.core.checkpoint_manager import checkpoint_db

sys.stdout.reconfigure(encoding='utf-8')

STATE_FILE = "last_sync_state.json"
WEBHOOK_URL = "http://localhost:3000/webhook/ghl-contact"
TELEMETRY_URL = "http://localhost:3000/api/telemetry/vtiger"
POLL_INTERVAL_SECONDS = 120  # 2 minutos

# Métricas Locales
metrics = {
    "synced_today": 0
}

def load_last_sync_time():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r") as f:
                data = json.load(f)
                return data.get("last_modified_time", "2010-01-01 00:00:00")
        except Exception as e:
            logger.error(f"Error reading state file: {e}")
    return "2010-01-01 00:00:00"

def save_last_sync_time(timestamp_str):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump({"last_modified_time": timestamp_str}, f)
    except Exception as e:
        logger.error(f"Error saving state file: {e}")

async def send_telemetry(client, status="🟢 Extrayendo..."):
    queue_size = checkpoint_db.get_queue_size()
    try:
        await client.post(TELEMETRY_URL, json={
            "synced": metrics["synced_today"],
            "queue": queue_size,
            "status": status
        })
    except Exception:
        pass # Fallo silencioso de telemetría

async def push_to_maestro(client, contact_payload):
    try:
        res = await client.post(WEBHOOK_URL, json=contact_payload)
        if res.status_code in [200, 201, 202]:
            metrics["synced_today"] += 1
            return True, None
        else:
            return False, f"HTTP {res.status_code}"
    except Exception as e:
        return False, str(e)

async def process_queue(client):
    queue_payloads = checkpoint_db.get_queued_payloads(limit=50) # Extraer hasta 50 en cada ciclo
    if not queue_payloads:
        return

    logger.info(f"🕷️ Procesando Spider Buffer: {len(queue_payloads)} contactos extraídos de SQLite...")
    
    for q_id, item in queue_payloads:
        success, error = await push_to_maestro(client, item)
        if success:
            logger.info(f"    ✅ Rescatado de la cola: {item.get('name')}")
            checkpoint_db.remove_queued_payload(q_id)
        else:
            logger.error(f"    ⚠️ Aún fallando ({error}): {item.get('name')}")
            # Se queda en la base de datos
        await asyncio.sleep(2.0) # Throttling: 1 contacto cada 2 segundos
        await send_telemetry(client)
    
    if checkpoint_db.get_queue_size() == 0:
        logger.info("🎉 Spider Buffer vaciado por completo.")

async def push_with_semaphore(sem, client, contact_payload):
    async with sem:
        success, error = await push_to_maestro(client, contact_payload)
        if success:
            logger.info(f"    ✅ Enviado: {contact_payload.get('name')}")
            return True, None, None
        else:
            logger.warning(f"    ⚠️ Falló ({error}): {contact_payload.get('name')}")
            return False, contact_payload, error

async def poll_vtiger_and_sync():
    logger.info("==================================================================")
    logger.info("🚀 SYSTEM LABORATORIOS NATURALES by LOA - ULTRA SPIDER INICIADO")
    logger.info("==================================================================")
    
    # Aumentar límites del cliente para conexiones concurrentes masivas
    limits = httpx.Limits(max_keepalive_connections=50, max_connections=100)
    async with httpx.AsyncClient(timeout=60.0, limits=limits) as client:
        await send_telemetry(client, "🟢 Iniciando Motor Ultra...")

        while True:
            try:
                await process_queue(client)

                last_time = load_last_sync_time()
                logger.info(f"🔍 Buscando TODOS los contactos modificados desde: {last_time}")
                await send_telemetry(client, "🟢 Extrayendo TODO a RAM")
                
                logged_in = await vtiger_client.login()
                if not logged_in:
                    logger.error("❌ No se pudo autenticar en vTiger CRM")
                    await send_telemetry(client, "🔴 Error de Login")
                    await asyncio.sleep(POLL_INTERVAL_SECONDS)
                    continue

                all_raw_contacts = []
                current_time_pointer = last_time
                
                # FASE 1: EXTRACCIÓN MASIVA A RAM (Contundente)
                while True:
                    q = f"SELECT * FROM Contacts WHERE modifiedtime > '{current_time_pointer}' ORDER BY modifiedtime ASC LIMIT 100;"
                    batch = await vtiger_client.query(q)
                    
                    if not batch:
                        break
                        
                    all_raw_contacts.extend(batch)
                    current_time_pointer = batch[-1].get("modifiedtime")
                    logger.info(f"📥 Descargados {len(batch)} a RAM... Total en RAM: {len(all_raw_contacts)}")
                    await send_telemetry(client, f"Descargando: {len(all_raw_contacts)} en RAM")
                    
                    if len(batch) < 100:
                        break # Ya no hay más páginas
                
                if not all_raw_contacts:
                    logger.info("💤 No se detectaron contactos nuevos.")
                    await send_telemetry(client, "Esperando novedades")
                else:
                    logger.info(f"⚡ ¡EXTRACCIÓN COMPLETADA! {len(all_raw_contacts)} contactos cargados en RAM. Preparando inyección...")
                    await send_telemetry(client, f"Inyectando {len(all_raw_contacts)} a GHL")
                    
                    latest_mod_time = last_time
                    
                    # FASE 2: TRANSFORMACIÓN RÁPIDA (RAM)
                    payloads = []
                    for c in all_raw_contacts:
                        num_compras = int(c.get('cf_2594') or 0)
                        sales_orders = []
                        if num_compras > 0:
                            try:
                                # It's an async call so I can await it.
                                sales_orders = await vtiger_client.query(f"SELECT * FROM SalesOrder WHERE contact_id = '{c.get('id')}';")
                            except Exception as e:
                                logger.error(f"Error fetching SalesOrders for {c.get('id')}: {e}")

                        full_data = transform_full_vtiger_record(c, sales_orders)
                        
                        contact_payload = {
                            "locationId": settings.ghl_location_id,
                            "firstName": full_data.get("firstName", ""),
                            "lastName": full_data.get("lastName", ""),
                            "name": full_data.get("name", ""),
                            "phone": full_data.get("phone", ""),
                            "email": full_data.get("email", ""),
                            "city": full_data.get("city", ""),
                            "state": full_data.get("state", ""),
                            "timezone": full_data.get("timezone", "America/New_York"),
                            "source": full_data.get("source", "vTiger CRM"),
                            "tags": full_data.get("tags", []),
                            "customFields": full_data.get("customFields", []),
                            "notes": full_data.get("notes", "")
                        }
                        payloads.append(contact_payload)
                        
                        mod_time = c.get("modifiedtime")
                        if mod_time and mod_time > latest_mod_time:
                            latest_mod_time = mod_time

                    # FASE 2: INYECCIÓN CONTROLADA (Throttling / Rate Limiting)
                    sem = asyncio.Semaphore(5) # Reducido a 5 conexiones concurrentes máximo
                    
                    batch_size = 20 # Procesar de 20 en 20
                    for i in range(0, len(payloads), batch_size):
                        batch = payloads[i:i+batch_size]
                        logger.info(f"🚀 Inyectando lote {i//batch_size + 1} de {len(payloads)//batch_size + 1} ({len(batch)} contactos)...")
                        
                        tasks = [push_with_semaphore(sem, client, p) for p in batch]
                        results = await asyncio.gather(*tasks)
                        
                        # Manejar fallos del lote actual
                        for success, failed_payload, error in results:
                            if not success and failed_payload:
                                checkpoint_db.enqueue_payload(failed_payload)
                        
                        # Pausa obligatoria entre lotes para no saturar Node ni GHL
                        if i + batch_size < len(payloads):
                            logger.info("⏱️ Pausa de 30 segundos (Cool-down) antes del siguiente lote...")
                            await send_telemetry(client, "⏱️ En pausa (Rate Limit)")
                            await asyncio.sleep(30)
                    
                    save_last_sync_time(latest_mod_time)
                    logger.info(f"💾 Inyección masiva finalizada. Progreso guardado: {latest_mod_time}")

            except Exception as main_e:
                logger.error(f"🔥 Error en el ciclo Ultra: {main_e}")
            
            await send_telemetry(client, "Durmiendo (2 min)")
            logger.info(f"⏳ Esperando {POLL_INTERVAL_SECONDS} segundos...")
            await asyncio.sleep(POLL_INTERVAL_SECONDS)

if __name__ == "__main__":
    try:
        asyncio.run(poll_vtiger_and_sync())
    except KeyboardInterrupt:
        logger.info("🛑 Demonio detenido por el usuario.")
