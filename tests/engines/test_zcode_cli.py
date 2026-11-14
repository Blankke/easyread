"""Official ZCode protocol, long prompts, errors and shared engine wiring (#112)."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from easyread.app import config
from easyread.chat import chat, chat_models, chat_options
from easyread.engines import engines, usage, zcode_cli


class ZCodeCliTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cwd = Path(self.temp.name)
        self.calls = []

    def invoke(self, out, *, stderr="", code=0, c=None, cancel=None, failure=None, meter=None):
        prompt = "\u8bba\u6587\n" * 20000

        def popen(args, **kwargs):
            root = Path(kwargs["cwd"])
            self.calls.append({"args": args, **kwargs, "prompt": (root / "easyread-task.txt").read_text(encoding="utf-8"),
                               "runtime": json.loads((root / "zcode.json").read_text(encoding="utf-8"))})
            kwargs["stderr"].write(stderr)
            kwargs["stderr"].flush()
            return mock.Mock(returncode=code, poll=lambda: code)

        def communicate(proc, stdin, timeout, event):
            self.calls[-1].update(stdin=stdin, timeout=timeout, cancel=event)
            if failure:
                raise failure
            return out

        with mock.patch.object(zcode_cli, "path", return_value="X:/zcode.exe"), \
                mock.patch.object(zcode_cli.subprocess, "Popen", side_effect=popen), \
                mock.patch.object(engines, "_communicate", side_effect=communicate), \
                mock.patch.object(zcode_cli.netcheck, "proxy_env", return_value={"HTTPS_PROXY": "http://localhost:7890"}):
            return zcode_cli.run(config.DEFAULTS["zcode"] | (c or {}), prompt, self.cwd,
                                 [Path("page.png")], cancel, meter)

    def test_long_unicode_prompt_images_login_and_usage(self):
        meter = usage.Meter("zcode")
        out = json.dumps({"response": " translated ", "projection": {"status": "idle"},
                          "usage": {"inputTokens": 11, "outputTokens": 3, "cacheReadTokens": 5}})
        self.assertEqual(self.invoke(out, meter=meter), "translated")
        call = self.calls[0]
        self.assertEqual(call["prompt"], "\u8bba\u6587\n" * 20000)
        self.assertEqual(call["stdin"], "")
        args = call["args"]
        self.assertLess(len(" ".join(args)), 2000)
        self.assertEqual(args[args.index("--mode") + 1], "plan")
        self.assertIn(str((self.cwd / "page.png").resolve()), args)
        self.assertNotIn("--model", args)
        self.assertNotIn("HOME", call["env"])
        self.assertNotIn("ZCODE_DATA_BASE_DIR", call["env"])
        self.assertEqual(call["env"]["ZCODE_HTTP_PROXY"], "http://localhost:7890")
        self.assertFalse(call["runtime"]["hooks"]["enabled"])
        self.assertFalse(call["runtime"]["features"]["mcp"])
        self.assertFalse(Path(call["cwd"]).exists())
        self.assertEqual((meter.data["input"], meter.data["cached"], meter.data["output"]), (11, 5, 3))

    def test_json_and_result_event(self):
        for out in ('{"response":"ok"}', 'notice\n{"type":"event"}\n{"type":"result","response":"ok"}'):
            self.assertEqual(self.invoke(out), "ok")

    def test_failures_never_become_answers(self):
        for out, err, code in [("", "login required", 1), ('{"response":"partial"}', "quota exhausted", 1),
                               ('{"error":"rejected"}', "", 0), ('{"response":""}', "", 0),
                               ('{"response":"partial","projection":{"status":"failed"}}', "", 0),
                               ('{"response":{"text":"wrong shape"}}', "", 0), ('not json', "", 0)]:
            with self.subTest(out=out), self.assertRaises(engines.EngineError) as caught:
                self.invoke(out, stderr=err, code=code)
            if err:
                self.assertIn(err, str(caught.exception))
            self.assertFalse(Path(self.calls[-1]["cwd"]).exists())

    def test_timeout_and_cancel_cleanup_without_retry(self):
        for error in (engines.Cancelled(), engines.EngineError("timeout")):
            before = len(self.calls)
            event = threading.Event()
            with self.assertRaises(type(error)):
                self.invoke("", c={"timeout": 7}, cancel=event, failure=error)
            self.assertEqual(len(self.calls), before + 1)
            self.assertEqual(self.calls[-1]["timeout"], 7)
            self.assertIs(self.calls[-1]["cancel"], event)
            self.assertFalse(Path(self.calls[-1]["cwd"]).exists())

    def test_no_unsupported_overrides(self):
        for c in ({"extra_args": ["--mode", "yolo"]}, {"model": "anything"}, {"reasoning_effort": "high"}):
            with self.subTest(c=c), self.assertRaises(engines.EngineError):
                zcode_cli.build_args(c, self.cwd, [])

    def test_detection_translation_and_chat(self):
        with mock.patch.object(zcode_cli.shutil, "which", return_value="custom.exe") as which:
            self.assertEqual(engines.cli_path("zcode", {"command": "custom"}), "custom.exe")
            which.assert_called_once_with("custom")
        items = chat_models.sanitize([{"id": "zc", "name": "ZCode", "engine": "zcode", "model": ""}])
        cfg = config.DEFAULTS | {"chat": {"models": items, "default": "zc"}}
        ecfg, _ = chat_models.engine_cfg(cfg, "zc")
        self.assertEqual(chat_models.translation_id(ecfg), "zc")
        self.assertEqual(engines.image_mode(ecfg), "attached")
        with mock.patch.object(zcode_cli, "run", return_value="answer") as run, \
                mock.patch.object(engines.netcheck, "problem", return_value=None):
            self.assertEqual(engines.run(ecfg, "translate", self.cwd), "answer")
            self.assertEqual(list(chat.stream(ecfg, "question", self.cwd, threading.Event())), ["answer"])
            self.assertEqual(run.call_count, 2)
        with self.assertRaises(ValueError):
            chat_options.apply(ecfg, {"reasoning_effort": "high"})


if __name__ == "__main__":
    unittest.main()
