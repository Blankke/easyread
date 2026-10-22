import json
import shutil
import threading
import unittest
from unittest.mock import patch

from easyread.translate import instructions, translate
from easyread.server import settings_api
from tests.translate.test_translate import make_ws


class InstructionsTest(unittest.TestCase):
    def test_empty_preserves_prompt_and_invalid_settings_never_save(self):
        self.assertEqual(instructions.apply("format rules", {}), "format rules")
        for value in (None, [], "x" * 4001):
            with self.subTest(value=str(value)[:20]), patch.object(settings_api.config, "save") as save:
                with self.assertRaises(ValueError):
                    settings_api.save_config({"translation_instructions": value})
                save.assert_not_called()

    def test_translation_fill_and_retranslation_get_preferences_but_read_mode_does_not(self):
        ws = make_ws(1)
        self.addCleanup(shutil.rmtree, ws.root)
        cfg = {"engine": "openai", "openai": {"vision": False},
               "translation_instructions": "Keep KV cache in English."}
        cancel = threading.Event()
        block = {"id": "p1", "type": "para", "page": 1, "en": "KV cache", "zh": "KV cache"}
        for read in (False, True):
            with patch.object(translate.engines, "run", return_value=json.dumps({"blocks": [block]})) as run, \
                    patch.object(translate.pdfwork, "locate"):
                translate._one_batch(ws, cfg, [1], 1, cancel, lambda *a: None, read=read)
            self.assertEqual("Keep KV cache" in run.call_args.args[1], not read)
        ws.update("paper", lambda p: p.__setitem__("blocks", [{**block, "zh": ""}]))
        with patch.object(translate.engines, "run", return_value=json.dumps({"zh": {"p1": "KV cache"}})) as run:
            translate._fill_batch(ws, cfg, [1], cancel, lambda *a: None)
        self.assertIn("Keep KV cache", run.call_args.args[1])
        with patch.object(translate.engines, "run", return_value=json.dumps({"zh": "KV cache"})) as run:
            translate.retranslate(ws, cfg, "p1", "", cancel)
        self.assertIn("Keep KV cache", run.call_args.args[1])
        self.assertIn("required JSON fields", run.call_args.args[1])
