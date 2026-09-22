"""
Automated Custom Fields Provisioner for GoHighLevel (GHL).
Verifies, creates, and maps all required vTiger CRM custom fields in GHL sub-account.
"""

import json
from pathlib import Path
from typing import Dict, Any
from rich.table import Table

from src.config import settings, DATA_DIR
from src.core.logger import logger, console
from src.core.ghl_client import ghl_client

MAP_FILE_PATH = DATA_DIR / "custom_fields_map.json"


async def setup_custom_fields(force_refresh: bool = False) -> Dict[str, str]:
    """
    Checks GHL sub-account for the 7 required vTiger CRM fields.
    Automatically creates any missing fields and returns {internal_key: ghl_field_id}.
    """
    if not force_refresh and MAP_FILE_PATH.exists():
        try:
            with open(MAP_FILE_PATH, "r", encoding="utf-8") as f:
                cached_map = json.load(f)
                if len(cached_map) == len(settings.required_custom_fields):
                    logger.info("⚡ Using cached Custom Fields mapping from data/custom_fields_map.json")
                    return cached_map
        except Exception:
            pass

    logger.info("🔍 Querying GoHighLevel for existing Custom Fields...")
    existing_fields = await ghl_client.get_custom_fields()
    
    # Index existing fields by normalized name
    existing_by_name = {
        f.get("name", "").strip().lower(): f.get("id")
        for f in existing_fields
        if "name" in f and "id" in f
    }

    resolved_map = {}
    table = Table(title="📋 Estado de Custom Fields en GoHighLevel", show_header=True, header_style="bold cyan")
    table.add_column("Campo Requerido", style="bold")
    table.add_column("Tipo de Dato")
    table.add_column("GHL Field ID", style="yellow")
    table.add_column("Estado", style="green")

    for key, spec in settings.required_custom_fields.items():
        name = spec["name"]
        data_type = spec["dataType"]
        normalized_name = name.lower()

        if normalized_name in existing_by_name:
            field_id = existing_by_name[normalized_name]
            resolved_map[key] = field_id
            table.add_row(name, data_type, field_id, "✅ Ya existe")
        else:
            logger.info(f"➕ Creando nuevo Custom Field en GHL: [bold]{name}[/bold] ({data_type})...")
            try:
                created = await ghl_client.create_custom_field(
                    name=name,
                    data_type=data_type,
                    description=spec.get("description", "")
                )
                field_id = created.get("customField", {}).get("id") or created.get("id", "N/A")
                resolved_map[key] = field_id
                table.add_row(name, data_type, str(field_id), "✨ Creado con éxito")
            except Exception as e:
                logger.error(f"❌ Error creando campo '{name}': {e}")
                table.add_row(name, data_type, "ERROR", f"❌ Falló ({e})")

    console.print(table)

    # Save to local cache
    with open(MAP_FILE_PATH, "w", encoding="utf-8") as f:
        json.dump(resolved_map, f, indent=2)

    logger.info("💾 Mapeo de Custom Fields guardado en data/custom_fields_map.json")
    return resolved_map


def get_cached_field_map() -> Dict[str, str]:
    """Returns local cached map or empty dict if not yet provisioned."""
    if MAP_FILE_PATH.exists():
        try:
            with open(MAP_FILE_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}
