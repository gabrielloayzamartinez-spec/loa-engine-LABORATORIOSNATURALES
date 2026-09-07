"""
Official vTiger CRM Web Services REST Client.
Implements challenge-token authentication, SQL-like query interface, and pagination.
Supports vTiger 6.x, 7.x, and vTiger Cloud (8.x / 9.x).
"""

import hashlib
import json
from typing import Dict, List, Optional, Any
import httpx

from src.config import settings
from src.core.logger import logger


class VTigerClient:
    """Client for interacting with vTiger CRM Web Services REST API."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        username: Optional[str] = None,
        access_key: Optional[str] = None
    ):
        self.base_url = (base_url or settings.vtiger_url or "").rstrip("/")
        self.username = username or settings.vtiger_username or ""
        self.access_key = access_key or settings.vtiger_access_key or ""
        self.session_name: Optional[str] = None
        self.user_id: Optional[str] = None

    @property
    def endpoint_url(self) -> str:
        """Returns the webservice.php URL."""
        if "webservice.php" in self.base_url:
            return self.base_url
        return f"{self.base_url}/webservice.php"

    async def login(self) -> bool:
        """
        Performs vTiger challenge-token authentication:
        1. GET getchallenge -> token
        2. MD5(token + accessKey) -> key
        3. POST login -> sessionName
        """
        if not self.base_url or not self.username or not self.access_key:
            logger.error("❌ Credenciales de vTiger incompletas (URL, Usuario o Access Key).")
            return False

        async with httpx.AsyncClient(timeout=20.0) as client:
            try:
                # Step 1: Get challenge token
                res_challenge = await client.get(
                    self.endpoint_url,
                    params={"operation": "getchallenge", "username": self.username}
                )
                data_challenge = res_challenge.json()
                if not data_challenge.get("success"):
                    logger.error(f"❌ Error en getchallenge de vTiger: {data_challenge.get('error')}")
                    return False

                token = data_challenge["result"]["token"]

                # Step 2: Compute MD5 hash: token + access_key
                generated_key = hashlib.md5(f"{token}{self.access_key}".encode("utf-8")).hexdigest()

                # Step 3: Login POST
                res_login = await client.post(
                    self.endpoint_url,
                    data={
                        "operation": "login",
                        "username": self.username,
                        "accessKey": generated_key
                    }
                )
                data_login = res_login.json()
                if not data_login.get("success"):
                    logger.error(f"❌ Error en login de vTiger: {data_login.get('error')}")
                    return False

                self.session_name = data_login["result"]["sessionName"]
                self.user_id = data_login["result"]["userId"]
                logger.info(f"✅ Autenticación exitosa en vTiger CRM (Usuario: {self.username} | Session: {self.session_name[:6]}...)")
                return True

            except Exception as e:
                logger.error(f"❌ Fallo de conexión con vTiger CRM: {e}")
                return False

    async def query(self, vtiger_query: str) -> List[Dict[str, Any]]:
        """
        Executes a SQL-like query against vTiger Web Services.
        Example: query="SELECT * FROM Contacts WHERE createdtime >= '2019-01-01 00:00:00' LIMIT 0, 100;"
        """
        if not self.session_name:
            logged_in = await self.login()
            if not logged_in:
                raise ConnectionError("No se pudo iniciar sesión en vTiger CRM")

        # Ensure query ends with semicolon
        clean_query = vtiger_query.strip()
        if not clean_query.endswith(";"):
            clean_query += ";"

        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(
                self.endpoint_url,
                params={
                    "operation": "query",
                    "sessionName": self.session_name,
                    "query": clean_query
                }
            )
            data = res.json()
            if not data.get("success"):
                error_msg = data.get("error", {}).get("message", str(data))
                # Session expired retry
                if "session" in error_msg.lower() or "authentication" in error_msg.lower():
                    logger.warning("🔄 Sesión de vTiger expirada. Reautenticando...")
                    await self.login()
                    return await self.query(vtiger_query)
                raise RuntimeError(f"Error en consulta vTiger: {error_msg}")

            return data.get("result", [])

    async def fetch_all_contacts(self, from_year: int = 2019, batch_size: int = 100) -> List[Dict[str, Any]]:
        """Fetches all contacts from vTiger since from_year with pagination."""
        all_contacts = []
        offset = 0
        from_date = f"{from_year}-01-01 00:00:00"

        logger.info(f"📥 Consultando contactos históricos desde {from_year} en vTiger CRM...")
        while True:
            q = f"SELECT * FROM Contacts WHERE createdtime >= '{from_date}' LIMIT {offset}, {batch_size};"
            batch = await self.query(q)
            if not batch:
                break
            all_contacts.extend(batch)
            logger.info(f"  • Recuperados {len(all_contacts)} contactos de vTiger...")
            if len(batch) < batch_size:
                break
            offset += batch_size

        return all_contacts

    async def fetch_sales_history(self, from_year: int = 2019, batch_size: int = 100) -> List[Dict[str, Any]]:
        """Fetches Sales Orders / Invoices from vTiger."""
        all_sales = []
        offset = 0
        from_date = f"{from_year}-01-01 00:00:00"

        # Try Invoices first, fallback to SalesOrder
        for module in ["Invoice", "SalesOrder"]:
            try:
                while True:
                    q = f"SELECT * FROM {module} WHERE createdtime >= '{from_date}' LIMIT {offset}, {batch_size};"
                    batch = await self.query(q)
                    if not batch:
                        break
                    all_sales.extend(batch)
                    if len(batch) < batch_size:
                        break
                    offset += batch_size
                if all_sales:
                    break
            except Exception as e:
                logger.debug(f"Módulo {module} no disponible en vTiger: {e}")
                continue

        return all_sales


vtiger_client = VTigerClient()
