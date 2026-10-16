"""运行：激活项目 .venv 后执行 python -m unittest tests.engines.test_chatgpt_web。

检查桌面任务桥的附件快照、顺序、去重与取消，不连接真实 ChatGPT 账号。
"""
import json
import queue
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from easyread.engines import chatgpt_web
from easyread.engines.engines import Cancelled
from easyread.server.server import Handler


class ChatGPTWebBridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "paper-one"
        self.root.mkdir()
        (self.root / "source.pdf").write_bytes(b"%PDF-1.4\n")
        (self.root / "paper.json").write_text(json.dumps({"meta": {"title_en": "Example"},
            "blocks": [{"id": "p1", "page": 3}]}), encoding="utf-8")
        (self.root / "reader.json").write_text(json.dumps({"rev": 7, "notes": {"n1": {
            "anchor": "p1", "kind": "highlight", "color": "pink", "quote": "important",
            "body": "my note"}}}), encoding="utf-8")
        secret = mock.patch.object(chatgpt_web, "SECRET", "bridge-test")
        secret.start()
        self.addCleanup(secret.stop)
        chatgpt_web._pending = queue.PriorityQueue()
        chatgpt_web._active.clear()
        chatgpt_web.heartbeat()

    def test_response_and_current_marks(self):
        result = []
        worker = threading.Thread(target=lambda: result.append(chatgpt_web.run(
            {"model": "Selected GPT"}, "translate", self.root)))
        worker.start()
        deadline = time.monotonic() + 3
        while not chatgpt_web._active and time.monotonic() < deadline:
            time.sleep(0.01)
        request = chatgpt_web.next_task()["request"]
        self.assertEqual(request["model"], "Selected GPT")
        self.assertEqual(request["marks_rev"], "7")
        self.assertIn(str(self.root / "source.pdf"), request["files"])
        marks = Path(next(p for p in request["files"] if p.endswith(".txt"))).read_text(encoding="utf-8")
        self.assertIn("页码：3", marks)
        self.assertIn("颜色：pink", marks)
        self.assertIn("my note", marks)
        self.assertTrue(chatgpt_web.event({"id": request["id"], "seq": 1, "text": "译文"})["accepted"])
        self.assertFalse(chatgpt_web.event({"id": request["id"], "seq": 1, "text": "重复"})["accepted"])
        chatgpt_web.event({"id": request["id"], "seq": 2, "done": True})
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result, ["译文"])
        self.assertFalse(chatgpt_web.event({"id": request["id"], "seq": 3, "text": "迟到"})["accepted"])
        snapshots = list((self.root / "web-answers").glob("*.json"))
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(json.loads(snapshots[0].read_text(encoding="utf-8"))["text"], "译文")
        # 模拟重启后再次处理同一批：先读本地回答，不再创建网页任务。
        self.assertEqual(chatgpt_web.run({"model": "Selected GPT"}, "translate", self.root), "译文")
        self.assertIsNone(chatgpt_web.next_task()["request"])
        chatgpt_web.discard({"model": "Selected GPT"}, "translate", self.root)
        self.assertFalse(snapshots[0].exists())

    def test_cancel_removes_waiting_request(self):
        stop = threading.Event()
        errors = []
        def consume():
            try:
                list(chatgpt_web.stream({"model": "Selected GPT"}, "question", self.root, stop))
            except Cancelled as error:
                errors.append(error)
        worker = threading.Thread(target=consume)
        worker.start()
        deadline = time.monotonic() + 3
        while not chatgpt_web._active and time.monotonic() < deadline:
            time.sleep(0.01)
        stop.set()
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsNone(chatgpt_web.next_task()["request"])

    def test_chat_sends_text_and_project_reference_without_creating_attachments(self):
        result = []
        prompt = "读者选中的原话：important\n读者现在问：这段是什么意思？"
        worker = threading.Thread(target=lambda: result.extend(chatgpt_web.stream(
            {"model": "Selected GPT", "project_sync": True}, prompt, self.root,
            images=[self.root / "source.pdf"], session="paper/chat/one")))
        worker.start()
        deadline = time.monotonic() + 3
        while not chatgpt_web._active and time.monotonic() < deadline:
            time.sleep(0.01)
        request = chatgpt_web.next_task()["request"]
        self.assertEqual(request["kind"], "chat")
        self.assertEqual(request["files"], [])
        self.assertEqual(request["marks_rev"], "")
        self.assertIn("Example", request["prompt"])
        self.assertIn("项目中", request["prompt"])
        self.assertIn("找不到或无法读取", request["prompt"])
        self.assertTrue(request["prompt"].endswith(prompt))
        self.assertFalse((self.root / "web-attachments").exists())
        self.assertNotIn("task_id", request)
        chatgpt_web.event({"id": request["id"], "seq": 1, "text": "解释", "done": True})
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result, ["解释"])

    def test_bridge_requires_desktop_secret(self):
        handler_app = mock.patch.object(Handler, "app", SimpleNamespace(), create=True)
        handler_app.start()
        self.addCleanup(handler_app.stop)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(server.server_close)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}/api/desktop/web/next"
        with self.assertRaises(urllib.error.HTTPError) as err:
            urllib.request.urlopen(url, timeout=2)
        self.assertEqual(err.exception.code, 403)
        req = urllib.request.Request(url, headers={"X-Desktop-Bridge": "bridge-test"})
        with urllib.request.urlopen(req, timeout=2) as response:
            self.assertEqual(json.load(response), {"request": None})
        chatgpt_web._heartbeat = time.monotonic() - 20
        self.assertFalse(chatgpt_web.available())
        heartbeat = urllib.request.Request(url.replace("/next", "/heartbeat"), headers={"X-Desktop-Bridge": "bridge-test"})
        with urllib.request.urlopen(heartbeat, timeout=2) as response:
            self.assertEqual(json.load(response), {"ok": True})
        self.assertTrue(chatgpt_web.available())
