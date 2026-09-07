"""
SQLite-backed Persistent Checkpoint Manager.
Ensures zero duplicate ingestion, tracks migration progress, and enables seamless pause/resume.
"""

import sqlite3
import json
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, List, Any, Tuple
from src.config import CHECKPOINT_DB_PATH
from src.core.logger import logger


class CheckpointManager:
    """Manages SQLite migration checkpointing and execution history."""

    def __init__(self, db_path: Path = CHECKPOINT_DB_PATH):
        self.db_path = str(db_path)
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        # Enable WAL mode for high concurrency
        conn.execute("PRAGMA journal_mode=WAL;")
        return conn

    def _init_db(self):
        """Creates required tables and indexes if they don't exist."""
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS migrated_contacts (
                    vtiger_id TEXT PRIMARY KEY,
                    ghl_contact_id TEXT,
                    phone TEXT,
                    email TEXT,
                    status TEXT NOT NULL, -- 'SUCCESS', 'FAILED', 'SKIPPED'
                    error_message TEXT,
                    tags TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_phone ON migrated_contacts(phone);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_email ON migrated_contacts(email);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_status ON migrated_contacts(status);")

            conn.execute("""
                CREATE TABLE IF NOT EXISTS migration_sessions (
                    session_id TEXT PRIMARY KEY,
                    mode TEXT NOT NULL, -- 'PILOT', 'BATCH_HISTORIC', 'REALTIME'
                    start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    end_time TIMESTAMP,
                    total_count INTEGER DEFAULT 0,
                    success_count INTEGER DEFAULT 0,
                    error_count INTEGER DEFAULT 0,
                    status TEXT DEFAULT 'RUNNING'
                );
            """)

            # Queue for the Spider Watcher to replace pending_queue.json
            conn.execute("""
                CREATE TABLE IF NOT EXISTS spider_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    payload TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)
            conn.commit()

    def is_already_migrated(self, vtiger_id: str, phone: Optional[str] = None) -> bool:
        """Checks if a record was already migrated successfully."""
        with self._get_connection() as conn:
            cur = conn.cursor()
            if vtiger_id:
                cur.execute("SELECT status FROM migrated_contacts WHERE vtiger_id = ? AND status = 'SUCCESS'", (str(vtiger_id),))
                if cur.fetchone():
                    return True
            if phone:
                cur.execute("SELECT status FROM migrated_contacts WHERE phone = ? AND status = 'SUCCESS'", (phone,))
                if cur.fetchone():
                    return True
            return False

    def record_success(
        self,
        vtiger_id: str,
        ghl_contact_id: Optional[str],
        phone: Optional[str],
        email: Optional[str],
        tags: List[str]
    ):
        """Records a successful migration record."""
        with self._get_connection() as conn:
            conn.execute("""
                INSERT OR REPLACE INTO migrated_contacts 
                (vtiger_id, ghl_contact_id, phone, email, status, error_message, tags, updated_at)
                VALUES (?, ?, ?, ?, 'SUCCESS', NULL, ?, CURRENT_TIMESTAMP)
            """, (str(vtiger_id), ghl_contact_id, phone, email, json.dumps(tags)))
            conn.commit()

    def record_failure(
        self,
        vtiger_id: str,
        phone: Optional[str],
        email: Optional[str],
        error_message: str
    ):
        """Records a failed migration attempt with error details."""
        with self._get_connection() as conn:
            conn.execute("""
                INSERT OR REPLACE INTO migrated_contacts 
                (vtiger_id, ghl_contact_id, phone, email, status, error_message, updated_at)
                VALUES (?, NULL, ?, ?, 'FAILED', ?, CURRENT_TIMESTAMP)
            """, (str(vtiger_id), phone, email, error_message))
            conn.commit()

    def get_summary_stats(self) -> Dict[str, int]:
        """Returns high-level migration counts."""
        with self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT status, COUNT(*) FROM migrated_contacts GROUP BY status")
            counts = dict(cur.fetchall())
            return {
                "success": counts.get("SUCCESS", 0),
                "failed": counts.get("FAILED", 0),
                "skipped": counts.get("SKIPPED", 0),
                "total": sum(counts.values())
            }

    def get_failed_records(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Retrieves failed records for manual review or re-execution."""
        with self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT vtiger_id, phone, email, error_message, updated_at 
                FROM migrated_contacts 
                WHERE status = 'FAILED' 
                ORDER BY updated_at DESC 
                LIMIT ?
            """, (limit,))
            return [dict(row) for row in cur.fetchall()]

    # --- Spider Queue Methods ---
    
    def enqueue_payload(self, payload: dict):
        """Adds a contact payload to the pending queue."""
        with self._get_connection() as conn:
            conn.execute("INSERT INTO spider_queue (payload) VALUES (?)", (json.dumps(payload),))
            conn.commit()

    def get_queued_payloads(self, limit: int = 100) -> List[Tuple[int, dict]]:
        """Retrieves a batch of payloads from the queue."""
        with self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT id, payload FROM spider_queue ORDER BY id ASC LIMIT ?", (limit,))
            rows = cur.fetchall()
            return [(row["id"], json.loads(row["payload"])) for row in rows]

    def remove_queued_payload(self, queue_id: int):
        """Removes a successfully processed payload from the queue."""
        with self._get_connection() as conn:
            conn.execute("DELETE FROM spider_queue WHERE id = ?", (queue_id,))
            conn.commit()

    def get_queue_size(self) -> int:
        """Returns the total number of items in the queue."""
        with self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM spider_queue")
            row = cur.fetchone()
            return row[0] if row else 0


checkpoint_db = CheckpointManager()
