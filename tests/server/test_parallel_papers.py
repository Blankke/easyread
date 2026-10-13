"""PR #64: bounded paper scheduling, independent of real model accounts."""
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread.app import config
from easyread.library.library import Library
from easyread.library.store import Workspace, write_json_atomic
from easyread.server.jobs import Jobs
from easyread.server.paper_workers import worker_count
from easyread.server import settings_api


class ParallelPapersTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.lib = Library(Path(tmp.name))
        self.wss = []
        for name in ("paper0001", "paper0002", "paper0003"):
            root = self.lib.root / name
            root.mkdir()
            ws = Workspace(root)
            write_json_atomic(ws.paper_path, {"meta": {"pages": [{"n": 1}], "page_count": 1}})
            self.wss.append(ws)

    def test_config_is_bounded_and_starts_the_requested_workers(self):
        for value, expected in ((None, 1), (1, 1), (2, 2), (4, 4), (8, 4), (100, 4), (0, 1),
                                (-1, 1), ("8", 1), (True, 1), (2.5, 1)):
            with self.subTest(value=value):
                cfg = {} if value is None else {"paper_concurrency": value}
                self.assertEqual(worker_count(cfg), expected)
                with patch("easyread.server.jobs.config.load", return_value=cfg), \
                        patch("easyread.server.jobs.threading.Thread.start") as start:
                    Jobs(self.lib)
                self.assertEqual(start.call_count, expected + 1)  # One separate small-job worker.

    def test_paper_concurrency_persists_in_existing_config(self):
        with patch.object(config, "CONFIG_PATH", self.lib.root / "config.json"):
            config.save({"paper_concurrency": 3})
            self.assertEqual(worker_count(config.load()), 3)

    def test_settings_reject_out_of_range_or_non_integer_paper_count(self):
        with patch.object(config, "save") as save:
            for value in (0, -1, 5, 8, "4", True, 2.5, None):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    settings_api.save_config({"paper_concurrency": value})
            save.assert_not_called()

    def test_settings_save_allowed_paper_counts(self):
        with patch.object(config, "CONFIG_PATH", self.lib.root / "config.json"):
            for value in (1, 2, 3, 4):
                result = settings_api.save_config({"paper_concurrency": value})
                self.assertEqual(result["config"]["paper_concurrency"], value)
                self.assertEqual(worker_count(config.load()), value)

    def test_two_papers_run_together_and_third_waits(self):
        started = {ws.id: threading.Event() for ws in self.wss}
        finished = {ws.id: threading.Event() for ws in self.wss}
        release = threading.Event()
        active, peak = 0, 0
        lock = threading.Lock()

        def run(jobs, ws, job, cancel):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            started[ws.id].set()
            try:
                if not release.wait(3):
                    raise RuntimeError("Timed out waiting for concurrent paper")
                jobs._write(ws, state="done")
            finally:
                with lock:
                    active -= 1
                finished[ws.id].set()

        with patch("easyread.server.jobs.config.load", return_value={"paper_concurrency": 2}), \
                patch.object(Jobs, "_run_bulk", run):
            jobs = Jobs(self.lib)
            for ws in self.wss:
                jobs.enqueue(ws, pages=[1])
            try:
                self.assertTrue(started[self.wss[0].id].wait(2))
                self.assertTrue(started[self.wss[1].id].wait(2))
                self.assertFalse(started[self.wss[2].id].is_set())
                self.assertEqual(self.wss[2].load("job")["state"], "queued")
            finally:
                release.set()
                for event in finished.values():
                    event.wait(3)
        self.assertEqual(peak, 2)
        self.assertTrue(all(ws.load("job")["state"] == "done" for ws in self.wss))

    def test_finishing_old_task_preserves_requeued_tasks_cancel_event(self):
        with patch("easyread.server.jobs.threading.Thread.start"):
            jobs = Jobs(self.lib)
        ws = self.wss[0]
        old_done, new_running = threading.Event(), threading.Event()
        release_old, release_new = threading.Event(), threading.Event()
        cancels = []

        def run(workspace, job, cancel):
            cancels.append(cancel)
            if len(cancels) == 1:
                jobs._write(workspace, state="done")
                old_done.set()
                release_old.wait(3)
            else:
                new_running.set()
                release_new.wait(3)

        jobs.enqueue(ws, pages=[1])
        threads = []
        with patch.object(jobs, "_run_bulk", side_effect=run):
            try:
                old = threading.Thread(target=jobs._process_bulk, args=(ws.id,))
                threads.append(old)
                old.start()
                self.assertTrue(old_done.wait(2))
                jobs.enqueue(ws, pages=[1])
                new = threading.Thread(target=jobs._process_bulk, args=(ws.id,))
                threads.append(new)
                new.start()
                self.assertTrue(new_running.wait(2))
                release_old.set()
                old.join(2)
                self.assertIs(jobs.cancels[ws.id], cancels[1])
                jobs.cancel(ws.id)
                self.assertTrue(cancels[1].is_set())
                self.assertFalse(cancels[0].is_set())
            finally:
                release_old.set()
                release_new.set()
                for thread in threads:
                    thread.join(3)
        self.assertNotIn(ws.id, jobs.cancels)


if __name__ == "__main__":
    unittest.main()
