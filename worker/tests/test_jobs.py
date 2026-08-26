import io

import numpy as np
from PIL import Image

from loupe_worker.jobs import run_job
from loupe_worker.store import LocalStore


class FakeApi:
    def __init__(self, data: bytes):
        self.data = data
        self.completed = []
        self.failed = []

    def download(self, url):
        return self.data

    def complete(self, job, result):
        self.completed.append((job["id"], result))
        return {"candidates": [{"rank": 1, "sku": "NK1"}]}

    def fail(self, job, message, retryable):
        self.failed.append((job["id"], message, retryable))


class FakeVision:
    device = "cpu"

    def embed_reference(self, data):
        return np.ones(1152) / np.sqrt(1152), np.ones(1152) / np.sqrt(1152), (0, 0, 10, 10), False, [0.1] * 15

    def embed_query(self, data):
        return {"embedding": np.ones(1152) / np.sqrt(1152), "crop_box": (0, 0, 10, 10), "fallback_full_frame": False,
                "colour": [0.1] * 15, "timing_ms": {"total": 12}, "thumbnail_webp_base64": "AA=="}


def jpeg_bytes():
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), (120, 90, 30)).save(buffer, "JPEG")
    return buffer.getvalue()


def test_sync_writes_file_sidecar_and_index(tmp_path):
    api = FakeApi(jpeg_bytes())
    store = LocalStore(tmp_path)
    job = {"id": "job-1", "kind": "sync", "lease_token": "t", "reference": {"id": "ref-1", "sku": "NK845", "handle": "necklace-845", "filename": "IMG_1.jpg", "sha256": None, "source_url": "x"}}
    run_job(job, api, store, None)
    path = tmp_path / "originals" / "NK845" / "ref-1.jpg"
    assert path.exists() and path.with_suffix(".json").exists()
    assert api.completed[0][1]["local_path"] == str(path)
    assert store.local_path(job["reference"]) == path
    assert not api.failed


def test_sync_rejects_a_sha_mismatch_as_retryable(tmp_path):
    api = FakeApi(jpeg_bytes())
    job = {"id": "job-2", "kind": "sync", "lease_token": "t", "reference": {"id": "ref-2", "sku": "NK845", "filename": "a.jpg", "sha256": "not-it", "source_url": "x"}}
    run_job(job, api, LocalStore(tmp_path), None)
    assert api.failed and api.failed[0][2] is True and not api.completed


def test_embed_posts_two_views_of_1152(tmp_path):
    api = FakeApi(jpeg_bytes())
    store = LocalStore(tmp_path)
    job = {"id": "job-3", "kind": "embed", "lease_token": "t", "reference": {"id": "ref-3", "sku": "NK1", "filename": "a.jpg", "source_url": "x"}}
    run_job(job, api, store, FakeVision())
    result = api.completed[0][1]
    assert len(result["embeddings"]["full"]) == 1152 and len(result["embeddings"]["crop"]) == 1152
    assert len(result["colour"]) == 15
    assert result["model"] == "siglip2-so400m-512/crop"


def test_identify_posts_a_vector_and_preview(tmp_path):
    api = FakeApi(jpeg_bytes())
    job = {"id": "job-4", "kind": "identify", "lease_token": "t", "event": {"id": "evt-1", "surface": "drive", "source_url": "x"}}
    run_job(job, api, LocalStore(tmp_path), FakeVision())
    result = api.completed[0][1]
    assert len(result["embedding"]) == 1152 and result["thumbnail_webp_base64"] == "AA=="


def test_a_crash_fails_the_job_instead_of_the_loop(tmp_path):
    class BrokenVision(FakeVision):
        def embed_query(self, data):
            raise ValueError("cannot decode")

    api = FakeApi(b"not an image")
    job = {"id": "job-5", "kind": "identify", "lease_token": "t", "event": {"id": "evt-2", "surface": "upload", "source_url": "x"}}
    run_job(job, api, LocalStore(tmp_path), BrokenVision())
    assert api.failed[0][0] == "job-5" and api.failed[0][2] is False


def test_a_failed_failure_report_does_not_kill_the_loop(tmp_path):
    class DownApi(FakeApi):
        def fail(self, job, message, retryable):
            raise RuntimeError("Loupe answered 500")

    api = DownApi(jpeg_bytes())
    job = {"id": "job-3", "kind": "sync", "lease_token": "t", "reference": {"id": "ref-3", "sku": "NK845", "filename": "a.jpg", "sha256": "not-it", "source_url": "x"}}
    run_job(job, api, LocalStore(tmp_path), None)  # must return, not raise
    assert not api.completed
