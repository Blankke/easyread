"""Continued paragraphs must not become figure labels or change float order."""
import json
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader, PdfWriter

from easyread.pdf import pdfwork
from easyread.pdf.paragraph_regions import matched_body_words
from easyread.library.store import write_json_atomic
from tests.pdf.test_figure_geometry import make_pdf


class ContinuedParagraphTest(unittest.TestCase):
    def test_single_column_figure_labels_do_not_cross_into_neighboring_prose(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_pdf(root / 'source.pdf', images=[[.08, .25, .48, .45]],
                     words=[('Figure 1: Results.', .08, .50),
                            ('Neighboring prose must stay outside the figure.', .50, .35)])
            blocks = [{'id': 'fig', 'type': 'figure', 'page': 1, 'caption_en': 'Figure 1: Results.'}]
            layout = {'fig': {'page': 1, 'src': 'text', 'box': [.08, .48, .32, .51]}}
            pdfwork._extend_captioned(blocks, layout, root)
            self.assertEqual(layout['fig']['src'], 'graphic')
            self.assertLess(layout['fig']['crop'][2], .5)

    def test_short_axis_labels_and_unrelated_text_are_preserved(self):
        words = [{"text": text} for text in "Training accuracy Model size unrelated content".split()]
        body = ["We report Training accuracy and compare Model size in a separate experiment."]
        self.assertEqual(matched_body_words(words, body), [])

    def test_long_prose_survives_formula_spelling_changes(self):
        prefix = "The continued paragraph explains the measurement procedure"
        suffix = "before reporting the final experimental observations"
        words = [{"text": text} for text in (prefix + " x = y " + suffix).split()]
        found = matched_body_words(words, [prefix + " $x = y$ " + suffix])
        self.assertEqual([w["text"] for w in found], (prefix + " " + suffix).split())

    def fixture(self, root, cross_page):
        beginning = "This paragraph starts before the column or page boundary."
        lines = ["The experiment continues from the previous",
                 "page and explains how the measured signals",
                 "are combined before the next processing step."]
        words = [(line, .53, .33 + i * .022) for i, line in enumerate(lines)]
        caption = "Figure 1: Experimental results."
        words.append((caption, .53, .67))
        if not cross_page:
            words.insert(0, (beginning, .08, .80))
        make_pdf(root / "figure.pdf", images=[[.53, .40, .93, .62]], words=words)
        writer = PdfWriter()
        if cross_page:
            make_pdf(root / "first.pdf", words=[(beginning, .08, .80)])
            writer.add_page(PdfReader(root / "first.pdf").pages[0])
        writer.add_page(PdfReader(root / "figure.pdf").pages[0])
        writer.write(root / "source.pdf")
        page = 2 if cross_page else 1
        blocks = [
            {"id": "body", "type": "para", "page": 1, "en": beginning + " " + " ".join(lines)},
            {"id": "fig", "type": "figure", "page": page, "caption_en": caption},
        ]
        write_json_atomic(root / "paper.json", {"blocks": blocks})
        write_json_atomic(root / "reader.json", {"notes": {"n1": {"anchor": "body", "body": "Keep this note"}}})
        pdfwork.extract_text(root / "source.pdf", root / "extract")
        return blocks, page

    def test_cross_page_continuation_stays_out_of_crop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            blocks, _ = self.fixture(root, True)
            before = (root / "reader.json").read_bytes()
            layout = pdfwork.locate(root)
            self.assertEqual(layout["fig"]["src"], "graphic")
            self.assertGreater(layout["fig"]["crop"][1], .385)
            self.assertLess(layout["fig"]["crop"][1], .41)
            self.assertEqual(before, (root / "reader.json").read_bytes())
            self.assertEqual([b["id"] for b in blocks],
                             [b["id"] for b in json.loads((root / "paper.json").read_text())["blocks"]])

    def test_truncated_cross_column_layout_stays_out_of_crop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            blocks, _ = self.fixture(root, False)
            # A failed tail anchor left only the first line in the other column.
            layout = {
                "body": {"page": 1, "src": "head", "box": [.08, .31, .94, .81],
                         "boxes": [[.08, .78, .48, .81], [.53, .315, .94, .334]]},
                "fig": {"page": 1, "src": "text", "box": [.53, .655, .80, .68]},
            }
            pdfwork._extend_captioned(blocks, layout, root)
            self.assertEqual(layout["fig"]["src"], "graphic")
            self.assertGreater(layout["fig"]["crop"][1], .385)


if __name__ == "__main__":
    unittest.main()
