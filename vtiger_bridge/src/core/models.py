"""
Pydantic Data Models for vTiger CRM (https://www.vtiger.com) ↔ GoHighLevel Data Integrity & Validation.
"""

from datetime import datetime, date
from typing import Dict, List, Optional, Any, Union
from pydantic import BaseModel, Field, field_validator, model_validator
import math


class VTigerRawRecord(BaseModel):
    """Raw record extracted from vTiger CRM API, Database, CSV or Excel."""
    id_cliente: Optional[Union[str, int]] = Field(default=None, description="vTiger internal contact / record ID")
    nombres: Optional[str] = Field(default=None, description="First names")
    apellidos: Optional[str] = Field(default=None, description="Last names")
    nombre_completo: Optional[str] = Field(default=None, description="Full name if not separated")
    telefono: Optional[Any] = Field(default=None, description="Raw phone or mobile number")
    email: Optional[Any] = Field(default=None, description="Email address")
    direccion: Optional[Any] = Field(default=None, description="Mailing street address")
    ciudad: Optional[Any] = Field(default=None, description="City / State")
    
    # Historic Sales Data from vTiger Invoices/SalesOrders
    producto: Optional[Any] = Field(default=None, description="Purchased product description")
    fecha_compra: Optional[Union[str, date, datetime]] = Field(default=None, description="Purchase date")
    monto: Optional[Union[float, int, str]] = Field(default=0.0, description="Purchase amount in USD")
    total_gastado: Optional[Union[float, int, str]] = Field(default=0.0, description="Lifetime value in USD")
    sede: Optional[Any] = Field(default="Principal", description="Branch or store name")
    graduacion_notas: Optional[Any] = Field(default=None, description="Optical prescription or medical notes")
    estado_orden: Optional[str] = Field(default="Completed", description="Order status")

    @model_validator(mode="before")
    @classmethod
    def sanitize_values(cls, data: Any) -> Any:
        if isinstance(data, dict):
            sanitized = {}
            for k, v in data.items():
                if v is None:
                    sanitized[k] = None
                elif isinstance(v, float) and math.isnan(v):
                    sanitized[k] = None
                elif isinstance(v, (int, float)) and k in ["telefono", "id_cliente", "email", "direccion", "ciudad", "producto", "sede", "graduacion_notas"]:
                    sanitized[k] = str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)
                else:
                    sanitized[k] = v
            return sanitized
        return data


# Legacy alias removed: VTigerRawRecord no longer exists. Use VTigerRawRecord directly.


class NormalizedContact(BaseModel):
    """Cleaned, validated and standardized contact ready for GHL ingestion."""
    vtiger_id: str
    first_name: str
    last_name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    address1: Optional[str] = None
    city: Optional[str] = None
    
    # Custom Fields Values for GHL
    ultima_compra_producto: Optional[str] = None
    fecha_ultima_compra: Optional[str] = None  # ISO format: YYYY-MM-DD
    monto_ultima_compra: float = 0.0
    total_historico_gastado: float = 0.0
    sede_compra: str = "General"
    graduacion_notas: Optional[str] = None
    
    # Calculated Smart Tags
    tags: List[str] = Field(default_factory=list)
    
    # Metadata for tracking
    source_year: Optional[int] = None
    is_valid_phone: bool = False


class GHLContactPayload(BaseModel):
    """Exact JSON structure expected by GoHighLevel Contacts API v2."""
    firstName: str
    lastName: str
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address1: Optional[str] = None
    city: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    customFields: List[Dict[str, Any]] = Field(default_factory=list)
    source: str = "vTiger CRM Migration (2019-2026)"


class VTigerSaleEvent(BaseModel):
    """Real-time event payload emitted by vTiger CRM workflow when a sale occurs."""
    event_type: str = "sale_completed"
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    customer_id: str
    customer_name: str
    customer_phone: str
    customer_email: Optional[str] = None
    product_name: str
    amount: float
    branch_name: str = "General"
    prescription_notes: Optional[str] = None


# Legacy alias removed: VTigerSaleEvent no longer exists. Use VTigerSaleEvent directly.


class GHLWebhookEvent(BaseModel):
    """Webhook payload sent by GoHighLevel when a contact or opportunity updates."""
    type: str
    locationId: str
    contact_id: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    tags: Optional[List[str]] = None
    customFields: Optional[List[Dict[str, Any]]] = None
    opportunity: Optional[Dict[str, Any]] = None
    raw_payload: Optional[Dict[str, Any]] = None


class MigrationBatchResult(BaseModel):
    """Result summary of an ETL migration batch."""
    total_processed: int = 0
    success_count: int = 0
    error_count: int = 0
    updated_count: int = 0
    created_count: int = 0
    skipped_count: int = 0
    errors: List[Dict[str, Any]] = Field(default_factory=list)
