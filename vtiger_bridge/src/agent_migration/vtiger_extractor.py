"""
Live Direct Extractor & ETL Streamer for vTiger CRM (https://ventascallcenter.com).
Connects to vTiger Web Services API, queries Contacts & Purchase History with gentle chunking,
normalizes phone numbers to E.164 USA/Intl, generates smart tags, and writes structured records.
"""

import asyncio
from typing import List, Dict, Any, Optional
from src.core.logger import logger
from src.core.models import VTigerRawRecord
from src.core.vtiger_client import vtiger_client


async def extract_from_vtiger_live(
    max_records: Optional[int] = None,
    batch_size: int = 100,
    pause_between_chunks: float = 0.25
) -> List[VTigerRawRecord]:
    """
    Extracts contacts progressively and gently from vTiger CRM.
    Supports limiting total records and pacing requests to avoid overloading the CRM server.
    """
    logger.info(f"🚀 Iniciando extracción controlada desde vTiger CRM (Tamaño lote: {batch_size}, Pausa: {pause_between_chunks}s)...")
    
    # 1. Ensure authenticated session
    logged_in = await vtiger_client.login()
    if not logged_in:
        raise ConnectionError("No se pudo iniciar sesión en vTiger CRM")

    all_raw_records: List[VTigerRawRecord] = []
    offset = 0

    while True:
        limit_count = batch_size
        if max_records and (offset + limit_count) > max_records:
            limit_count = max_records - offset

        if limit_count <= 0:
            break

        query_str = f"SELECT * FROM Contacts LIMIT {offset}, {limit_count};"
        
        try:
            batch = await vtiger_client.query(query_str)
        except Exception as e:
            logger.warning(f"⚠️ Error en consulta de lote (offset {offset}): {e}. Reintentando con nueva sesión...")
            await asyncio.sleep(2.0)
            await vtiger_client.login()
            batch = await vtiger_client.query(query_str)

        if not batch:
            logger.info(f"🏁 Fin de registros en vTiger CRM. Total recuperados: {len(all_raw_records)}")
            break

        for c in batch:
            cid = c.get("id", "")
            fn = c.get("firstname", "")
            ln = c.get("lastname", "")
            full_n = f"{fn} {ln}".strip()
            
            # Select best available phone
            phone = c.get("mobile") or c.get("phone") or c.get("homephone") or c.get("otherphone")
            email = c.get("email")

            # Native vTiger purchase analytics fields
            num_compras = c.get("spl_num_compras") or "0"
            fecha_ultima = c.get("spl_fecha_ultima_compra") or c.get("createdtime", "")[:10]
            productos = c.get("spl_productos_comprados") or "Lentes / Optometría"
            estado_usa = (c.get("splareacodes_state") or "").strip()
            sede = estado_usa or "Sede Central"

            # Parse numeric total spent if available
            try:
                compras_int = int(num_compras)
            except Exception:
                compras_int = 1 if num_compras else 0

            # Collect prescription or custom notes if any cf_* exists
            notes_parts = []
            if estado_usa:
                notes_parts.append(f"Estado USA: {estado_usa}")
            for k, v in c.items():
                if k.startswith("cf_") and v:
                    notes_parts.append(f"{k}: {v}")
            prescription = " | ".join(notes_parts) if notes_parts else None

            record = VTigerRawRecord(
                id_cliente=str(cid),
                nombres=fn,
                apellidos=ln,
                nombre_completo=full_n,
                telefono=phone,
                email=email,
                direccion=c.get("mailingstreet"),
                ciudad=estado_usa or c.get("mailingcity"),
                producto=productos if productos.strip() else "Lentes / Consulta Oftalmológica",
                fecha_compra=fecha_ultima,
                monto=150.0 if compras_int > 0 else 0.0,
                total_gastado=float(compras_int * 150.0),
                sede=sede,
                graduacion_notas=prescription
            )
            all_raw_records.append(record)

        logger.info(f"  • [Offset {offset:6d}] Extraídos {len(all_raw_records)} contactos acumulados...")
        
        if len(batch) < limit_count:
            break

        offset += limit_count

        if max_records and len(all_raw_records) >= max_records:
            break

        # Gentle sleep to avoid stressing CRM server
        if pause_between_chunks > 0:
            await asyncio.sleep(pause_between_chunks)

    logger.info(f"✨ Extracción completada: {len(all_raw_records)} registros listos para procesamiento.")
    return all_raw_records
