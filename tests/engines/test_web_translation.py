"""用法：激活 .venv 后 python -m unittest tests.engines.test_web_translation。

验证信封、快照、恢复和本地权威状态；不向真实模型发送请求。
"""
import json
import queue
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from easyread.engines import chatgpt_web, web_translation
from easyread.engines.engines import EngineError
from easyread.library.store import Workspace, read_json, write_json_atomic
from easyread.library.paperdata import merge_blocks
from easyread.translate.translate import _protect_web_edits


class WebTranslationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "paper"
        self.root.mkdir()
        (self.root / "source.pdf").write_bytes(b"%PDF example")
        write_json_atomic(self.root / "paper.json", {"meta": {"title_en": "Example", "target": "zh"},
            "translation": {"done_pages": [1]}, "glossary": [{"en": "test", "zh": "测试"}],
            "blocks": [{"id": "p1", "page": 1, "type": "para", "en": "Before", "zh": "前文"}]})
        write_json_atomic(self.root / "reader.json", {"rev": 1, "edits": {}})
        self.ws = Workspace(self.root)
        self.cfg = {"output_mode": "file", "requested_pages": [2, 3], "model": "Test GPT"}

    def prepare(self):
        return web_translation.prepare(self.root, self.cfg, "Translate", [str(self.root / "source.pdf")], "paper/translation")

    def envelope(self, task):
        return {**{k: task[k] for k in ("protocol", "task_id", "source_sha256", "requested_pages")},
                "status": "complete", "result": {"meta": {}, "glossary": [], "references": [], "checks": [],
                "blocks": [{"id": "p2", "page": 2, "type": "para", "en": "Source", "zh": "译文"}]}}

    def test_protocol_identity_shape_and_no_remote_progress(self):
        task, _ = self.prepare()
        value = self.envelope(task)
        value["result"]["translation"] = {"done_pages": [1, 2, 3, 999]}
        self.assertNotIn("translation", web_translation.validate(value, task))
        for field in ("task_id", "source_sha256", "requested_pages", "status", "protocol"):
            with self.subTest(field=field), self.assertRaises(ValueError):
                web_translation.validate({**value, field: "bad"}, task)
        value["result"]["blocks"][0]["page"] = True
        with self.assertRaises(ValueError):
            web_translation.validate(value, task)

    def test_task_stable_until_rejected_and_source_changes(self):
        task, file = self.prepare()
        same, _ = self.prepare()
        self.assertEqual(task["task_id"], same["task_id"])
        write_json_atomic(file, {**task, "status": "rejected"})
        new, _ = self.prepare()
        self.assertNotEqual(task["task_id"], new["task_id"])
        (self.root / "source.pdf").write_bytes(b"new pdf")
        changed, _ = self.prepare()
        self.assertNotEqual(changed["source_sha256"], task["source_sha256"])

    def test_later_batch_optional_fields_follow_paper_protocol(self):
        task, _ = self.prepare()
        value = self.envelope(task)
        for key in ("meta", "references", "checks", "glossary"):
            del value["result"][key]
        normalized = web_translation.validate(value, task)
        self.assertEqual(normalized["meta"], {})
        self.assertEqual(normalized["references"], [])
        self.assertEqual(list(value["result"]), ["blocks"])
        value["result"]["blocks"][0]["type"] = "references"
        with self.assertRaisesRegex(ValueError, "references"):
            web_translation.validate(value, task)

    def test_snapshot_changes_with_local_notes_and_glossary_and_stays_bounded(self):
        task, _ = self.prepare()
        frozen = Path(task["files"][-1])
        snapshot = read_json(frozen)
        self.assertEqual(snapshot["done_pages"], [1])
        self.assertEqual(snapshot["previous_paragraph"]["en"], "Before")
        first = web_translation.snapshot(self.ws, [2, 3], task["source_sha256"])
        stamp = first.stat().st_mtime_ns
        web_translation.snapshot(self.ws, [2, 3], task["source_sha256"])
        self.assertEqual(stamp, first.stat().st_mtime_ns)
        self.ws.update("reader", lambda r: r.update(rev=2, paper_note={"body": "具体要求" * 5000}))
        self.ws.update("paper", lambda p: p.update(glossary=[{"en": str(n), "zh": "术语" * 30} for n in range(2000)]))
        fresh = read_json(web_translation.snapshot(self.ws, [2, 3], task["source_sha256"]))
        self.assertNotEqual(fresh["content_hash"], snapshot["content_hash"])
        self.assertGreater(fresh["glossary_omitted"], 0)
        self.assertLess(len(json.dumps(fresh, ensure_ascii=False)), 25000)
        self.assertEqual(read_json(frozen), snapshot, "未确认任务的快照冻结")

    def test_user_edits_protected(self):
        self.ws.update("reader", lambda r: r.update(edits={"p1#caption": {"zh": "手动"}}))
        with self.assertRaises(EngineError):
            _protect_web_edits(self.ws, [1])
        _protect_web_edits(self.ws, [2])
        with self.assertRaises(ValueError):
            merge_blocks(self.ws, {"blocks": []}, replace_pages=[1], protect_edits=True)
        self.assertEqual(self.ws.load("paper")["blocks"][0]["en"], "Before")
        self.ws.update("reader", lambda r: r.update(edits={"p1#caption": {"reverted": True}}))
        _protect_web_edits(self.ws, [1])

    def test_pending_and_received_tasks_survive_settings_and_notes_changes(self):
        task, record = self.prepare()
        write_json_atomic(record, {**task, "status": "pending", "submission_started": True})
        self.cfg.update(model="Changed model", output_mode="text")
        self.ws.update("reader", lambda r: r.update(rev=3, paper_note={"body": "新的阅读要求"}))
        saved, _ = self.prepare()
        self.assertEqual(saved["task_id"], task["task_id"])
        self.assertEqual(saved["model"], "Test GPT")
        self.assertEqual(web_translation.recovery_batches(self.root, [[2], [3], [4]]), [[2, 3], [4]])
        write_json_atomic(record, {**saved, "status": "received", "text": "{}"})
        self.assertEqual(self.prepare()[0]["task_id"], task["task_id"])
        with self.assertRaisesRegex(ValueError, "部分重叠"):
            web_translation.recovery_batches(self.root, [[2], [4]])

    def test_unsent_snapshot_refresh_and_reject_actual_record(self):
        task, record = self.prepare()
        self.ws.update("paper", lambda p: p.update(glossary=[{"en": "new", "zh": "新术语"}]))
        self.assertNotEqual(self.prepare()[0]["task_id"], task["task_id"])
        self.cfg["_task_record"] = str(record)
        chatgpt_web.discard(self.cfg, "Translate", self.root)
        self.assertEqual(read_json(record)["status"], "rejected")

    def test_bridge_unwraps_only_valid_result_and_recovers_without_resend(self):
        chatgpt_web._pending = queue.PriorityQueue()
        chatgpt_web._active.clear()
        chatgpt_web.heartbeat()
        received, errors = [], []
        def consume():
            try:
                received.append(chatgpt_web.run(self.cfg, "Translate", self.root))
            except Exception as error:
                errors.append(error)
        with mock.patch.object(chatgpt_web, "SECRET", "test"):
            worker = threading.Thread(target=consume)
            worker.start()
            deadline = time.monotonic() + 3
            while not chatgpt_web._active and time.monotonic() < deadline:
                time.sleep(0.01)
            request = chatgpt_web.next_task()["request"]
            self.assertIsNotNone(request)
            self.assertEqual(request["requested_pages"], [2, 3])
            envelope = self.envelope(request)
            ack = chatgpt_web.event({"id": request["id"], "seq": 1, "done": True, "text": json.dumps(envelope)})
            self.assertTrue(ack["accepted"])
            worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(json.loads(received[0]), envelope["result"])
            self.assertEqual(chatgpt_web.run(self.cfg, "Translate", self.root), received[0])
            self.assertIsNone(chatgpt_web.next_task()["request"])
            self.assertEqual(self.ws.load("paper")["translation"]["done_pages"], [1], "收到文件不等于翻译完成")


if __name__ == "__main__":
    unittest.main()
