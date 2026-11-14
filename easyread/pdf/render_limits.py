"""Bound full-page bitmap allocations while keeping PDF coordinates unchanged."""
from __future__ import annotations

import math

MAX_PIXELS = 8_000_000
MAX_SIDE = 4096


def render_page(page, scale: float):
    """Keep ordinary pages at their requested resolution; retry memory failure once.

    PDFium, Pillow conversion and WebP encoding can hold several bitmap copies.
    Bound the bitmap before allocating it, including unusually wide/tall PDFs.
    Callers still own the bitmap and the process-wide PDFium lock.
    """
    w, h = page.get_size()
    if not all(math.isfinite(v) and v > 0 for v in (w, h, scale)):
        raise ValueError("Invalid PDF page dimensions or render scale")
    # Leave room for PDFium's ceil-to-pixel rounding on both axes.
    scale = min(scale, (MAX_SIDE - 1) / w, (MAX_SIDE - 1) / h,
                math.sqrt((MAX_PIXELS - 2 * MAX_SIDE) / w / h))
    try:
        return page.render(scale=scale, limit_image_cache=True)
    except MemoryError:
        pass
    # A native PDFium OOM may leave partial native state: let the preparation
    # worker exit and retry in a new process instead of reusing this page.
    return page.render(scale=scale / 2, limit_image_cache=True)
