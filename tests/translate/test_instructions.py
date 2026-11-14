import json
import shutil
import threading
import unittest
from unittest.mock import patch

from easyread.app import config, i18n
from easyread.translate import instructions, translate, prompts, prompt_style
from easyread.server import settings_api
from tests.translate.test_translate import make_ws


class InstructionsTest(unittest.TestCase):
    def setUp(self):
        language = patch.object(i18n, "lang", return_value="zh")
        language.start()
        self.addCleanup(language.stop)

    def test_editor_and_translation_share_localized_defaults_including_old_saved_default(self):
        for language, wording in (("zh", "忠实"), ("en", "Be faithful"), ("zh-Hant", "忠實")):
            for target in ("zh", "zh-Hant", "en", "ja"):
                for saved in (None, prompt_style.DEFAULT):
                    with self.subTest(language=language, target=target, saved=saved is not None), patch.object(i18n, "lang", return_value=language):
                        cfg = {**config.DEFAULTS, "target": target, "translation_prompt": saved}
                        shown = config.public(cfg)
                        self.assertIn(wording, shown["translation_prompt_default"])
                        self.assertEqual(shown["translation_prompt_default"], shown["translation_prompt_effective"])
                        actual = instructions.apply(prompts.rules(target) + "\n" + prompts.schema(target), cfg)
                        self.assertIn(shown["translation_prompt_effective"], actual)
                        if language == "en":
                            self.assertIn("Japanese" if target == "ja" else "English" if target == "en" else "Chinese", shown["translation_prompt_default"])
                        self.assertIn(prompts.schema(target), actual)

    def test_custom_prompt_is_not_rewritten_when_switching_languages(self):
        custom = "术语保留英文；Keep KV cache unchanged."
        for language in ("zh", "en", "zh-Hant"):
            with patch.object(i18n, "lang", return_value=language):
                cfg = {"target": "ja", "translation_prompt": custom}
                self.assertEqual(prompt_style.effective(cfg), custom)
                self.assertIn(custom, instructions.apply(prompts.rules("ja"), cfg))

    def test_custom_prompt_replaces_style_but_preserves_output_contract(self):
        cfg = {"translation_prompt": "Use short sentences.", "translation_extra": "Keep agent in English."}
        original = prompts.rules() + "\n" + prompts.schema()
        result = instructions.apply(original, cfg)
        self.assertIn("Use short sentences.", result)
        self.assertIn("Keep agent in English.", result)
        self.assertNotIn(prompt_style.DEFAULT, result)
        self.assertNotIn(prompt_style.START, result)
        self.assertIn(prompts.MATH_RULES, result)
        self.assertIn(prompts.schema(), result)
        self.assertNotIn("Keep agent", instructions.apply(original, {"translation_prompt": cfg["translation_prompt"]}))

    def test_editor_keeps_legacy_preferences_and_default_language_adaptation(self):
        self.assertIn("Keep KV cache", prompt_style.effective({"translation_instructions": "Keep KV cache"}))
        self.assertEqual(prompt_style.effective({"translation_prompt": prompt_style.DEFAULT, "translation_instructions": "old"}), prompt_style.DEFAULT)
        result = instructions.apply(prompts.rules("en"), {"target": "en"})
        self.assertIn("English term (原文术语)", result)
        self.assertNotIn("中文母语者", result)
        for value in ("", [], "x" * 12001):
            with patch.object(settings_api.config, "save") as save:
                with self.assertRaises(ValueError):
                    settings_api.save_config({"translation_prompt": value})
                save.assert_not_called()

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
