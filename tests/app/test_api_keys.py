import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread.app import config
from easyread.app.api_keys import resolve
from easyread.chat.chat_models import engine_cfg


class EndpointKeysTest(unittest.TestCase):
    def test_switch_custom_endpoints_and_reload(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(config, "CONFIG_PATH", Path(tmp) / "config.json"):
            for url, key in [("https://a.example/v1/", "key-a"), ("https://b.example/v1", "key-b")]:
                config.save({"engine": "openai", "openai": config.with_key({"preset": "", "base_url": url, "api_key": key})})
            for url, expected in [("https://a.example/v1", "key-a"), ("https://b.example/v1/", "key-b")]:
                cfg = config.save({"openai": config.with_key({"preset": "", "base_url": url, "api_key": ""})})
                self.assertEqual(cfg["openai"]["api_key"], expected)
                cfg["chat"] = {"models": [{"id": "m1", "engine": "openai", "preset": "", "base_url": url, "model": "test"}]}
                self.assertEqual(engine_cfg(cfg, "m1")[0]["openai"]["api_key"], expected)
                self.assertNotIn(expected, str(config.public(cfg)))
            self.assertEqual(resolve(cfg["openai"], "", "https://unknown.example/v1"), "")

    def test_legacy_key_only_migrates_to_current_endpoint(self):
        o = {"preset": "", "base_url": "https://old.example/v1", "keys": {"": "legacy"}}
        self.assertEqual(resolve(o, "", o["base_url"]), "legacy")
        self.assertEqual(resolve(o, "", "https://other.example/v1"), "")
