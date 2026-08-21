import numpy as np
from PIL import Image

from loupe_worker.vision import box_from_alpha, open_image, pad_to_square, view


def test_box_from_alpha_brackets_the_mass():
    alpha = np.zeros((100, 200), dtype=bool)
    alpha[20:60, 50:150] = True
    x0, y0, x1, y1 = box_from_alpha(alpha)
    assert 49 <= x0 <= 51 and 148 <= x1 <= 150
    assert 19 <= y0 <= 21 and 58 <= y1 <= 60


def test_box_from_alpha_is_none_without_mass():
    assert box_from_alpha(np.zeros((10, 10), dtype=bool)) is None


def test_pad_to_square_and_view_are_square():
    im = Image.new("RGB", (300, 120), (200, 10, 10))
    square = pad_to_square(im)
    assert square.size == (300, 300)
    assert view(im).size == (768, 768)
    # edge padding repeats the border colour rather than introducing black
    assert square.getpixel((150, 5)) == (200, 10, 10)


def test_open_image_flattens_alpha_to_white_and_returns_rgb(tmp_path):
    im = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
    path = tmp_path / "t.png"
    im.save(path)
    out = open_image(path.read_bytes())
    assert out.mode == "RGB" and out.getpixel((1, 1)) == (255, 255, 255)
