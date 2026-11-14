import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from easyread.app import config  # Initialize settings before Jobs, as the app does.
from easyread.library.library import Library
from easyread.library.store import Workspace, write_json_atomic
from easyread.server.jobs import Jobs
from easyread.server.paper_api import post


class PrepareRetryTest(unittest.TestCase):
    def test_failed_import_can_retry_without_invoking_a_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            lib = Library(Path(tmp))
            root = lib.root / 'paper0001'
            root.mkdir()
            ws = Workspace(root)
            write_json_atomic(ws.paper_path, {'meta': {}, 'blocks': []})
            write_json_atomic(root / 'job.json', {'state': 'error', 'error': 'MemoryError'})
            with patch('easyread.server.jobs.threading.Thread.start'):
                jobs = Jobs(lib)
            app = SimpleNamespace(jobs=jobs)
            parts = ['', 'api', 'p', ws.id, 'prepare']
            self.assertEqual(post(app, ws, parts, {}), {'ok': True})
            self.assertFalse(ws.load('job')['translate'])
            with self.assertRaises(ValueError):
                post(app, ws, parts, {})
            with patch('easyread.server.jobs.config.load', return_value={'engine': 'codex'}), \
                    patch('easyread.server.jobs.translate.prepare') as prepare, \
                    patch('easyread.server.jobs.translate.translate_pages') as translate:
                jobs._process_bulk(ws.id)
            prepare.assert_called_once()
            self.assertEqual(prepare.call_args.args[0].root, ws.root)
            translate.assert_not_called()
            self.assertEqual(ws.load('job')['state'], 'done')
