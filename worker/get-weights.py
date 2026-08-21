"""
Downloads only the vision tower of timm/ViT-SO400M-16-SigLIP2-512 (the `visual.*`
tensors, 1.72 GB of the 4.55 GB open_clip checkpoint) and writes
weights/siglip2_so400m_512_visual.safetensors. Uses HTTP range requests; resumable.

    python get-weights.py
"""
import json
import os
import struct
import sys
import urllib.request
from pathlib import Path

URL = "https://huggingface.co/timm/ViT-SO400M-16-SigLIP2-512/resolve/main/open_clip_model.safetensors"
OUT = Path(os.environ.get("LOUPE_WEIGHTS", Path(__file__).resolve().parent / "weights" / "siglip2_so400m_512_visual.safetensors"))


def fetch(a: int, b: int) -> bytes:
    req = urllib.request.Request(URL, headers={"Range": f"bytes={a}-{b}"})
    return urllib.request.urlopen(req, timeout=120).read()


def main() -> int:
    if OUT.exists():
        print(f"already have {OUT} ({OUT.stat().st_size / 1e9:.2f} GB)")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    n = struct.unpack("<Q", fetch(0, 7))[0]
    header = json.loads(fetch(8, 8 + n - 1))
    visual = {k: v for k, v in header.items() if k.startswith("visual.")}
    lo = min(v["data_offsets"][0] for v in visual.values())
    hi = max(v["data_offsets"][1] for v in visual.values())
    new_header = {k: {"dtype": v["dtype"], "shape": v["shape"], "data_offsets": [v["data_offsets"][0] - lo, v["data_offsets"][1] - lo]}
                  for k, v in visual.items()}
    new_header["__metadata__"] = {"format": "pt", "source": "timm/ViT-SO400M-16-SigLIP2-512 open_clip_model.safetensors, visual.* only"}
    h = json.dumps(new_header, separators=(",", ":")).encode()
    h += b" " * (-len(h) % 8)

    part = OUT.with_suffix(".part")
    have = part.stat().st_size if part.exists() else 0
    start, end = 8 + n + lo, 8 + n + hi - 1
    total = end - start + 1
    print(f"visual tower: {total / 1e9:.2f} GB; resuming at {have / 1e9:.2f} GB" if have else f"visual tower: {total / 1e9:.2f} GB")
    with open(part, "ab") as f:
        pos = start + have
        chunk = 64 << 20
        while pos <= end:
            stop = min(pos + chunk - 1, end)
            data = fetch(pos, stop)
            f.write(data)
            pos += len(data)
            done = pos - start
            print(f"\r  {done / 1e9:.2f} / {total / 1e9:.2f} GB", end="", flush=True)
    print()
    with open(OUT, "wb") as out, open(part, "rb") as src:
        out.write(struct.pack("<Q", len(h)))
        out.write(h)
        while block := src.read(1 << 24):
            out.write(block)
    part.unlink()
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
