"""Local store of originals on the laptop: bytes, a JSON sidecar per image, and a SQLite index."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."


def _safe(name: str, default: str) -> str:
    cleaned = "".join(c if c in SAFE else "_" for c in name).strip("._")
    return cleaned or default


class LocalStore:
    def __init__(self, root: str | os.PathLike[str]):
        self.root = Path(root)
        (self.root / "originals").mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / "index.sqlite")
        self.db.execute(
            """create table if not exists references_ (
                 reference_id text primary key, sku text, handle text, local_path text, sha256 text, bytes integer,
                 synced_at text, embedded_at text)"""
        )
        self.db.commit()

    def path_for(self, reference: dict[str, Any]) -> Path:
        sku = _safe(reference.get("sku") or "", "_unassigned")
        ext = os.path.splitext(reference.get("filename") or "")[1].lower() or ".jpg"
        return self.root / "originals" / sku / f"{reference['id']}{ext}"

    def save(self, job: dict[str, Any], data: bytes) -> tuple[Path, str]:
        reference = job["reference"]
        path = self.path_for(reference)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(data)
        os.replace(tmp, path)
        digest = hashlib.sha256(data).hexdigest()
        sidecar = {
            "reference_id": reference["id"],
            "sku": reference.get("sku"),
            "handle": reference.get("handle"),
            "source_filename": reference.get("filename"),
            "sha256": digest,
            "bytes": len(data),
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "job_id": job["id"],
        }
        path.with_suffix(".json").write_text(json.dumps(sidecar, indent=2))
        self.db.execute(
            "insert or replace into references_ (reference_id, sku, handle, local_path, sha256, bytes, synced_at) values (?,?,?,?,?,?,?)",
            (reference["id"], reference.get("sku"), reference.get("handle"), str(path), digest, len(data), sidecar["synced_at"]),
        )
        self.db.commit()
        return path, digest

    def local_path(self, reference: dict[str, Any]) -> Path | None:
        row = self.db.execute("select local_path from references_ where reference_id = ?", (reference["id"],)).fetchone()
        if row and Path(row[0]).exists():
            return Path(row[0])
        candidate = self.path_for(reference)
        return candidate if candidate.exists() else None

    def mark_embedded(self, reference_id: str) -> None:
        self.db.execute("update references_ set embedded_at = ? where reference_id = ?", (datetime.now(timezone.utc).isoformat(), reference_id))
        self.db.commit()
