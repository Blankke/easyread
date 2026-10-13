"""翻译调度：一批失败会重试，重试还失败就跳过，别的页照常译完。  python -m unittest tests.translate.test_translate"""
import json
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from easyread.engines import engines
from easyread.translate import translate
from easyread.library.store import Workspace, write_json_atomic


def make_ws(n_pages: int) -> Workspace:
    root = Path(tempfile.mkdtemp(prefix="easyread-test-"))
    (root / "extract").mkdir()
    for n in range(1, n_pages + 1):
        (root / "extract" / f"page-{n:03d}.txt").write_text(f"Text of page {n}.", encoding="utf-8")
    pages = [{"n": n, "w": 600, "h": 800, "img": f"pages/page-{n:03d}.webp"} for n in range(1, n_pages + 1)]
    write_json_atomic(root / "paper.json", {"meta": {"pages": pages, "page_count": n_pages}, "translation": {"done_pages": []},
                                            "glossary": [], "references": [], "blocks": []})
    return Workspace(root)


def fake_engine(fail_pages: set, calls: list):
    def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
        page = int(prompt.split("这次只处理第 ")[1].split(" ")[0].split(",")[0])
        calls.append(page)
        if page in fail_pages:
            raise engines.EngineError(f"boom {page}")
        return json.dumps({"blocks": [{"id": f"p{page}-1", "type": "para", "page": page, "en": "x", "zh": "译文"}]})
    return run


class TranslateTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(6)
        self.cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 2, "openai": {"vision": False}}
        self.patches = [mock.patch.object(translate.pdfwork, "locate", lambda root: None),
                        mock.patch.object(translate, "tex_problems", lambda tex: [])]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def test_failed_batch_is_retried_then_skipped(self):
        calls = []
        with mock.patch.object(engines, "run", fake_engine({3}, calls)):
            failed = translate.translate_pages(self.ws, self.cfg, [1, 2, 3, 4, 5, 6], threading.Event(), lambda *a: None)
        self.assertEqual(list(failed), [3])
        self.assertEqual(calls.count(3), 2)  # 重试了一次
        paper = self.ws.load("paper")
        self.assertEqual(paper["translation"]["done_pages"], [1, 2, 4, 5, 6])
        self.assertEqual([b["page"] for b in paper["blocks"]], [1, 2, 4, 5, 6])  # 并发也按页码排好
        self.assertIn("第 3 页 第 2 次失败", (self.ws.root / "job.log").read_text(encoding="utf-8"))

    def test_quota_error_stops_remaining_batches(self):
        calls = []

        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            page = int(prompt.split("这次只处理第 ")[1].split(" ")[0].split(",")[0])
            calls.append(page)
            if page >= 3:
                raise engines.EngineError("Claude Code 出错：You've hit your session limit")
            return json.dumps({"blocks": [{"id": f"p{page}-1", "type": "para", "page": page, "en": "x", "zh": "y"}]})
        cfg = dict(self.cfg, concurrency=1)
        with mock.patch.object(engines, "run", run):
            failed = translate.translate_pages(self.ws, cfg, [1, 2, 3, 4, 5, 6], threading.Event(), lambda *a: None)
        self.assertEqual(sorted(failed), [3, 4, 5, 6])
        self.assertEqual(calls, [1, 2, 3])  # 额度用完后不再调用模型

    def test_cancel_stops(self):
        ev = threading.Event()
        ev.set()
        with mock.patch.object(engines, "run", fake_engine(set(), [])):
            with self.assertRaises(engines.Cancelled):
                translate.translate_pages(self.ws, self.cfg, [1, 2], ev, lambda *a: None)

    def test_scope_body_stops_at_references(self):
        (self.ws.root / "extract" / "page-004.txt").write_text("Conclusion.\nReferences\n[1] A. B.", encoding="utf-8")
        self.assertEqual(translate.scope_pages(self.ws, "body"), [1, 2, 3, 4])
        self.assertEqual(translate.scope_pages(self.ws, "first:2"), [1, 2])
        self.assertIsNone(translate.scope_pages(self.ws, "all"))

    def test_checks_saved_and_replaced_on_retranslate(self):
        self.ws.update("paper", lambda p: p.__setitem__("blocks", [{"id": "tab1", "type": "table", "page": 2}]))
        chk = [{"anchor": "tab1", "title": "两张表数字对不上", "body": "表 1 写 87.7%，表 2 写 86.7%。"}, {"anchor": "nope", "body": "锚点不存在的丢掉"}]
        translate._save_checks(self.ws, chk, [2])
        translate._save_checks(self.ws, chk[:1], [2])  # 重译同一页：不重复
        entries = self.ws.load("discussion").get("entries", [])
        self.assertEqual([(e["kind"], e["anchor"]) for e in entries], [("check", "tab1")])

    def test_json_with_code_fence_inside_string(self):
        # 附录里的代码块原样放进译文：输出里有 ``` 围栏套着 JSON，JSON 字符串里又有 ```python
        text = '```json\n{"blocks": [{"id": "c1", "type": "para", "zh": "代码如下：\\n```python\\nloss = -F.logsigmoid(x)\\n```"}]}\n```'
        self.assertEqual(engines.parse_json(text)["blocks"][0]["id"], "c1")

    def test_json_preserves_single_slash_tex_and_normal_json_escapes(self):
        text = r'{"tex":"\frac{1}{2}\top","body":"公式 $ \max(W)\leq\mu\|W\|_F/\sqrt{mn} $ 与 $\nu$","note":"first\nNext","unicode":"\u03bc"}'
        data = engines.parse_json(text)
        self.assertEqual(data["tex"], r"\frac{1}{2}\top")
        self.assertIn(r"\max(W)\leq\mu\|W\|_F/\sqrt{mn}", data["body"])
        self.assertIn(r"\nu", data["body"])
        self.assertEqual(data["note"], "first\nNext")
        self.assertEqual(data["unicode"], "μ")
        # 即使原 JSON 可解析，公式里的单斜杠也不能变成换页符。
        self.assertEqual(engines.parse_json(r'{"zh":"$\frac{1}{2}$"}')["zh"], r"$\frac{1}{2}$")
        # JSON 原本也能成功解析 \times，但会把 \t 吃成制表符；单、双斜杠都要保留乘号命令。
        for raw in (r'{"zh":"$3.33\times$ 加速；$3.89\times$ 内存节省"}',
                    r'{"zh":"$3.33\\times$ 加速；$3.89\\times$ 内存节省"}'):
            self.assertEqual(engines.parse_json(raw)["zh"],
                             r"$3.33\times$ 加速；$3.89\times$ 内存节省")

    def test_invalid_json_has_retryable_output_type(self):
        with self.assertRaises(engines.InvalidModelOutput):
            engines.parse_json('{"blocks": [')

    def test_web_bad_json_retries_once_without_aborting_later_batches(self):
        cfg = {"engine": "chatgpt_web", "chatgpt_web": {"model": "GPT", "batch_pages": 2}}
        calls = []

        def web_reply(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            page = int(prompt.split("这次只处理第 ")[1].split(" ")[0].split(",")[0])
            calls.append(page)
            if page == 1:
                return '{"blocks": ['
            return json.dumps({"blocks": [{"id": f"p{n}-1", "type": "para", "page": n, "en": "source", "zh": "译文"}
                                          for n in (3, 4)]})

        with mock.patch.object(engines, "run", web_reply), \
                mock.patch.object(translate.pdfwork, "engine_image", side_effect=lambda root, n: root / "extract" / f"page-{n:03d}.jpg"), \
                mock.patch.object(translate.netcheck, "problem", return_value=None), \
                mock.patch.object(translate.consistency, "check"):
            failed = translate.translate_pages(self.ws, cfg, [1, 2, 3, 4], threading.Event(), lambda *a: None)
        self.assertEqual(sorted(failed), [1, 2])
        self.assertEqual(calls, [1, 1, 3])
        self.assertEqual(self.ws.load("paper")["translation"]["done_pages"], [3, 4])
        self.assertTrue((self.ws.root / "extract" / "failed-001.txt").is_file())

    def test_web_bad_json_can_succeed_on_second_answer(self):
        cfg = {"engine": "chatgpt_web", "chatgpt_web": {"model": "GPT", "batch_pages": 2}}
        calls = []

        def web_reply(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            calls.append(prompt)
            if len(calls) == 1:
                return '{"blocks": ['
            return json.dumps({"blocks": [{"id": f"p{n}-1", "type": "para", "page": n, "en": "source", "zh": "译文"}
                                          for n in (1, 2)]})

        with mock.patch.object(engines, "run", web_reply), \
                mock.patch.object(translate.pdfwork, "engine_image", side_effect=lambda root, n: root / "extract" / f"page-{n:03d}.jpg"), \
                mock.patch.object(translate.netcheck, "problem", return_value=None):
            failed = translate.translate_pages(self.ws, cfg, [1, 2], threading.Event(), lambda *a: None)
        self.assertEqual(failed, {})
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.ws.load("paper")["translation"]["done_pages"], [1, 2])

    def test_web_four_page_batch_retries_only_missing_page(self):
        # 四页共用一次网页回复；漏掉的页只补一次，其余页不重复提交。
        cfg = {"engine": "chatgpt_web", "chatgpt_web": {"model": "GPT", "batch_pages": 4}}
        for n in range(1, 5):
            (self.ws.root / "extract" / f"page-{n:03d}.txt").write_text(
                (f"Distinct source words from original page {n} and its separate body paragraph. " * 3), encoding="utf-8")
        calls = []

        def web_reply(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            pages = [int(n) for n in prompt.split("这次只处理第 ")[1].split(" 页")[0].split(", ")]
            calls.append(pages)
            output = [n for n in pages if pages != [1, 2, 3, 4] or n != 2]
            return json.dumps({"blocks": [{"id": f"p{n}-1", "type": "para", "page": n,
                                   "en": f"Distinct source words from original page {n}", "zh": "译文"} for n in output]})

        with mock.patch.object(engines, "run", web_reply), \
                mock.patch.object(translate.pdfwork, "engine_image", side_effect=lambda root, n: root / "extract" / f"page-{n:03d}.jpg"), \
                mock.patch.object(translate.netcheck, "problem", return_value=None), \
                mock.patch.object(translate.consistency, "check"):
            failed = translate.translate_pages(self.ws, cfg, [1, 2, 3, 4], threading.Event(), lambda *a: None)
        self.assertEqual(failed, {})
        self.assertEqual(calls, [[1, 2, 3, 4], [2]])
        self.assertEqual(self.ws.load("paper")["translation"]["done_pages"], [1, 2, 3, 4])

    def test_web_empty_answer_does_not_stop_later_batches(self):
        # 页面可正常通信，只有当前回答为空；重试失败后继续处理下一批。
        cfg = {"engine": "chatgpt_web", "chatgpt_web": {"model": "GPT", "batch_pages": 2}}
        calls = []

        def web_reply(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            page = int(prompt.split("这次只处理第 ")[1].split(" ")[0].split(",")[0])
            calls.append(page)
            pages = [3, 4] if page == 3 else []
            return json.dumps({"blocks": [{"id": f"p{n}-1", "type": "para", "page": n,
                                   "en": "source", "zh": "译文"} for n in pages]})

        with mock.patch.object(engines, "run", web_reply), \
                mock.patch.object(translate.pdfwork, "engine_image", side_effect=lambda root, n: root / "extract" / f"page-{n:03d}.jpg"), \
                mock.patch.object(translate.netcheck, "problem", return_value=None), \
                mock.patch.object(translate.consistency, "check"):
            failed = translate.translate_pages(self.ws, cfg, [1, 2, 3, 4], threading.Event(), lambda *a: None)
        self.assertEqual(sorted(failed), [1, 2])
        self.assertEqual(calls, [1, 1, 3])

    def test_web_dense_pages_reduce_batch_size(self):
        # 四页上限仍需受正文长度限制，避免一次生成过长的双语 JSON。
        batches = translate._batches([1, 2, 3, 4], 4, set(), {1: 5000, 2: 5000, 3: 5000, 4: 1000})
        self.assertEqual(batches, [[1, 2], [3, 4]])



class ScopePagesTest(unittest.TestCase):
    def test_range(self):
        from easyread.translate.translate import scope_pages

        class WS:
            def load(self, name):
                return {"meta": {"page_count": 20}}
        ws = WS()
        self.assertEqual(scope_pages(ws, "range:3-5"), [3, 4, 5])
        self.assertEqual(scope_pages(ws, "range:18-30"), [18, 19, 20])   # 超出总页数就截到最后一页
        self.assertEqual(scope_pages(ws, "range:5-3"), [3, 4, 5])        # 填反了也行
        self.assertEqual(scope_pages(ws, "range:30-18"), [18, 19, 20])
        with self.assertRaisesRegex(ValueError, "超出了论文范围"):
            scope_pages(ws, "range:30-40")
        self.assertEqual(scope_pages(ws, "first:2"), [1, 2])              # 旧写法还认


if __name__ == "__main__":
    unittest.main()
