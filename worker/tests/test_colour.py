import numpy as np
from PIL import Image

from loupe_worker.colour import DIM, colour_signature


def test_signature_is_l1_normalised_and_separates_colours():
    green = colour_signature(Image.new("RGB", (32, 32), (30, 200, 50)), None)
    white = colour_signature(Image.new("RGB", (32, 32), (245, 245, 245)), None)
    assert len(green) == DIM
    assert abs(sum(green) - 1.0) < 1e-6
    assert float(np.linalg.norm(np.array(green) - np.array(white))) > 0.9


def test_mask_restricts_to_foreground():
    im = Image.new("RGB", (10, 10), (255, 0, 0))
    im.paste((0, 255, 0), (0, 0, 10, 5))  # top half green, bottom half red
    mask = np.zeros((10, 10), dtype=np.uint8)
    mask[:5, :] = 255  # only the green half is foreground
    sig = np.array(colour_signature(im, mask))
    # All mass in one hue bin (green), none in the red bin.
    assert sig.max() > 0.99


def test_blank_foreground_is_zero():
    assert colour_signature(Image.new("RGB", (8, 8), (0, 200, 0)), np.zeros((8, 8), dtype=np.uint8)) == [0.0] * DIM
