"""
A small colour signature for re-ranking (2026-08-27).

SigLIP2 embeddings are shape/design-dominant and nearly colour-blind: a green and a
white piece of the same design sit at almost the same cosine (measured — see
docs/COLOUR-RERANK.md). This histogram gives the re-ranker a colour term.

Signature: over the u2net foreground only (background never votes), each pixel goes
to a hue bin when it is colourful (S,V above thresholds) or to an achromatic
value bin (white / grey / black) otherwise. L1-normalised. Compared by L2 in SQL:
two pieces that share the gold setting but differ in stone colour differ in exactly
the green-vs-white bins, which is what L2 picks up.

Knobs (calibration; the physical world needs tuning a minimal model cannot see):
  HUE_BINS, ACHROM_BINS, S_MIN, V_MIN. Keep them identical in the Kaggle notebook.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

HUE_BINS = 12          # colourful pixels binned by hue
ACHROM_BINS = 3        # white/grey/black binned by value
S_MIN = 0.25           # below this saturation a pixel is achromatic
V_MIN = 0.15           # below this value (near-black) a pixel is its own darkest achromatic bin
DIM = HUE_BINS + ACHROM_BINS


def colour_signature(image: Image.Image, alpha: np.ndarray | None) -> list[float]:
    """image: RGB PIL. alpha: bool/0-255 foreground mask at ANY resolution; resized to match.
    Returns an L1-normalised DIM-vector. A blank foreground returns all zeros."""
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    h, w = rgb.shape[:2]
    if alpha is None:
        mask = np.ones((h, w), dtype=bool)
    else:
        a = np.asarray(alpha)
        if a.shape[:2] != (h, w):
            a = np.asarray(Image.fromarray((a > 0).astype(np.uint8) * 255).resize((w, h), Image.NEAREST))
        mask = a >= 128
    px = rgb[mask]
    if px.size == 0:
        return [0.0] * DIM

    mx = px.max(axis=1)
    mn = px.min(axis=1)
    v = mx
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)

    # Hue in [0,1) from the standard piecewise formula.
    r, g, b = px[:, 0], px[:, 1], px[:, 2]
    d = np.maximum(mx - mn, 1e-6)
    hue = np.zeros_like(v)
    idx = mx == r
    hue[idx] = ((g[idx] - b[idx]) / d[idx]) % 6
    idx = mx == g
    hue[idx] = (b[idx] - r[idx]) / d[idx] + 2
    idx = mx == b
    hue[idx] = (r[idx] - g[idx]) / d[idx] + 4
    hue = hue / 6.0

    hist = np.zeros(DIM, dtype=np.float64)
    colourful = (s >= S_MIN) & (v >= V_MIN)
    hb = np.clip((hue[colourful] * HUE_BINS).astype(int), 0, HUE_BINS - 1)
    np.add.at(hist, hb, 1.0)
    ach = ~colourful
    ab = np.clip((v[ach] * ACHROM_BINS).astype(int), 0, ACHROM_BINS - 1)
    np.add.at(hist, HUE_BINS + ab, 1.0)

    total = hist.sum()
    if total <= 0:
        return [0.0] * DIM
    return [round(float(x), 6) for x in (hist / total)]


def demo() -> None:
    """Two flat swatches must land in different bins and be L2-far; identical ones L2-near."""
    green = Image.new("RGB", (64, 64), (40, 200, 60))
    white = Image.new("RGB", (64, 64), (240, 240, 240))
    green2 = Image.new("RGB", (64, 64), (44, 205, 66))
    sg, sw, sg2 = (np.array(colour_signature(im, None)) for im in (green, white, green2))
    d_gw = float(np.linalg.norm(sg - sw))
    d_gg = float(np.linalg.norm(sg - sg2))
    assert d_gg < 0.05, d_gg
    assert d_gw > 0.9, d_gw
    assert abs(sum(sg) - 1.0) < 1e-6
    print(f"ok: green~green L2={d_gg:.3f}  green~white L2={d_gw:.3f}")


if __name__ == "__main__":
    demo()
