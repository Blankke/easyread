"""用法：激活 .venv 后运行 python -m unittest tests.library.test_math_repair -v。

验证历史公式恢复时的预览、备份和差异保护，不访问用户论文。
"""
import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from scripts.repair_math_escapes import repair


@unittest.skipUnless(shutil.which("node"), "需要 Node.js 校验真实 KaTeX 渲染")
class MathRepairTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.paper_file = self.root / "paper.json"
        self.answer = self.root / "answer.json"
        self.tex = r"\begin{bmatrix}1&1\\1&-1\end{bmatrix}"
        self.paper = {"meta": {"title": "保留论文资料"}, "blocks": [
            {"id": "eq1", "type": "math", "tex": self.tex.replace("\\\\", "\\")},
            {"id": "p1", "type": "para", "zh": "保留已有译文"}]}
        self.paper_file.write_text(json.dumps(self.paper), encoding="utf-8")
        raw = '{"blocks":[{"id":"eq1","type":"math","tex":"' + self.tex + '"}]}'
        self.answer.write_text(json.dumps({"text": raw}), encoding="utf-8")
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)

    def test_preview_apply_backup_and_repeat(self):
        before = self.paper_file.read_bytes()
        self.assertFalse(repair(self.root, self.answer, "eq1"))
        self.assertEqual(self.paper_file.read_bytes(), before)
        self.assertFalse((self.root / "history").exists())
        self.assertTrue(repair(self.root, self.answer, "eq1", apply=True))
        expected = self.paper
        expected["blocks"][0]["tex"] = self.tex
        self.assertEqual(json.loads(self.paper_file.read_text(encoding="utf-8")), expected)
        backups = list((self.root / "history").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)
        self.assertFalse(repair(self.root, self.answer, "eq1", apply=True))
        self.assertEqual(list((self.root / "history").iterdir()), backups)

    def test_refuse_to_overwrite_other_math_changes(self):
        self.paper["blocks"][0]["tex"] += "+x"
        self.paper_file.write_text(json.dumps(self.paper), encoding="utf-8")
        before = self.paper_file.read_bytes()
        with self.assertRaisesRegex(ValueError, "换行转义以外的差异"):
            repair(self.root, self.answer, "eq1", apply=True)
        self.assertEqual(self.paper_file.read_bytes(), before)
        self.assertFalse((self.root / "history").exists())
