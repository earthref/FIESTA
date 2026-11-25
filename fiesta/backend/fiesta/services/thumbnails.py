"""Small preview images of attachments: raster images (Pillow) and the first
page of a PDF (pdfium). Rendered on request and cached by the browser (the
URL names the file's SHA-256), never stored: nothing derived goes in the
contribution's history."""

import io
import warnings

from PIL import Image

#: Largest source the editor asks a thumbnail of.
MAX_BYTES = 64 * 1024 * 1024
#: Decoded pixel budget (Pillow's decompression-bomb guard, raised for scans).
Image.MAX_IMAGE_PIXELS = 250_000_000


def _image(data: bytes, size: int) -> Image.Image:
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        image = Image.open(io.BytesIO(data))
        image.draft("RGB", (size, size))  # JPEG: decode at a reduced scale
        image.seek(0)
        image.thumbnail((size, size))
    return image


def _pdf(data: bytes, size: int) -> Image.Image:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)
    try:
        page = pdf[0]
        width, height = page.get_size()
        scale = size / max(width, height, 1)
        return page.render(scale=scale).to_pil()
    finally:
        pdf.close()


def thumbnail(data: bytes, kind: str, size: int = 320) -> bytes | None:
    """A WebP no larger than `size` px a side, or None when the file cannot be
    drawn (unsupported, damaged, encrypted or too large)."""
    if len(data) > MAX_BYTES or kind not in {"image", "pdf"}:
        return None
    try:
        image = _image(data, size) if kind == "image" else _pdf(data, size)
        if image.mode.startswith("I") or image.mode == "F":  # 16/32-bit scans
            image = image.convert("I").point(lambda v: v / 256).convert("L")
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        out = io.BytesIO()
        image.save(out, "WEBP", quality=80)
        return out.getvalue()
    except Exception:  # noqa: BLE001 — any undrawable file just has no thumbnail
        return None
