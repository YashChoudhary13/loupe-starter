"""
Step 2 of the colour backfill: read runs/colour/manifest.jsonl ({reference_id, url}),
fetch each image, compute its colour signature over the u2net foreground, and write
runs/colour/colours.jsonl ({reference_id, colour[15]}). Same colour.py the worker uses,
so backfilled and live signatures are identical. CPU-only, ~0.5-1s/image.

    python worker/backfill_colour.py [manifest.jsonl] [colours.jsonl]

Resumable: reference_ids already in the output file are skipped.
"""
import io
import json
import os
import sys
import urllib.request

import numpy as np
from PIL import Image
from rembg import new_session, remove

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from loupe_worker.colour import colour_signature

MANIFEST = sys.argv[1] if len(sys.argv) > 1 else "runs/colour/manifest.jsonl"
OUT = sys.argv[2] if len(sys.argv) > 2 else "runs/colour/colours.jsonl"


def main() -> int:
    done = set()
    if os.path.exists(OUT):
        for line in open(OUT):
            if line.strip():
                done.add(json.loads(line)["reference_id"])
    rows = [json.loads(l) for l in open(MANIFEST) if l.strip()]
    todo = [r for r in rows if r["reference_id"] not in done]
    print(f"{len(rows)} in manifest, {len(done)} already done, {len(todo)} to do", flush=True)
    session = new_session("u2net", providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    ok = fail = 0
    with open(OUT, "a") as out:
        for i, r in enumerate(todo):
            try:
                data = urllib.request.urlopen(r["url"], timeout=60).read()
                im = Image.open(io.BytesIO(data)).convert("RGB")
                W, H = im.size
                s = min(1.0, 768 / max(W, H))
                small = im.resize((max(1, round(W * s)), max(1, round(H * s))), Image.BICUBIC) if s < 1 else im
                alpha = np.array(remove(small, session=session, only_mask=True))
                out.write(json.dumps({"reference_id": r["reference_id"], "colour": colour_signature(small, alpha)}) + "\n")
                out.flush()
                ok += 1
            except Exception as exc:  # noqa: BLE001 — one bad image must not stop the run
                fail += 1
                print(f"  FAILED {r['reference_id']}: {exc}", flush=True)
            if (i + 1) % 100 == 0:
                print(f"  {i + 1}/{len(todo)} (ok {ok}, fail {fail})", flush=True)
    print(f"done: {ok} colours written, {fail} failed", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
