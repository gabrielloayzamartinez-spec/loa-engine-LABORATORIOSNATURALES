"""
Complete Full-Spectrum Transformer for vTiger CRM Records to GoHighLevel.
Maps standard fields, US timezone/state, purchase history, marketing campaigns,
asesor names, amounts, tags, and complete notes to exact GoHighLevel Custom Fields.
"""

from typing import Dict, List, Any, Optional
from src.core.phone_normalizer import normalize_phone

TIMEZONE_MAP = {
    "ESTE": "America/New_York",
    "CENTRO": "America/Chicago",
    "MONTAÑA": "America/Denver",
    "MONTANA": "America/Denver",
    "PACIFICO": "America/Los_Angeles",
    "PACÍFICO": "America/Los_Angeles"
}


def format_ghl_date(val: Any) -> Optional[str]:
    if not val:
        return None
    val_str = str(val).strip()
    if len(val_str) >= 10 and val_str[4] == '-' and val_str[7] == '-':
        return val_str[:10]
    return None


def safe_int(val: Any, default: int = 1) -> int:
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return default


def safe_float(val: Any, default: float = 0.0) -> float:
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def transform_full_vtiger_record(v_data: dict, sales_orders: list = None) -> dict:
    """Extracts EVERY single data point from vTiger record into GHL full payload."""
    fn = (v_data.get("firstname") or "").strip().title()
    ln = (v_data.get("lastname") or "").strip().title()
    full_name = f"{fn} {ln}".strip() or "Cliente vTiger"

    raw_phone = v_data.get("homephone") or v_data.get("mobile") or v_data.get("phone") or v_data.get("otherphone")
    clean_phone, _ = normalize_phone(raw_phone, default_country_code="+1")

    state_name = (v_data.get("splareacodes_state") or "").strip()
    state_code = (v_data.get("splareacodes_state_code") or "").strip().upper()
    tz_raw = (v_data.get("splareacodes_timezone") or "").strip().upper()
    timezone = TIMEZONE_MAP.get(tz_raw, "America/New_York")

    # Sales & Financials
    num_compras_raw = v_data.get("spl_num_compras") or "1"
    num_compras = safe_int(num_compras_raw, 1)
    
    fecha_primera = v_data.get("spl_fecha_primera_compra") or (v_data.get("createdtime") or "")[:10]
    fecha_ultima = v_data.get("spl_fecha_ultima_compra") or fecha_primera
    
    # Financial amounts from cf fields
    monto_total = safe_float(v_data.get("cf_3392") or v_data.get("cf_3238"), 150.0)
    monto_inicial = safe_float(v_data.get("cf_3238"), monto_total)

    # Marketing & Campaign Metadata
    condicion_producto = v_data.get("cf_2610") or "Salud / Tratamiento"
    canal_origen = v_data.get("cf_3507") or "FB-MSGR"
    metodo_entrada = v_data.get("cf_2572") or "CLICK2RING"
    campana_completa = v_data.get("cf_3472") or f"{metodo_entrada}-{canal_origen}-{condicion_producto}"
    estado_comercial = v_data.get("cf_1876") or "CONVERTIDO"
    asesor = v_data.get("wcf_acf_atf_3390") or v_data.get("cf_3131") or "Central"
    contact_no = v_data.get("contact_no") or ""
    vtiger_id = str(v_data.get("id") or "")
    created_time = v_data.get("createdtime") or ""

    # Parse Campaign Nomenclatures: (sede-proveedor-canal-dolencia)
    campana_parts = campana_completa.split("-")
    if len(campana_parts) >= 4:
        sede_campana = campana_parts[0]
        proveedor_campana = campana_parts[1]
        dolencia_campana = campana_parts[-1]
        canal_campana = "-".join(campana_parts[2:-1])
    else:
        sede_campana = "usa"
        proveedor_campana = "directo"
        dolencia_campana = condicion_producto
        canal_campana = canal_origen

    # Generate rich Smart Tags
    year = created_time[:4] if len(created_time) >= 4 else "2019"
    tags = [
        "vtiger",
        f"vtiger-{year}",
        f"estado-{state_name.lower()}" if state_name else None,
        f"sede-{sede_campana.lower().replace(' ', '')}",
        f"zona-{tz_raw.lower()}" if tz_raw else "zona-este",
        f"producto-{dolencia_campana.lower().replace(' ', '-')}",
        f"canal-{canal_campana.lower().replace(' ', '-')}",
        f"proveedor-{proveedor_campana.lower().replace(' ', '')}",
        f"compras-{num_compras}",
        f"asesor-{asesor.lower().replace(' ', '-')}",
        "cliente-convertido" if "CONVERTIDO" in estado_comercial.upper() else "prospecto-vtiger",
        "recompra-potencial-anual"
    ]
    clean_tags = list(dict.fromkeys([t.replace(" ", "-").strip() for t in tags if t]))

    # Detailed Notes Block
    notes_body = (
        f"📌 [HISTORIAL COMPLETO VTIGER CRM]\n"
        f"• ID vTiger: {vtiger_id} ({contact_no})\n"
        f"• Estado Comercial: {estado_comercial}\n"
        f"• Producto / Condición: {condicion_producto}\n"
        f"• Campaña Origen: {campana_completa}\n"
        f"• Canal: {canal_origen} | Método: {metodo_entrada}\n"
        f"• Asesor Asignado: {asesor}\n"
        f"• Total Compras: {num_compras}\n"
        f"• Monto Total Invertido: ${monto_total:.2f} USD\n"
        f"• Primera Compra: {fecha_primera}\n"
        f"• Última Compra: {fecha_ultima}\n"
        f"• Estado / Zona Horaria: {state_name} ({state_code}) - {tz_raw} ({timezone})\n"
        f"• Fecha Registro vTiger: {created_time}"
    )

    if sales_orders:
        notes_body += "\n\n📦 DESGLOSE DE PRODUCTOS COMPRADOS:\n"
        # Sort sales orders by date (oldest first)
        sorted_so = sorted(sales_orders, key=lambda x: x.get('createdtime', ''))
        for idx, so in enumerate(sorted_so, 1):
            so_date = so.get('cf_1055') or so.get('createdtime', '')[:10]
            product = so.get('cf_1069', 'Producto')
            qty = float(so.get('quantity', 1.0))
            total = float(so.get('hdnGrandTotal', 0.0))
            notes_body += f"  {idx}. {so_date} - {product} x{int(qty)} (${total:.2f})\n"


    # Full Custom Fields Map for GHL (Both ID and Key included for maximum compatibility)
    custom_fields = [
        {"id": "PNr3LsTpXAwmyvPnvI11", "key": "contact.vtiger_id_cliente", "value": vtiger_id, "field_value": vtiger_id},
        {"id": "eBE29SIhviHr2yDJT1Y6", "key": "contact.vtiger_contact_no", "value": contact_no, "field_value": contact_no},
        {"id": "Rr3EXbJwnCOWgFU5FHM3", "key": "contact.vtiger_producto_condicion", "value": condicion_producto, "field_value": condicion_producto},
        {"id": "RgE4PAKDFOP89VIZHavV", "key": "contact.vtiger_ltima_compra_producto", "value": condicion_producto, "field_value": condicion_producto},
        {"id": "WcrrCIL4A2203kIbeFsJ", "key": "contact.tratamiento_comprado", "value": condicion_producto, "field_value": condicion_producto},
        {"id": "3L8KHJEp8fw8ELr081Kl", "key": "contact.vtiger_total_compras", "value": num_compras, "field_value": num_compras},
        {"id": "OnhkGCi6yQkLnoSE1dnP", "key": "contact.vtiger_monto_ultima_compra_usd", "value": monto_total, "field_value": monto_total},
        {"id": "cqmj8bfaRB2Gxug0U5Ql", "key": "contact.vtiger_total_historico_gastado_usd", "value": monto_total, "field_value": monto_total},
        {"id": "5js0Lfbh5XDLq87SDgdT", "key": "contact.precio_venta", "value": f"{monto_total:.2f}", "field_value": f"{monto_total:.2f}"},
        {"id": "SR85C3u6JfnvkdK9hUN6", "key": "contact.vtiger_campana_origen", "value": campana_completa, "field_value": campana_completa},
        {"id": "6w3yMjLgIw6npUKWIosr", "key": "contact.id_de_anuncio", "value": campana_completa, "field_value": campana_completa},
        {"id": "PzuJCcBcrnu4oUq1zLnN", "key": "contact.vtiger_canal_captacion", "value": canal_origen, "field_value": canal_origen},
        {"id": "mgvnRNO04M8CtQ3Kc3fZ", "key": "contact.vtiger_asesor_asignado", "value": asesor, "field_value": asesor},
        {"id": "8EQtKkiW7Z022bcN0vhS", "key": "contact.vtiger_estado_comercial", "value": estado_comercial, "field_value": estado_comercial},
        {"id": "50pTZdtYYYcF1Wtz4j4s", "key": "contact.vtiger_sede__tienda_compra", "value": state_name or sede_campana, "field_value": state_name or sede_campana},
        {"id": "cZu95uKBqVydDEh24enl", "key": "contact.vtiger_graduacin__receta_notas", "value": notes_body, "field_value": notes_body}
    ]

    fecha_p = format_ghl_date(fecha_primera)
    if fecha_p:
        custom_fields.append({"id": "OJYOXVqKp33A6T5HZK5I", "key": "contact.vtiger_fecha_primera_compra", "value": fecha_p, "field_value": fecha_p})
        custom_fields.append({"id": "GZKRu2z1Z156lRUfyrpo", "key": "contact.fecha_compra", "value": fecha_p, "field_value": fecha_p})

    fecha_u = format_ghl_date(fecha_ultima) or fecha_p
    if fecha_u:
        custom_fields.append({"id": "cyn0Ar7GMvmzYBKw0SJu", "key": "contact.vtiger_fecha_ultima_compra", "value": fecha_u, "field_value": fecha_u})
        custom_fields.append({"id": "1U0XzfuI9HUQDqQVMeSV", "key": "contact.vtiger_fecha_ltima_compra", "value": fecha_u, "field_value": fecha_u})

    fecha_c = format_ghl_date(created_time)
    if fecha_c:
        custom_fields.append({"id": "EulM7Gjuxt63t9i7qr1y", "key": "contact.vtiger_fecha_creacion", "value": fecha_c, "field_value": fecha_c})

    return {
        "firstName": fn,
        "lastName": ln,
        "name": full_name,
        "phone": clean_phone,
        "email": v_data.get("email") or None,
        "city": state_name,
        "state": state_code,
        "timezone": timezone,
        "source": campana_completa,
        "tags": clean_tags,
        "customFields": custom_fields,
        "notes": notes_body,
        "vtiger_raw": {
            "id": vtiger_id,
            "contact_no": contact_no,
            "monto_usd": monto_total,
            "num_compras": num_compras,
            "condicion": condicion_producto,
            "campana": campana_completa,
            "canal_origen": canal_origen,
            "metodo_entrada": metodo_entrada,
            "asesor": asesor,
            "estado_comercial": estado_comercial,
            "estado_usa": state_name,
            "zona_horaria": tz_raw,
            "fecha_primera": fecha_primera,
            "fecha_ultima": fecha_ultima,
            "fecha_creacion": created_time
        }
    }
