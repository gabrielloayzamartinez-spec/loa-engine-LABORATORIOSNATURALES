"""
Data Transformer & Sanitizer for vTiger Historic Records.
Transforms raw vTiger records into validated NormalizedContact and GHLContactPayload structures.
"""

from datetime import datetime, date
from typing import Dict, List, Optional, Tuple, Any
from src.core.models import VTigerRawRecord, NormalizedContact, GHLContactPayload
from src.core.phone_normalizer import normalize_phone
from src.core.tag_generator import generate_smart_tags, slugify
from src.agent_migration.custom_fields_provisioner import get_cached_field_map


def clean_name_parts(raw_first: Optional[str], raw_last: Optional[str], raw_full: Optional[str]) -> Tuple[str, str]:
    """Extracts first and last name cleanly."""
    first = (raw_first or "").strip()
    last = (raw_last or "").strip()

    if first and last:
        return first.title(), last.title()

    full = (raw_full or first or last or "Customer").strip()
    parts = full.split()
    if len(parts) == 1:
        return parts[0].title(), "Customer"
    elif len(parts) == 2:
        return parts[0].title(), parts[1].title()
    elif len(parts) >= 3:
        return " ".join(parts[:2]).title(), " ".join(parts[2:]).title()
    return "Customer", "vTiger"


def parse_numeric(val: Any) -> float:
    """Parses float/int/currency string to float safely."""
    if val is None:
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    clean_str = str(val).replace("$", "").replace(",", "").strip()
    try:
        return float(clean_str)
    except Exception:
        return 0.0


def parse_date_iso(raw_date: Any) -> Tuple[Optional[str], Optional[int]]:
    """Returns (YYYY-MM-DD, Year) or (None, None)."""
    if not raw_date or str(raw_date).strip().lower() in ["none", "null", "nan", ""]:
        return None, None

    if isinstance(raw_date, (datetime, date)):
        return raw_date.strftime("%Y-%m-%d"), raw_date.year

    date_str = str(raw_date).strip()
    formats = [
        "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%Y/%m/%d",
        "%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M:%S"
    ]
    for fmt in formats:
        try:
            dt = datetime.strptime(date_str, fmt)
            return dt.strftime("%Y-%m-%d"), dt.year
        except Exception:
            continue

    import re
    match = re.search(r'\b(20\d\d)\b', date_str)
    year = int(match.group(1)) if match else None
    return date_str[:10], year


def transform_record(record: VTigerRawRecord, field_id_map: Optional[Dict[str, str]] = None) -> Tuple[NormalizedContact, GHLContactPayload]:
    """Transforms a raw vTiger record into a normalized and GHL-ready payload."""
    if field_id_map is None:
        field_id_map = get_cached_field_map()

    # 1. Names
    first_name, last_name = clean_name_parts(record.nombres, record.apellidos, record.nombre_completo)

    # 2. Phone Normalization (Default USA +1)
    phone, is_valid_phone = normalize_phone(record.telefono, default_country_code="+1")

    # 3. Numeric values in USD
    monto = parse_numeric(record.monto)
    total_gastado = parse_numeric(record.total_gastado) or monto

    # 4. Dates
    iso_date, year = parse_date_iso(record.fecha_compra)

    # 5. Branch / Store
    sede = (record.sede or "Principal").strip()

    # 6. Smart Tags
    tags = generate_smart_tags(
        year=year,
        branch=sede,
        product=record.producto,
        amount=monto,
        total_spent=total_gastado,
        purchase_date=iso_date
    )

    # 7. Normalized Contact Model
    normalized = NormalizedContact(
        vtiger_id=str(record.id_cliente),
        first_name=first_name,
        last_name=last_name,
        phone=phone,
        email=(record.email or "").strip().lower() or None,
        address1=(record.direccion or "").strip() or None,
        city=(record.ciudad or "").strip() or None,
        ultima_compra_producto=(record.producto or "").strip() or None,
        fecha_ultima_compra=iso_date,
        monto_ultima_compra=monto,
        total_historico_gastado=total_gastado,
        sede_compra=sede,
        graduacion_notas=(record.graduacion_notas or "").strip() or None,
        tags=tags,
        source_year=year,
        is_valid_phone=is_valid_phone
    )

    # 8. Build GHL Custom Fields List
    custom_fields_payload = []
    
    def add_cf(key: str, value: Any):
        if value is None or value == "":
            return
        ghl_field_id = field_id_map.get(key) or field_id_map.get(key.replace("vtiger_", "vTiger CRM_"))
        if ghl_field_id:
            custom_fields_payload.append({
                "id": ghl_field_id,
                "field_value": value
            })
        else:
            custom_fields_payload.append({
                "key": key,
                "field_value": value
            })

    add_cf("vtiger_id_cliente", normalized.vtiger_id)
    add_cf("vtiger_ultima_compra_producto", normalized.ultima_compra_producto)
    add_cf("vtiger_fecha_ultima_compra", normalized.fecha_ultima_compra)
    add_cf("vtiger_monto_ultima_compra", normalized.monto_ultima_compra)
    add_cf("vtiger_total_historico_gastado", normalized.total_historico_gastado)
    add_cf("vtiger_sede_compra", normalized.sede_compra)
    add_cf("vtiger_graduacion_notas", normalized.graduacion_notas)

    # 9. GHL Contact Payload
    ghl_payload = GHLContactPayload(
        firstName=normalized.first_name,
        lastName=normalized.last_name,
        name=f"{normalized.first_name} {normalized.last_name}",
        email=normalized.email,
        phone=normalized.phone,
        address1=normalized.address1,
        city=normalized.city,
        tags=normalized.tags,
        customFields=custom_fields_payload,
        source="vTiger CRM Migration (2019-2026)"
    )

    return normalized, ghl_payload
