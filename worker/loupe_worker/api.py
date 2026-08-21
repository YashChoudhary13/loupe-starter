"""HTTP client for Loupe's /api/worker/* — the worker's only connection to anything."""
from __future__ import annotations

import time
from typing import Any

import requests


class LoupeApiError(RuntimeError):
    def __init__(self, message: str, status: int = 0, retryable: bool = True):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class LoupeApi:
    def __init__(self, base_url: str, secret: str, worker_id: str, timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.worker_id = worker_id
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {secret}", "User-Agent": f"loupe-worker/{worker_id}"})

    def _post(self, path: str, body: dict[str, Any]) -> requests.Response:
        try:
            response = self.session.post(f"{self.base_url}{path}", json=body, timeout=self.timeout)
        except requests.RequestException as exc:
            raise LoupeApiError(f"{path}: {exc}", retryable=True) from exc
        if response.status_code == 401:
            raise LoupeApiError("Loupe refused the worker secret (401). Check WORKER_SECRET on both sides.", 401, retryable=False)
        if response.status_code >= 500:
            raise LoupeApiError(f"{path}: Loupe answered {response.status_code}", response.status_code, retryable=True)
        return response

    def heartbeat(self, device: str, kinds: list[str], version: str) -> None:
        self._post("/api/worker/heartbeat", {"worker_id": self.worker_id, "device": device, "kinds": kinds, "version": version})

    def claim(self, kinds: list[str], lease_seconds: int = 600) -> dict[str, Any] | None:
        response = self._post("/api/worker/claim", {"worker_id": self.worker_id, "kinds": kinds, "lease_seconds": lease_seconds})
        if response.status_code == 204:
            return None
        if response.status_code != 200:
            raise LoupeApiError(f"claim: {response.status_code} {response.text[:200]}", response.status_code, retryable=response.status_code >= 500)
        return response.json()

    def complete(self, job: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        response = self._post("/api/worker/complete", {"job_id": job["id"], "lease_token": job["lease_token"], "kind": job["kind"], "result": result})
        if response.status_code == 409:
            raise LoupeApiError(f"complete: lease lost for {job['id']}", 409, retryable=False)
        if response.status_code != 200:
            raise LoupeApiError(f"complete: {response.status_code} {response.text[:200]}", response.status_code, retryable=response.status_code >= 500)
        return response.json()

    def fail(self, job: dict[str, Any], message: str, retryable: bool) -> None:
        response = self._post("/api/worker/complete", {"job_id": job["id"], "lease_token": job["lease_token"], "kind": job["kind"],
                                                       "error": {"message": message[:2000], "retryable": retryable}})
        if response.status_code not in (200, 409):
            raise LoupeApiError(f"fail: {response.status_code} {response.text[:200]}", response.status_code)

    def download(self, url: str) -> bytes:
        """
        GET the job's source bytes. A /api/worker/source URL is Loupe's and takes the
        bearer secret; a presigned R2 URL or a CDN URL carries its own signature and
        must NOT see our Authorization header (S3 rejects two auth mechanisms with 400).
        """
        ours = url.startswith(self.base_url + "/")
        client = self.session if ours else requests
        for attempt in range(3):
            try:
                response = client.get(url, timeout=self.timeout * 2, stream=True)
                if response.status_code >= 400:
                    raise LoupeApiError(f"download: {response.status_code} for {url[:80]}", response.status_code, retryable=response.status_code >= 500)
                return b"".join(response.iter_content(1 << 20))
            except requests.RequestException as exc:
                if attempt == 2:
                    raise LoupeApiError(f"download: {exc}", retryable=True) from exc
                time.sleep(2 * (attempt + 1))
        raise LoupeApiError("download: unreachable", retryable=True)
