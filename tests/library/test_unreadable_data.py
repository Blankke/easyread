import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread.app import config  # Initialize configuration before workers, as the CLI does.
from easyread.library.library import Library
from easyread.library.store import DataReadError, Workspace, write_json_atomic
from easyread.library import trash
from easyread.server.jobs import Jobs


class UnreadableDataTest(unittest.TestCase):
    def test_startup_skips_damaged_job_and_resumes_healthy_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            lib = Library(Path(tmp))
            bad = lib.root / "damaged00001"
            good = lib.root / "healthy00001"
            for folder in (bad, good):
                folder.mkdir()
                write_json_atomic(folder / "paper.json", {"meta": {}})
            broken = bad / "job.json"
            content = b" " * 8192 + b"\x89"
            broken.write_bytes(content)
            write_json_atomic(good / "job.json", {"state": "running"})
            with patch("easyread.server.jobs.threading.Thread.start"), \
                    patch("easyread.server.jobs.config.load", return_value={}), \
                    self.assertLogs("easyread", level="ERROR") as logs:
                jobs = Jobs(lib)
            self.assertEqual(jobs.bulk.get_nowait(), good.name)
            self.assertTrue(jobs.bulk.empty())
            self.assertEqual(Workspace(good).load("job")["state"], "queued")
            self.assertEqual(broken.read_bytes(), content)
            self.assertIn(str(broken), "\n".join(logs.output))

    def test_damaged_paper_does_not_hide_healthy_papers_or_change_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            lib = Library(Path(tmp))
            good = lib.root / "healthy00001"
            bad = lib.root / "damaged00001"
            good.mkdir()
            bad.mkdir()
            write_json_atomic(good / "paper.json", {"meta": {"title_en": "Healthy"}})
            for part in ("paper", "reader", "discussion", "item", "job"):
                for content in (b" " * 8192 + b"\x89", b'{"incomplete":'):
                    with self.subTest(part=part, content=content[-12:]):
                        write_json_atomic(bad / "paper.json", {"meta": {}})
                        broken = bad / f"{part}.json"
                        broken.write_bytes(content)
                        rows = {row["id"]: row for row in lib.list()}
                        self.assertEqual(rows[good.name]["title_en"], "Healthy")
                        self.assertIn(str(broken), rows[bad.name]["load_error"])
                        self.assertEqual(rows[bad.name]["tags"], [])
                        self.assertEqual(broken.read_bytes(), content)
                        broken.unlink()

    def test_unreadable_notes_cannot_be_overwritten_by_an_edit(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Workspace(Path(tmp))
            content = b"\x89broken notes"
            ws.reader_path.write_bytes(content)
            with self.assertRaises(DataReadError):
                ws.apply_reader_ops([{"op": "note", "note": {"id": "new", "body": "test"}}])
            self.assertEqual(ws.reader_path.read_bytes(), content)
            self.assertFalse(ws.journal_path.exists())

    def test_damaged_trash_entry_remains_counted_and_can_be_restored(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            entry = root / ".trash" / "abcdef123456-20261013090000"
            entry.mkdir(parents=True)
            content = b"\x89bad"
            (entry / "paper.json").write_bytes(content)
            rows = trash.items(root)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["id"], "abcdef123456")
            pid = trash.restore(root, entry.name)
            self.assertEqual((root / pid / "paper.json").read_bytes(), content)
