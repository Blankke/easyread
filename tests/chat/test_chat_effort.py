import copy
import unittest
from easyread.app import config
from easyread.chat import chat, chat_options


class ChatEffortTest(unittest.TestCase):
    def test_explicit_override_does_not_change_card_or_translation(self):
        saved = copy.deepcopy(config.DEFAULTS)
        saved["claude"].update(model="opus", reasoning_effort="high")
        request = copy.deepcopy(saved)
        selected = chat_options.apply(request, {"reasoning_effort": "low"})
        self.assertEqual(request["claude"]["reasoning_effort"], "low")
        self.assertEqual(saved["claude"]["reasoning_effort"], "high")
        self.assertEqual(selected, {"reasoning_effort": "low"})
        chat_options.apply(request, {"reasoning_effort": ""})
        self.assertEqual(request["claude"]["reasoning_effort"], "")

    def test_legacy_requests_and_invalid_levels(self):
        cfg = copy.deepcopy(config.DEFAULTS)
        self.assertEqual(chat_options.apply(cfg, None), {})
        with self.assertRaises(ValueError):
            chat_options.apply(cfg, {"reasoning_effort": "invalid"})
        cfg["claude"]["model"] = "haiku"
        with self.assertRaises(ValueError):
            chat_options.apply(cfg, {"reasoning_effort": "high"})

    def test_web_depth_is_prompt_instruction_and_does_not_use_model_effort(self):
        import tempfile
        from pathlib import Path
        from easyread.library.store import Workspace, write_json_atomic

        cfg = {"engine": "chatgpt_web", "chatgpt_web": {"model": "6"}}
        selected = chat_options.apply(cfg, {"answer_depth": "rigorous", "reasoning_effort": "high"})
        self.assertEqual(selected, {"answer_depth": "rigorous"})
        self.assertNotIn("reasoning_effort", cfg["chatgpt_web"])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_json_atomic(root / "paper.json", {"meta": {}, "blocks": []})
            text = chat.prompt(Workspace(root), [{"role": "user", "content": "这段在说什么？"}],
                               None, "", "chatgpt_web", answer_depth=selected["answer_depth"])
            self.assertIn("本轮回答深度要求：", text)
            self.assertIn("核对相关原文、公式、数值和前提", text)
            self.assertIn("读者现在问：这段在说什么？", text)
        self.assertEqual(chat_options.apply({"engine": "chatgpt_web", "chatgpt_web": {}}, None),
                         {"answer_depth": "balanced"})
        with self.assertRaises(ValueError):
            chat_options.apply({"engine": "chatgpt_web", "chatgpt_web": {}}, {"answer_depth": "invalid"})
