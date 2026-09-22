"""
Configuration Module for vTiger CRM (https://www.vtiger.com) ↔ GoHighLevel (GHL) Enterprise Integration Suite.
Loads typed settings from environment variables using Pydantic.
"""

import os
from pathlib import Path
from typing import Dict, List, Optional
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
INPUT_DIR = DATA_DIR / "input"
LOGS_DIR = DATA_DIR / "logs"
CHECKPOINT_DB_PATH = DATA_DIR / "checkpoint.db"

# Ensure directories exist
DATA_DIR.mkdir(parents=True, exist_ok=True)
INPUT_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore"
    )

    # GoHighLevel (GHL) Settings
    ghl_api_key: str = Field(default="", alias="GHL_API_KEY")
    ghl_location_id: str = Field(default="", alias="GHL_LOCATION_ID")
    ghl_api_base_url: str = Field(default="https://services.leadconnectorhq.com", alias="GHL_API_BASE_URL")
    ghl_api_version: str = Field(default="2021-07-28", alias="GHL_API_VERSION")

    # vTiger CRM (https://www.vtiger.com) Connection Settings
    vtiger_url: str = Field(default="", alias="VTIGER_URL")
    vtiger_username: str = Field(default="", alias="VTIGER_USERNAME")
    vtiger_access_key: str = Field(default="", alias="VTIGER_ACCESS_KEY")

    # Sync Server (Agent 2)
    sync_server_host: str = Field(default="0.0.0.0", alias="SYNC_SERVER_HOST")
    sync_server_port: int = Field(default=8000, alias="SYNC_SERVER_PORT")
    sync_server_secret: str = Field(default="vtiger_ghl_secure_webhook_secret_2026", alias="SYNC_SERVER_SECRET")

    # ETL & Rate Limiting (Agent 1)
    max_concurrent_requests: int = Field(default=8, alias="MAX_CONCURRENT_REQUESTS")
    rate_limit_calls_per_10s: int = Field(default=85, alias="RATE_LIMIT_CALLS_PER_10S")  # GHL safe margin
    batch_chunk_size: int = Field(default=50, alias="BATCH_CHUNK_SIZE")
    retry_max_attempts: int = Field(default=5, alias="RETRY_MAX_ATTEMPTS")

    # Master Custom Fields Definition in GHL
    # Key: field identifier in codebase, Value: exact display name in GHL
    required_custom_fields: Dict[str, Dict[str, str]] = {
        "vtiger_id_cliente": {
            "name": "vTiger ID Cliente",
            "dataType": "TEXT",
            "description": "Identificador único original del cliente en vTiger CRM"
        },
        "vtiger_contact_no": {
            "name": "vTiger Contact No",
            "dataType": "TEXT",
            "description": "Número de contacto interno de vTiger"
        },
        "vtiger_producto_condicion": {
            "name": "vTiger Producto Condicion",
            "dataType": "TEXT",
            "description": "Nombre o descripción del producto o condición"
        },
        "vtiger_total_compras": {
            "name": "vTiger Total Compras",
            "dataType": "NUMERICAL",
            "description": "Número total de compras realizadas"
        },
        "vtiger_monto_total_usd": {
            "name": "vTiger Monto Total USD",
            "dataType": "MONETARY",
            "description": "Total acumulado gastado en USD"
        },
        "vtiger_fecha_primera_compra": {
            "name": "vTiger Fecha Primera Compra",
            "dataType": "DATE",
            "description": "Fecha de la primera compra registrada"
        },
        "vtiger_fecha_ultima_compra": {
            "name": "vTiger Fecha Ultima Compra",
            "dataType": "DATE",
            "description": "Fecha de la última compra registrada"
        },
        "vtiger_campana_origen": {
            "name": "vTiger Campana Origen",
            "dataType": "TEXT",
            "description": "Campaña publicitaria de origen"
        },
        "vtiger_canal_captacion": {
            "name": "vTiger Canal Captacion",
            "dataType": "TEXT",
            "description": "Canal de captación"
        },
        "vtiger_asesor_asignado": {
            "name": "vTiger Asesor Asignado",
            "dataType": "TEXT",
            "description": "Nombre del asesor asignado en vTiger"
        },
        "vtiger_estado_comercial": {
            "name": "vTiger Estado Comercial",
            "dataType": "TEXT",
            "description": "Estado comercial del cliente en vTiger"
        },
        "vtiger_fecha_creacion": {
            "name": "vTiger Fecha Creacion",
            "dataType": "DATE",
            "description": "Fecha de creación del contacto en vTiger"
        }
    }


settings = Settings()
