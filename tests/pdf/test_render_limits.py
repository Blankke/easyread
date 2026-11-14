import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from PIL import Image
from pypdf import PdfWriter

from easyread.pdf import pdfwork
from easyread.pdf.render_limits import MAX_PIXELS, MAX_SIDE, render_page


class RenderLimitsTest(unittest.TestCase):
    def page(self, size=(612, 792), failures=None):
        page = Mock()
        page.get_size.return_value = size
        if failures:
            page.render.side_effect = failures
        return page

    def test_ordinary_paper_keeps_requested_resolution(self):
        page = self.page()
        self.assertIs(render_page(page, 2.4), page.render.return_value)
        page.render.assert_called_once_with(scale=2.4, limit_image_cache=True)

    def test_large_and_extreme_aspect_ratios_are_bounded_before_allocation(self):
        for w, h in [(20_000, 10_000), (100_000, 1), (1, 100_000), (5000, 5000)]:
            page = self.page((w, h))
            render_page(page, 3)
            scale = page.render.call_args.kwargs['scale']
            width, height = math.ceil(w * scale), math.ceil(h * scale)
            self.assertLessEqual(max(width, height), MAX_SIDE)
            self.assertLessEqual(width * height, MAX_PIXELS)

    def test_memory_failure_retries_once_at_half_scale(self):
        bitmap = object()
        page = self.page(failures=[MemoryError(), bitmap])
        self.assertIs(render_page(page, 2.4), bitmap)
        self.assertEqual([c.kwargs['scale'] for c in page.render.call_args_list], [2.4, 1.2])

    def test_native_windows_exception_does_not_reuse_partial_native_state(self):
        error = OSError('native allocation')
        error.winerror = -536870904
        page = self.page(failures=[error, object()])
        with self.assertRaises(OSError):
            render_page(page, 2)
        self.assertEqual(page.render.call_count, 1)

    def test_unrelated_error_is_not_hidden_or_retried(self):
        page = self.page(failures=OSError('file unavailable'))
        with self.assertRaises(OSError):
            render_page(page, 2)
        self.assertEqual(page.render.call_count, 1)

    def test_repeated_memory_failure_stops(self):
        page = self.page(failures=MemoryError())
        with self.assertRaises(MemoryError):
            render_page(page, 2)
        self.assertEqual(page.render.call_count, 2)

    def test_invalid_dimensions_are_rejected_before_native_render(self):
        for size in [(0, 100), (-1, 100), (math.inf, 100), (math.nan, 100)]:
            page = self.page(size)
            with self.assertRaises(ValueError):
                render_page(page, 2)
            page.render.assert_not_called()

    def test_real_oversized_pdf_renders_and_preserves_pdf_coordinates(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            writer = PdfWriter()
            writer.add_blank_page(width=20_000, height=10_000)
            writer.write(root / 'source.pdf')
            pages = pdfwork.render_pages(root / 'source.pdf', root / 'pages')
            self.assertEqual((pages[0]['w'], pages[0]['h']), (20_000, 10_000))
            with Image.open(root / pages[0]['img']) as image:
                self.assertLessEqual(max(image.size), MAX_SIDE)
                self.assertLessEqual(image.width * image.height, MAX_PIXELS)
