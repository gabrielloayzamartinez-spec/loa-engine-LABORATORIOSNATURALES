"""
Multi-format Data Extractor for vTiger CRM Export Files (CSV, Excel, JSON).
Intelligently resolves varying column headers, delimiters, and encodings.
"""

import json
from pathlib import Path
from typing import List, Dict, Any, Optional
import pandas as pd

from src.config import INPUT_DIR
from src.core.logger import logger
from src.core.models import VTigerRawRecord

COLUMN_ALIASES = {
    "id_cliente": ["id", "id_cliente", "cliente_id", "cod_cliente", "codigo", "nro_cliente", "id_paciente", "historia"],
    "nombres": ["nombres", "nombre", "first_name", "nom_cliente", "primer_nombre"],
    "apellidos": ["apellidos", "apellido", "last_name", "ape_cliente", "ap_paterno"],
    "nombre_completo": ["nombre_completo", "cliente", "paciente", "nombre_y_apellidos", "full_name", "razon_social"],
    "telefono": ["telefono", "celular", "phone", "movil", "tel", "cel", "telefono1", "celular1", "contacto", "whatsapp"],
    "email": ["email", "correo", "mail", "correo_electronico", "e_mail"],
    "direccion": ["direccion", "domicilio", "address", "dir", "ubicacion"],
    "ciudad": ["ciudad", "distrito", "city", "departamento", "provincia"],
    "producto": ["producto", "articulo", "descripcion", "item", "compra", "servicio", "lentes", "tratamiento"],
    "fecha_compra": ["fecha", "fecha_compra", "fec_venta", "fec_compra", "date", "created_at", "fecha_emision"],
    "monto": ["monto", "precio", "total", "importe", "valor", "subtotal", "amount", "neto"],
    "total_gastado": ["total_gastado", "ltv", "historico_gastado", "total_ventas", "acumulado"],
    "sede": ["sede", "tienda", "sucursal", "branch", "local", "punto_venta", "establecimiento"],
    "graduacion_notas": ["graduacion", "formula", "receta", "esfera", "cilindro", "eje", "notas", "observaciones", "diagnostico"]
}


def find_matching_field(header: str) -> Optional[str]:
    """Finds standard model field name matching given raw header."""
    clean_header = str(header).strip().lower().replace(" ", "_").replace(".", "").replace("-", "_")
    for field_name, aliases in COLUMN_ALIASES.items():
        if clean_header in aliases:
            return field_name
    return None


def extract_data_from_file(file_path: Path) -> List[VTigerRawRecord]:
    """
    Parses a CSV, Excel or JSON file and converts rows into VTigerRawRecord instances.
    """
    logger.info(f"📂 Reading data file: {file_path.name}")
    ext = file_path.suffix.lower()

    if ext in [".xlsx", ".xls"]:
        df = pd.read_excel(file_path, dtype=str)
    elif ext == ".csv":
        # Auto-detect delimiter and encoding
        encodings = ["utf-8", "latin1", "cp1252", "iso-8859-1"]
        df = None
        for enc in encodings:
            try:
                # Try common delimiters
                for sep in [",", ";", "\t", "|"]:
                    try:
                        temp_df = pd.read_csv(file_path, sep=sep, encoding=enc, dtype=str)
                        if len(temp_df.columns) > 1:
                            df = temp_df
                            break
                    except Exception:
                        continue
                if df is not None:
                    break
            except Exception:
                continue
        if df is None:
            df = pd.read_csv(file_path, dtype=str)
    elif ext == ".json":
        with open(file_path, "r", encoding="utf-8") as f:
            raw_json = json.load(f)
            if isinstance(raw_json, list):
                df = pd.DataFrame(raw_json)
            elif isinstance(raw_json, dict) and "data" in raw_json:
                df = pd.DataFrame(raw_json["data"])
            else:
                df = pd.DataFrame([raw_json])
    else:
        raise ValueError(f"Unsupported file extension: {ext}")

    logger.info(f"📊 Extracted {len(df)} rows and {len(df.columns)} columns from {file_path.name}")

    # Map DataFrame columns to model fields
    column_mapping = {}
    for col in df.columns:
        matched = find_matching_field(col)
        if matched:
            column_mapping[col] = matched

    logger.info(f"🔗 Mapped columns: {column_mapping}")
    df_renamed = df.rename(columns=column_mapping)

    records: List[VTigerRawRecord] = []
    for idx, row in df_renamed.iterrows():
        row_dict = row.to_dict()
        # Clean null/NaN values
        cleaned_row = {
            k: ("" if pd.isna(v) or v == "nan" else str(v).strip())
            for k, v in row_dict.items()
            if k in COLUMN_ALIASES
        }
        
        # Fallback ID generation if missing
        if not cleaned_row.get("id_cliente"):
            cleaned_row["id_cliente"] = f"VIT-{idx + 1000}"

        try:
            record = VTigerRawRecord(**cleaned_row)
            records.append(record)
        except Exception as e:
            logger.warning(f"⚠️ Row {idx} validation warning: {e}")

    return records


def list_available_input_files() -> List[Path]:
    """Returns list of CSV, Excel, and JSON files found in data/input/"""
    supported_extensions = [".csv", ".xlsx", ".xls", ".json"]
    files = [
        p for p in INPUT_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in supported_extensions
    ]
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)
