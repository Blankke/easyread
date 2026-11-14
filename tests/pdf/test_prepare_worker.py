import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfWriter

from easyread.pdf import pdfwork, prepare_worker


class PrepareWorkerTest(unittest.TestCase):
    def test_real_child_prepares_pdf_without_touching_user_notes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            writer = PdfWriter()
            writer.add_blank_page(width=60, height=80)
            writer.add_blank_page(width=80, height=60)
            writer.write(root / 'source.pdf')
            notes = root / 'reader.json'
            notes.write_text('{"notes":{"a":"keep"}}', encoding='utf-8')
            pages = pdfwork.prepare(root)
            self.assertEqual([p['n'] for p in pages], [1, 2])
            self.assertTrue(all((root / p['img']).is_file() for p in pages))
            self.assertTrue((root / 'extract/page-002.chars.json').is_file())
            self.assertEqual(notes.read_text(encoding='utf-8'), '{"notes":{"a":"keep"}}')

    def test_native_page_load_oom_retries_in_new_lower_resolution_process(self):
        calls = []
        def run(cmd, **kwargs):
            calls.append(cmd)
            if len(calls) == 1:
                return subprocess.CompletedProcess(cmd, -536870904, '', '')
            Path(cmd[-2]).write_text(json.dumps({'pages': [{'n': 1}]}), encoding='utf-8')
            return subprocess.CompletedProcess(cmd, 0, '', '')
        with patch.object(prepare_worker.subprocess, 'run', side_effect=run):
            self.assertEqual(prepare_worker.prepare_isolated(Path('.')), [{'n': 1}])
        self.assertEqual([cmd[-1] for cmd in calls], ['2.4', '1.2'])

    def test_repeated_oom_stops_after_two_children(self):
        with patch.object(prepare_worker.subprocess, 'run', return_value=subprocess.CompletedProcess([], 73, '', '')) as run:
            with self.assertRaises(MemoryError):
                prepare_worker.prepare_isolated(Path('.'))
        self.assertEqual(run.call_count, 2)

    def test_non_memory_errors_are_not_retried(self):
        with patch.object(prepare_worker.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'PDF unavailable')) as run:
            with self.assertRaisesRegex(RuntimeError, 'PDF unavailable'):
                prepare_worker.prepare_isolated(Path('.'))
        self.assertEqual(run.call_count, 1)
