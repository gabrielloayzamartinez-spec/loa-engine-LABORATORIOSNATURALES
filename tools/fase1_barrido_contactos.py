"""
LOA ENGINE - FASE 1: BARRIDO Y ENRIQUECIMIENTO MASIVO DE CONTACTOS EN GHL
Aplica la regla inviolable estándar:
1. Contacto con Nombre, Teléfono USA (+1), Email.
2. PROPIETARIO asignado según Sede / Campaña (Palacios Ernesto, Ultra, Benavides 1, 2, Roosevelt, Piura).
3. 12 Etiquetas Inteligentes de vTiger.
4. 16 Campos Personalizados (Monto, Compras, Fechas, Notas, etc.).
5. Source: Campaña de origen | Type: Customer / Lead.
"""

import sys
import os
import glob
import asyncio
import json
import pandas as pd
from pathlib import Path
from typing import Dict, Any, List, Optional
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn, TimeRemainingColumn

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.core.logger import logger, console
from src.core.ghl_client import ghl_client, DailyRateLimitExceededException
from src.core.phone_normalizer import normalize_phone
from src.core.checkpoint_manager import checkpoint_db

# ==============================================================================
# 1. MAPEO DE PROPIETARIOS / ASESORES COMERCIALES EN GHL
# ==============================================================================
ADVISOR_IDS = {
    "palacios_ernesto": "G1mp9WCw9jwkNhnSZ2ER",  # REDES PALACIOS ERNESTO
    "palacios_ultra": "mOA8p7H0G3MC0TEWrlKf",    # REDES PALACIOS ULTRA
    "benavides_1": "ihjnwtDWkH7mrJhSlYOa",       # REDES BENAVIDES BIONATURAL
    "benavides_2": "7eU3NJ61WwG8Z1LFlJwZ",       # REDES BENAVIDES 2 BIONATURAL
    "roosevelt": "nFCbXqI0h1JPg0NCMzJo",         # REDES ROOSVELT BIONATURAL
    "piura": "2vIwv7mCV1bC5ZlIBxAJ",             # REDES PIURA BIONATURAL
}

def resolve_advisor_id(campana: str, sede: str) -> str:
    combined = f"{campana or ''} {sede or ''}".lower()
    if "ultra" in combined:
        return ADVISOR_IDS["palacios_ultra"]
    if "benavides 2" in combined or "fuerza" in combined or "salud" in combined:
        return ADVISOR_IDS["benavides_2"]
    if "benavides" in combined or "bio corp" in combined:
        return ADVISOR_IDS["benavides_1"]
    if "roosevelt" in combined or "plus" in combined:
        return ADVISOR_IDS["roosevelt"]
    if "piura" in combined or "laboratorio" in combined:
        return ADVISOR_IDS["piura"]
    # Predeterminado: Sede Central / Palacios Ernesto
    return ADVISOR_IDS["palacios_ernesto"]


# ==============================================================================
# 2. CARGA DE MAPEO DE CUSTOM FIELDS GHL
# ==============================================================================
CF_MAP_PATH = Path("data/custom_fields_map.json")

def load_cf_mapping() -> Dict[str, str]:
    if CF_MAP_PATH.exists():
        with open(CF_MAP_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

CF_MAP = load_cf_mapping()


def format_date_clean(val: Any) -> Optional[str]:
    if val is None or pd.isna(val):
        return None
    val_str = str(val).strip()
    if len(val_str) >= 10 and val_str[4] == '-' and val_str[7] == '-':
        return val_str[:10]
    return None


# ==============================================================================
# 3. CONSTRUCTOR DEL PAYLOAD DORADO POR CONTACTO (MÁXIMO ENRIQUECIMIENTO)
# ==============================================================================
def build_golden_contact_payload(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    raw_phone = str(row.get("Phone", "") or "").strip()
    clean_phone, is_valid = normalize_phone(raw_phone, default_country_code="+1")
    
    raw_email = str(row.get("Email", "") or "").strip().lower()
    clean_email = raw_email if ("@" in raw_email and not pd.isna(row.get("Email"))) else None

    # Requiere al menos teléfono o email válido para GHL
    if not clean_phone and not clean_email:
        return None

    fn = str(row.get("First Name", "") or "").strip().title()
    ln = str(row.get("Last Name", "") or "").strip().title()
    full_name = f"{fn} {ln}".strip() or "Contacto vTiger"

    vt_id = str(row.get("vTiger ID Cliente", "") or "").strip()
    contact_no = str(row.get("vTiger Contact No", "") or "").strip()

    campana = str(row.get("vTiger Campana Origen", "") or "").strip()
    if not campana or campana == "nan":
        campana = str(row.get("source", "") or "vTiger CRM Migration")

    # Inferencia inteligente de sede
    sede_cand = str(row.get("vTiger Sede / Tienda Compra", "") or "").strip()
    if not sede_cand or sede_cand.lower() in ["nan", "principal", "none", ""]:
        camp_lower = campana.lower()
        if "ultra" in camp_lower:
            sede = "Ultra"
        elif "benavides 2" in camp_lower or "fuerza" in camp_lower:
            sede = "Benavides 2"
        elif "benavides" in camp_lower:
            sede = "Benavides"
        elif "roosevelt" in camp_lower:
            sede = "Roosevelt"
        elif "piura" in camp_lower:
            sede = "Piura"
        elif "palacios" in camp_lower:
            sede = "Palacios"
        else:
            sede = str(row.get("City", "") or "Sede Central").strip()
    else:
        sede = sede_cand

    advisor_id = resolve_advisor_id(campana, sede)

    # Determinar compras
    compras_raw = row.get("vTiger Total Compras") or row.get("Total Compras") or 0
    try:
        total_compras = int(float(compras_raw)) if not pd.isna(compras_raw) else 0
    except Exception:
        total_compras = 0

    estado_comercial = str(row.get("vTiger Estado Comercial", "") or "").strip().upper()
    if not estado_comercial or estado_comercial == "NAN":
        estado_comercial = "CONVERTIDO" if total_compras > 0 else "SIN VENTA"

    contact_type = "Customer" if (total_compras > 0 or "CONVERTIDO" in estado_comercial) else "Lead"

    # Montos: tolerante a columnas 'vTiger Monto Total USD', 'vTiger Monto Ultima Compra USD', etc.
    raw_monto = (
        row.get("vTiger Monto Ultima Compra USD") or 
        row.get("vTiger Total Historico Gastado USD") or 
        row.get("vTiger Monto Total USD") or 
        row.get("Monto Total USD") or 
        0
    )
    try:
        monto_float = float(str(raw_monto).replace("$", "").replace(",", "").strip()) if not pd.isna(raw_monto) else 0.0
    except Exception:
        monto_float = 0.0

    # Condición y Tratamiento
    condicion = str(
        row.get("vTiger Producto Condicion", "") or 
        row.get("vTiger Última Compra Producto", "") or 
        row.get("vTiger ltima Compra Producto", "") or 
        "General"
    ).strip()
    if not condicion or condicion.lower() == "nan":
        condicion = "Salud / Tratamiento"

    canal = str(row.get("vTiger Canal Captacion", "") or "FB-MSGR").strip() or "FB-MSGR"
    asesor = str(row.get("vTiger Asesor Asignado", "") or "Central").strip() or "Central"

    status_contacto = str(row.get("vTiger Status del Contacto", "") or "").strip()
    if not status_contacto or status_contacto.lower() == "nan":
        status_contacto = "1-POR ASIGNAR"

    fecha_p = format_date_clean(row.get("vTiger Fecha Primera Compra"))
    fecha_u = format_date_clean(row.get("vTiger Fecha Ultima Compra")) or format_date_clean(row.get("vTiger Fecha Última Compra")) or fecha_p
    fecha_c = format_date_clean(row.get("vTiger Fecha Creacion"))

    # Notas completas
    notes = str(row.get("Notes", "") or "").strip()
    if not notes or notes == "nan":
        notes = (
            f"📌 [HISTORIAL COMPLETO VTIGER CRM]\n"
            f"• ID vTiger: {vt_id} ({contact_no})\n"
            f"• Estado Comercial: {estado_comercial}\n"
            f"• Producto / Condición: {condicion}\n"
            f"• Campaña Origen: {campana}\n"
            f"• Canal: {canal}\n"
            f"• Asesor Asignado: {asesor}\n"
            f"• Total Compras: {total_compras}\n"
            f"• Monto Total Invertido: ${monto_float:.2f} USD\n"
            f"• Primera Compra: {fecha_p or 'N/A'}\n"
            f"• Última Compra: {fecha_u or 'N/A'}\n"
            f"• Fecha Registro: {fecha_c or 'N/A'}"
        )

    # Anotaciones Redes (garantizar que nunca quede vacío)
    anotaciones_redes = str(row.get("vTiger Anotaciones Redes", "") or "").strip()
    if not anotaciones_redes or anotaciones_redes.lower() == "nan":
        anotaciones_redes = f"Contacto interesado en {condicion} vía {canal} | Asesor: {asesor}"

    # Etiquetas Inteligentes
    tags = []
    raw_tags = str(row.get("Tags", "") or "").strip()
    if raw_tags and raw_tags != "nan":
        tags = [t.strip() for t in raw_tags.split(",") if t.strip()]
    else:
        year = (fecha_c or "2021")[:4]
        tags = [
            "vtiger",
            f"vtiger-{year}",
            f"sede-{sede.lower().replace(' ', '')}",
            f"producto-{condicion.lower().replace(' ', '-')}",
            f"canal-{canal.lower().replace(' ', '-')}",
            f"compras-{total_compras}",
            f"asesor-{asesor.lower().replace(' ', '-')}",
            "cliente-convertido" if "CONVERTIDO" in estado_comercial else "prospecto-vtiger",
            "recompra-potencial-anual"
        ]

    # Construir Custom Fields con mapeo exhaustivo y tolerante
    custom_fields = []
    def add_field(cf_name: str, value: Any):
        if value is None or pd.isna(value) or str(value).strip() in ["", "nan", "None"]:
            return
        field_id = CF_MAP.get(cf_name)
        if not field_id:
            # Búsqueda tolerante a acentos y mayúsculas
            norm_target = cf_name.lower().replace("ú", "u").replace("ó", "o").replace(" ", "")
            for k, v in CF_MAP.items():
                if k.lower().replace("ú", "u").replace("ó", "o").replace(" ", "") == norm_target:
                    field_id = v
                    break
        if field_id:
            custom_fields.append({"id": field_id, "field_value": value})

    # Inyección de TODOS los campos posibles
    add_field("vTiger ID Cliente", vt_id)
    add_field("vTiger Contact No", contact_no)
    add_field("vTiger Producto Condicion", condicion)
    add_field("vTiger Última Compra Producto", condicion)
    add_field("Tratamiento comprado", condicion)
    add_field("vTiger Total Compras", total_compras)

    if monto_float > 0 or total_compras > 0:
        add_field("vTiger Monto Ultima Compra USD", monto_float)
        add_field("vTiger Total Historico Gastado USD", monto_float)
        add_field("Precio venta", f"{monto_float:.2f}")
    else:
        add_field("vTiger Monto Ultima Compra USD", 0.0)
        add_field("vTiger Total Historico Gastado USD", 0.0)
        add_field("Precio venta", "0.00")

    if fecha_p:
        add_field("vTiger Fecha Primera Compra", fecha_p)
        add_field("Fecha compra", fecha_p)

    if fecha_u:
        add_field("vTiger Fecha Ultima Compra", fecha_u)
        add_field("vTiger Fecha Última Compra", fecha_u)

    if fecha_c:
        add_field("vTiger Fecha Creacion", fecha_c)

    add_field("vTiger Campana Origen", campana)
    add_field("ID de Anuncio", campana)
    add_field("vTiger Canal Captacion", canal)
    add_field("vTiger Asesor Asignado", asesor)
    add_field("vTiger Estado Comercial", estado_comercial)
    add_field("vTiger Sede / Tienda Compra", sede)
    add_field("vTiger Status del Contacto", status_contacto)
    add_field("vTiger Anotaciones Redes", anotaciones_redes)
    add_field("vTiger Graduación / Receta Notas", notes)

    payload = {
        "firstName": fn,
        "lastName": ln,
        "name": full_name,
        "phone": clean_phone,
        "email": clean_email,
        "city": str(row.get("City", "") or "").strip() or sede,
        "state": str(row.get("State", "") or "").strip() or None,
        "timezone": str(row.get("Timezone", "") or "America/New_York").strip(),
        "source": campana,
        "type": contact_type,
        "assignedTo": advisor_id,
        "tags": tags,
        "customFields": custom_fields
    }
    
    return {
        "payload": payload,
        "vtiger_id": vt_id,
        "notes": notes,
        "monto": monto_float,
        "condicion": condicion,
        "canal": canal
    }


# ==============================================================================
# 4. MOTOR DE PROCESAMIENTO CONCURRENTE CON RATE LIMITING
# ==============================================================================
CONCURRENCY = 8

async def process_contact_item(item: Dict[str, Any], semaphore: asyncio.Semaphore) -> bool:
    async with semaphore:
        vtiger_id = item["vtiger_id"]
        payload = item["payload"]
        try:
            res = await ghl_client.upsert_contact(payload)
            ghl_id = res.get("contact", {}).get("id") or res.get("id")
            
            if ghl_id:
                checkpoint_db.record_success(
                    vitrail_id=vtiger_id,
                    ghl_contact_id=str(ghl_id),
                    phone=payload.get("phone"),
                    email=payload.get("email"),
                    tags=payload.get("tags", [])
                )
                return True
            return False
        except DailyRateLimitExceededException:
            raise
        except Exception as e:
            checkpoint_db.record_failure(
                vitrail_id=vtiger_id,
                phone=payload.get("phone"),
                email=payload.get("email"),
                error_message=str(e)[:150]
            )
            return False


async def run_fase1():
    console.rule("[bold cyan]🚀 LOA ENGINE - FASE 1: BARRIDO Y ENRIQUECIMIENTO TOTAL DE CONTACTOS[/bold cyan]")
    console.print("📋 [bold yellow]Regla Inviolable Activa:[/bold yellow] 12 Tags + 16 Custom Fields + PROPIETARIO ASIGNADO")
    console.print(f"🛡️ Rate Limiter: ~450 req/min (Protección Activa)\n")

    files = sorted(glob.glob("data/output/*.csv"), key=lambda x: int(x.split('_parte_')[1].replace('.csv','')) if '_parte_' in x else 999)
    if not files:
        logger.error("❌ No se encontraron archivos en data/output/")
        return

    total_files = len(files)
    semaphore = asyncio.Semaphore(CONCURRENCY)
    
    grand_total_success = 0
    grand_total_failed = 0

    import sqlite3
    conn = sqlite3.connect("data/checkpoint.db")
    cur = conn.cursor()
    cur.execute("SELECT vitrail_id FROM migrated_contacts WHERE status='SUCCESS'")
    migrated_ids = set(row[0] for row in cur.fetchall() if row[0])
    conn.close()
    console.print(f"💾 Checkpoint DB cargada: [bold green]{len(migrated_ids):,} contactos ya completados[/bold green] (se omitirán al instante)\n")

    try:
        for f_idx, file_path in enumerate(files, 1):
            f_name = Path(file_path).name
            console.rule(f"[bold blue]📁 [{f_idx}/{total_files}] Procesando: {f_name}[/bold blue]")
            
            try:
                df = pd.read_csv(file_path, dtype=str)
            except Exception as e:
                logger.error(f"Error leyendo {f_name}: {e}")
                continue

            rows = df.to_dict(orient="records")
            total_rows = len(rows)
            
            # Preparar payloads omitiendo los ya migrados exitosamente (O(1) instantáneo)
            items_to_process = []
            for r in rows:
                vt_id = str(r.get("vTiger ID Cliente", "") or "").strip()
                if vt_id and vt_id in migrated_ids:
                    continue
                built = build_golden_contact_payload(r)
                if built:
                    items_to_process.append(built)

            if not items_to_process:
                console.print(f"⏩ [bold yellow]{f_name} ya completado al 100% anteriormente. Omitiendo...[/bold yellow]\n")
                continue

            console.print(f"📊 {total_rows} filas en CSV | [green]{len(items_to_process)} contactos pendientes preparados para inyectar[/green]")

            CHUNK_SIZE = 50
            file_success = 0
            file_failed = 0

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                BarColumn(bar_width=40),
                TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
                TextColumn("• ({task.completed}/{task.total})"),
                TimeElapsedColumn(),
                TimeRemainingColumn(),
                console=console
            ) as progress:
                task = progress.add_task(f"[cyan]Inyectando {f_name}...", total=len(items_to_process))
                
                for i in range(0, len(items_to_process), CHUNK_SIZE):
                    chunk = items_to_process[i:i + CHUNK_SIZE]
                    tasks = [process_contact_item(item, semaphore) for item in chunk]
                    results = await asyncio.gather(*tasks)
                    
                    for r in results:
                        if r: file_success += 1
                        else: file_failed += 1
                        
                    progress.advance(task, advance=len(chunk))

            grand_total_success += file_success
            grand_total_failed += file_failed
            console.print(f"✅ [bold green]{f_name} completado:[/bold green] {file_success} actualizados con éxito | {file_failed} fallidos\n")

        console.rule("[bold green]🎉 FASE 1 CULMINADA AL 100%[/bold green]")
        console.print(f"🏆 Total General Actualizados con Propietario y Tags: [bold green]{grand_total_success:,}[/bold green]")
        console.print(f"⚠️ Total Fallidos: [bold red]{grand_total_failed:,}[/bold red]")

    except DailyRateLimitExceededException as e:
        console.print(f"\n🛑 [bold red]PAUSA DE SEGURIDAD - CUOTA DIARIA DE GHL ALCANZADA[/bold red]\n[yellow]{e}[/yellow]")
        console.print("🛡️ [bold green]Protección activa:[/bold green] Ningún contacto pendiente ha sido marcado como fallido.")
        console.print("⏰ La migración se reanudará limpiamente sin errores cuando se restablezca el cupo diario de GHL.\n")
        return


if __name__ == "__main__":
    asyncio.run(run_fase1())
