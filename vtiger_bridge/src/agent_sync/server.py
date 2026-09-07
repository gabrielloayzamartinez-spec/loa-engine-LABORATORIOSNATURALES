"""
High-Performance FastAPI Webhook Server for Agent 2.
Listens 24/7 for bidirectional sync events between vTiger CRM (https://www.vtiger.com) and GoHighLevel.
"""

from typing import Dict, Any
from fastapi import FastAPI, BackgroundTasks, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from src.config import settings
from src.core.logger import logger
from src.core.models import VTigerSaleEvent
from src.core.checkpoint_manager import checkpoint_db
from src.agent_sync.vtiger_to_ghl_handler import process_vtiger_sale_event
from src.agent_sync.ghl_to_vtiger_handler import process_ghl_webhook_event

app = FastAPI(
    title="vTiger CRM ↔ GoHighLevel Real-Time Sync Server",
    description="Bidirectional Webhook & Event Ingestion Engine (Agent 2)",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    """System health check endpoint."""
    stats = checkpoint_db.get_summary_stats()
    return {
        "status": "healthy",
        "service": "vtiger-ghl-sync-engine",
        "crm_target": "https://www.vtiger.com",
        "checkpoint_stats": stats
    }


@app.get("/api/v1/sync/metrics")
async def get_sync_metrics():
    """Returns real-time sync metrics and totals."""
    stats = checkpoint_db.get_summary_stats()
    failed_samples = checkpoint_db.get_failed_records(limit=10)
    return {
        "summary": stats,
        "recent_failed": failed_samples
    }


@app.post("/api/v1/vtiger/sale-event")
@app.post("/api/v1/vTiger CRM/sale-event")
async def handle_vtiger_sale(event: VTigerSaleEvent, background_tasks: BackgroundTasks):
    """
    Endpoint for vTiger CRM Workflows to notify when a sale or customer creation occurs.
    Instantly upserts contact, purchases and custom fields to GoHighLevel.
    """
    try:
        background_tasks.add_task(process_vtiger_sale_event, event)
        return {
            "status": "accepted",
            "message": f"vTiger sale event for '{event.customer_name}' queued for GHL synchronization"
        }
    except Exception as e:
        logger.error(f"❌ Error queuing vTiger sale event: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/ghl/webhook")
async def handle_ghl_webhook(request: Request, background_tasks: BackgroundTasks):
    """
    Endpoint for GoHighLevel to notify when a contact or deal status changes.
    Forwards event to vTiger CRM.
    """
    try:
        raw_body = await request.json()
        background_tasks.add_task(process_ghl_webhook_event, raw_body)
        return {
            "status": "accepted",
            "message": "GHL webhook received and queued for vTiger processing"
        }
    except Exception as e:
        logger.error(f"❌ Error receiving GHL webhook: {e}")
        raise HTTPException(status_code=400, detail="Invalid JSON body")


def start_sync_server():
    """Launches the Uvicorn ASGI server."""
    logger.info(f"🚀 Starting Real-Time Sync Server on http://{settings.sync_server_host}:{settings.sync_server_port}")
    uvicorn.run(
        app,
        host=settings.sync_server_host,
        port=settings.sync_server_port,
        log_level="info"
    )


if __name__ == "__main__":
    start_sync_server()
