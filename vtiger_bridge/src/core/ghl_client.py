"""
Enterprise GoHighLevel (GHL) API Client with Sliding Window Rate Limiting and Resilience.
Implements strict 100 req / 10s protection, exponential backoff, and async connection pooling.
"""

import asyncio
import time
from typing import Dict, List, Optional, Any, Union
import httpx
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from src.config import settings
from src.core.logger import logger
from src.core.models import GHLContactPayload
from src.core.telemetry import log_api_telemetry


class RateLimitExceededException(Exception):
    """Raised when GHL returns HTTP 429."""
    pass


class AsyncRateLimiter:
    """Sliding window async rate limiter to guarantee <= max_calls within time_window_seconds."""

    def __init__(self, max_calls: int = 85, time_window: float = 10.0):
        self.max_calls = max_calls
        self.time_window = time_window
        self.calls = []
        self._lock = asyncio.Lock()

    async def acquire(self):
        async with self._lock:
            now = time.monotonic()
            # Prune calls older than window
            self.calls = [t for t in self.calls if now - t < self.time_window]

            if len(self.calls) >= self.max_calls:
                oldest = self.calls[0]
                sleep_duration = self.time_window - (now - oldest) + 0.05
                if sleep_duration > 0:
                    logger.debug(f"[RateLimiter] Sleeping {sleep_duration:.2f}s to respect GHL limits...")
                    await asyncio.sleep(sleep_duration)
                    # Refresh calls
                    now = time.monotonic()
                    self.calls = [t for t in self.calls if now - t < self.time_window]

            self.calls.append(time.monotonic())


class GHLClient:
    """Production GoHighLevel API Client for LeadConnector v2 API."""

    def __init__(self):
        self.base_url = settings.ghl_api_base_url.rstrip("/")
        self.api_key = settings.ghl_api_key
        self.location_id = settings.ghl_location_id
        self.api_version = settings.ghl_api_version
        self.rate_limiter = AsyncRateLimiter(
            max_calls=settings.rate_limit_calls_per_10s,
            time_window=10.0
        )
        self.semaphore = asyncio.Semaphore(settings.max_concurrent_requests)
        self._client: Optional[httpx.AsyncClient] = None

    def _get_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Version": self.api_version,
            "Content-Type": "application/json",
            "Accept": "application/json"
        }

    async def get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                headers=self._get_headers(),
                timeout=httpx.Timeout(30.0, connect=10.0),
                limits=httpx.Limits(max_keepalive_connections=20, max_connections=50)
            )
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    @retry(
        reraise=True,
        stop=stop_after_attempt(5),
        wait=wait_exponential(multiplier=1.5, min=2, max=15),
        retry=retry_if_exception_type((RateLimitExceededException, httpx.RequestError, httpx.TimeoutException))
    )
    async def _request(self, method: str, endpoint: str, **kwargs) -> Dict[str, Any]:
        await self.rate_limiter.acquire()
        async with self.semaphore:
            client = await self.get_client()
            url = f"{self.base_url}/{endpoint.lstrip('/')}"
            
            start_time = time.time()
            try:
                response = await client.request(method, url, **kwargs)
                duration_ms = int((time.time() - start_time) * 1000)
                
                log_api_telemetry("Python", method, url, response.status_code, duration_ms)
                
                if response.status_code == 429:
                    logger.warning("⚠️ [GHL 429] Rate limit hit. Backing off exponentially...")
                    raise RateLimitExceededException("GHL Rate Limit 429")

                if response.status_code >= 500:
                    logger.warning(f"⚠️ [GHL {response.status_code}] Server error. Retrying...")
                    response.raise_for_status()

                return response.json() if response.content else {}
            except httpx.HTTPStatusError as e:
                duration_ms = int((time.time() - start_time) * 1000)
                log_api_telemetry("Python", method, url, e.response.status_code, duration_ms)
                logger.error(f"❌ [GHL HTTP {e.response.status_code}] URL: {url} | Body: {e.response.text}")
                raise
            except httpx.RequestError as e:
                duration_ms = int((time.time() - start_time) * 1000)
                log_api_telemetry("Python", method, url, 500, duration_ms)
                logger.error(f"❌ [GHL RequestError] URL: {url} | {str(e)}")
                raise

    # --------------------------------------------------------------------------
    # Custom Fields Operations
    # --------------------------------------------------------------------------
    async def get_custom_fields(self) -> List[Dict[str, Any]]:
        """Fetches all custom fields configured for this location."""
        endpoint = f"locations/{self.location_id}/customFields"
        data = await self._request("GET", endpoint)
        return data.get("customFields", [])

    async def create_custom_field(
        self,
        name: str,
        data_type: str,
        description: str = "",
        model: str = "contact"
    ) -> Dict[str, Any]:
        """Creates a custom field in GHL."""
        endpoint = f"locations/{self.location_id}/customFields"
        payload = {
            "name": name,
            "dataType": data_type,
            "description": description,
            "model": model
        }
        return await self._request("POST", endpoint, json=payload)

    # --------------------------------------------------------------------------
    # Contact Operations
    # --------------------------------------------------------------------------
    async def upsert_contact(self, payload: Union[GHLContactPayload, Dict[str, Any]]) -> Dict[str, Any]:
        """
        Upserts a contact in GoHighLevel.
        LeadConnector API will match by Phone or Email automatically.
        """
        data = payload.model_dump(exclude_none=True) if isinstance(payload, GHLContactPayload) else payload
        data["locationId"] = self.location_id
        endpoint = "contacts/upsert"
        return await self._request("POST", endpoint, json=data)

    async def create_or_update_contact(self, payload: Union[GHLContactPayload, Dict[str, Any]]) -> Dict[str, Any]:
        """Direct creation or update endpoint."""
        data = payload.model_dump(exclude_none=True) if isinstance(payload, GHLContactPayload) else payload
        data["locationId"] = self.location_id
        endpoint = "contacts/"
        return await self._request("POST", endpoint, json=data)

    async def search_contacts(self, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        """Searches contacts by phone, email, or name."""
        endpoint = f"contacts/?locationId={self.location_id}&query={query}&limit={limit}"
        res = await self._request("GET", endpoint)
        return res.get("contacts", [])


ghl_client = GHLClient()
