"""One handler per job kind. Each either completes or fails the job; nothing is left leased."""
from __future__ import annotations

import logging
from typing import Any

from . import MODEL_ID
from .api import LoupeApi, LoupeApiError
from .store import LocalStore
from .vision import Vision

log = logging.getLogger("loupe-worker")


def _vec(v) -> list[float]:
    return [round(float(x), 7) for x in v]


def handle_sync(job: dict[str, Any], api: LoupeApi, store: LocalStore) -> None:
    reference = job["reference"]
    data = api.download(reference["source_url"])
    path, digest = store.save(job, data)
    expected = reference.get("sha256")
    if expected and expected != digest:
        raise LoupeApiError(f"sha256 mismatch for {reference['id']}: expected {expected}, got {digest}", retryable=True)
    api.complete(job, {"local_path": str(path), "sha256": digest, "bytes": len(data)})
    log.info("synced %s %s -> %s (%d bytes)", reference.get("sku"), reference["id"], path, len(data))


def handle_embed(job: dict[str, Any], api: LoupeApi, store: LocalStore, vision: Vision) -> None:
    reference = job["reference"]
    path = store.local_path(reference)
    if path is None:
        # Not on this disk (another worker synced it, or the file was moved): fetch, and keep a copy.
        data = api.download(reference["source_url"])
        path, _ = store.save(job, data)
    full, crop, box, fallback = vision.embed_reference(path.read_bytes())
    api.complete(job, {"embeddings": {"full": _vec(full), "crop": _vec(crop)}, "model": MODEL_ID,
                       "crop_box": list(box), "fallback_full_frame": fallback})
    store.mark_embedded(reference["id"])
    log.info("embedded %s %s (box=%s%s)", reference.get("sku"), reference["id"], box, ", full frame" if fallback else "")


def handle_identify(job: dict[str, Any], api: LoupeApi, vision: Vision) -> None:
    event = job["event"]
    data = api.download(event["source_url"])
    result = vision.embed_query(data)
    outcome = api.complete(job, {"embedding": _vec(result["embedding"]), "model": MODEL_ID, "crop_box": list(result["crop_box"]),
                                 "fallback_full_frame": result["fallback_full_frame"], "timing_ms": result["timing_ms"],
                                 "thumbnail_webp_base64": result["thumbnail_webp_base64"]})
    top = (outcome.get("candidates") or [{}])[0].get("sku")
    log.info("identified event %s in %d ms -> top %s", event["id"], result["timing_ms"]["total"], top)


def run_job(job: dict[str, Any], api: LoupeApi, store: LocalStore, vision: Vision | None) -> None:
    kind = job["kind"]
    try:
        if kind == "sync":
            handle_sync(job, api, store)
        elif kind == "embed":
            if vision is None:
                raise LoupeApiError("embed job claimed without a model loaded", retryable=True)
            handle_embed(job, api, store, vision)
        elif kind == "identify":
            if vision is None:
                raise LoupeApiError("identify job claimed without a model loaded", retryable=True)
            handle_identify(job, api, vision)
        else:
            raise LoupeApiError(f"unknown job kind {kind}", retryable=False)
    except LoupeApiError as exc:
        if exc.status == 409:
            log.warning("job %s: lease lost, leaving it to its new owner", job["id"])
            return
        log.error("job %s (%s) failed: %s", job["id"], kind, exc)
        api.fail(job, str(exc), exc.retryable)
    except Exception as exc:  # noqa: BLE001 — a bad image must not kill the loop
        log.exception("job %s (%s) crashed", job["id"], kind)
        api.fail(job, f"{type(exc).__name__}: {exc}", retryable=False)
