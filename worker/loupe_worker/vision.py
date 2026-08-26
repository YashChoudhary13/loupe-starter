"""
The matcher's arithmetic — identical to the bake-off that won (kaggle/bakeoff_vs4.ipynb,
AI-Python/loupe-audit/cpu_bench.py): u2net alpha at <=768 px -> 99 %-mass box + 25 % margin,
background kept -> pad to square (edge) -> 768 px view -> 512 px bicubic -> SigLIP2 vision
tower -> L2-normalised 1152-d. Both views (full, crop) for references; crop only for queries.
"""
from __future__ import annotations

import base64
import io
import math
import os
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps

from .colour import colour_signature

CROP_MARGIN, VIEW_PX, MODEL_PX, DIM = 0.25, 768, 512, 1152
TIMM_ARCH = "vit_so400m_patch16_siglip_512"


def box_from_alpha(alpha: np.ndarray, keep: float = 0.99):
    a = alpha.astype(np.float64)
    if a.sum() <= 0:
        return None
    lo, hi = (1 - keep) / 2, 1 - (1 - keep) / 2
    out = []
    for axis in (0, 1):
        m = a.sum(axis=axis)
        c = np.cumsum(m) / m.sum()
        out.append((int(np.searchsorted(c, lo)), int(np.searchsorted(c, hi))))
    (x0, x1), (y0, y1) = out
    return x0, y0, x1, y1


def pad_to_square(image: Image.Image) -> Image.Image:
    array = np.array(image)
    height, width = array.shape[:2]
    if height == width:
        return image
    size = max(height, width)
    top, left = (size - height) // 2, (size - width) // 2
    return Image.fromarray(np.pad(array, ((top, size - height - top), (left, size - width - left), (0, 0)), mode="edge"))


def view(image: Image.Image) -> Image.Image:
    return pad_to_square(image).resize((VIEW_PX, VIEW_PX), Image.BICUBIC)


def open_image(data: bytes) -> Image.Image:
    """Decode, honour EXIF orientation (phones), drop alpha onto white."""
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        background = Image.new("RGB", im.size, (255, 255, 255))
        background.paste(im.convert("RGBA"), mask=im.convert("RGBA").split()[-1])
        return background
    return im.convert("RGB")


def thumbnail_webp_base64(image: Image.Image, edge: int = 1536) -> str:
    small = image.copy()
    small.thumbnail((edge, edge), Image.BICUBIC)
    buffer = io.BytesIO()
    small.save(buffer, "WEBP", quality=82)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


class Vision:
    def __init__(self, weights: str | os.PathLike[str], device: str = "cuda", threads: int | None = None):
        import timm
        from safetensors.torch import load_file
        import torchvision.transforms as T

        self.device = device if (device != "cuda" or torch.cuda.is_available()) else "cpu"
        if threads:
            torch.set_num_threads(threads)
        t0 = time.time()
        model = timm.create_model(TIMM_ARCH, pretrained=False, num_classes=0)
        state = load_file(str(weights))
        state = {k[len("visual.trunk."):]: v for k, v in state.items() if k.startswith("visual.trunk.")}
        missing, unexpected = model.load_state_dict(state, strict=False)
        if missing or unexpected:
            raise RuntimeError(f"weights do not match {TIMM_ARCH}: missing={missing[:3]} unexpected={unexpected[:3]}")
        self.model = model.eval().to(self.device)
        self.half = self.device == "cuda"
        if self.half:
            self.model = self.model.half()
        self.transform = T.Compose([
            T.Resize((MODEL_PX, MODEL_PX), interpolation=T.InterpolationMode.BICUBIC),
            T.ToTensor(),
            T.Normalize((0.5,) * 3, (0.5,) * 3),
        ])
        from rembg import new_session
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if self.device == "cuda" else ["CPUExecutionProvider"]
        self.session = new_session("u2net", providers=providers)
        self.load_seconds = time.time() - t0

    @torch.no_grad()
    def embed(self, images: list[Image.Image]) -> np.ndarray:
        x = torch.stack([self.transform(im) for im in images]).to(self.device)
        if self.half:
            x = x.half()
        f = self.model(x).float()
        f = f / f.norm(dim=-1, keepdim=True)
        return f.cpu().numpy()

    def generous_box(self, im: Image.Image):
        """(box, fallback, alpha_small, small): alpha_small is the 768px foreground mask
        (None on fallback), small the 768px image it came from, so the colour signature is
        taken over the same foreground as the crop."""
        from rembg import remove

        W, H = im.size
        s = min(1.0, 768 / max(W, H))
        small = im.resize((max(1, round(W * s)), max(1, round(H * s))), Image.BICUBIC) if s < 1 else im
        alpha = np.array(remove(small, session=self.session, only_mask=True)) >= 128
        frac = float(alpha.mean())
        b = box_from_alpha(alpha)
        if b is None or frac < 0.002 or (b[2] - b[0]) < 16 or (b[3] - b[1]) < 16:
            return (0, 0, W, H), True, None, small
        x0, y0, x1, y1 = [v / s for v in b]
        bw, bh = x1 - x0, y1 - y0
        x0, x1 = max(0, x0 - CROP_MARGIN * bw), min(W, x1 + CROP_MARGIN * bw)
        y0, y1 = max(0, y0 - CROP_MARGIN * bh), min(H, y1 + CROP_MARGIN * bh)
        box = (int(x0), int(y0), int(math.ceil(x1)), int(math.ceil(y1)))
        if box[2] - box[0] < 16 or box[3] - box[1] < 16:
            return (0, 0, W, H), True, alpha, small
        return box, False, alpha, small

    def embed_reference(self, data: bytes):
        im = open_image(data)
        box, fallback, alpha, small = self.generous_box(im)
        full, crop = self.embed([view(im), view(im.crop(box))])
        return full, crop, box, fallback, colour_signature(small, alpha)

    def embed_query(self, data: bytes) -> dict:
        t = {}
        t0 = time.time()
        im = open_image(data)
        t["decode"] = time.time() - t0
        t1 = time.time()
        box, fallback, alpha, small = self.generous_box(im)
        t["box"] = time.time() - t1
        t2 = time.time()
        (vector,) = self.embed([view(im.crop(box))])
        t["embed"] = time.time() - t2
        t["total"] = time.time() - t0
        return {"embedding": vector, "crop_box": box, "fallback_full_frame": fallback, "colour": colour_signature(small, alpha),
                "timing_ms": {k: round(v * 1000) for k, v in t.items()}, "thumbnail_webp_base64": thumbnail_webp_base64(im)}


def default_weights_path() -> Path:
    return Path(os.environ.get("LOUPE_WEIGHTS", Path(__file__).resolve().parent.parent / "weights" / "siglip2_so400m_512_visual.safetensors"))
