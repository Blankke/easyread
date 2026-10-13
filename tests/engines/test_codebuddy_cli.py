"""CodeBuddy transport, permissions, errors and model selection (#63)."""
import base64
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from easyread.app import config
from easyread.chat import chat_models, chat_options
from easyread.engines import codebuddy_cli, engines, usage


class CodeBuddyCliTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cwd = Path(self.temp.name)
        self.calls = []

    def invoke(self, out, *, stderr="", code=0, c=None, images=None, cancel=None, meter=None, failure=None):
        def popen(args, **kwargs):
            self.calls.append({"args": args, **kwargs})
            kwargs["stderr"].write(stderr)
            kwargs["stderr"].flush()
            return mock.Mock(returncode=code)

        def communicate(proc, stdin, timeout, event):
            self.calls[-1].update(stdin=stdin, timeout=timeout, cancel=event)
            if failure:
                raise failure
            return out

        with mock.patch.object(codebuddy_cli, "path", return_value="X:/codebuddy.cmd"), \
                mock.patch.object(codebuddy_cli.subprocess, "Popen", side_effect=popen), \
                mock.patch.object(engines, "_communicate", side_effect=communicate), \
                mock.patch.object(codebuddy_cli.netcheck, "proxy_env", return_value=None):
            return codebuddy_cli.run(config.DEFAULTS["codebuddy"] | (c or {}), "text" * 10000,
                                     self.cwd, images or [], cancel, meter)

    def test_stdin_images_safe_args_and_usage(self):
        img = self.cwd / "page.png"
        img.write_bytes(b"image-bytes")
        meter = usage.Meter("codebuddy")
        out = json.dumps({"type": "result", "subtype": "success", "result": "translated",
                          "usage": {"input_tokens": 12, "cache_read_input_tokens": 20,
                                    "cache_creation_input_tokens": 3, "output_tokens": 4}})
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.invoke(out, images=[img], meter=meter, c={"model": "chosen"}), "translated")
            self.assertNotIn("CODEBUDDY_INTERNET_ENVIRONMENT", os.environ)
        call = self.calls[0]
        payload = json.loads(call["stdin"])["message"]["content"]
        self.assertEqual(payload[0]["text"], "text" * 10000)
        self.assertEqual(base64.b64decode(payload[1]["source"]["data"]), b"image-bytes")
        self.assertEqual(payload[1]["source"]["media_type"], "image/png")
        args = call["args"]
        self.assertNotIn(payload[0]["text"], args)
        self.assertEqual(args[args.index("--tools") + 1], "")
        self.assertIn("--strict-mcp-config", args)
        self.assertTrue(json.loads(args[args.index("--settings") + 1])["disableAllHooks"])
        self.assertNotIn("-y", args)
        self.assertEqual(call["env"]["CODEBUDDY_INTERNET_ENVIRONMENT"], "internal")
        self.assertEqual((meter.data["input"], meter.data["cached"], meter.data["output"]), (35, 20, 4))

    def test_jsonl_and_explicit_region(self):
        out = '\n'.join([json.dumps({"type": "system"}), json.dumps({"type": "result", "result": "ok"})])
        with mock.patch.dict(os.environ, {"CODEBUDDY_INTERNET_ENVIRONMENT": "ioa"}):
            self.assertEqual(self.invoke(out), "ok")
        self.assertEqual(self.calls[0]["env"]["CODEBUDDY_INTERNET_ENVIRONMENT"], "ioa")
        self.assertEqual(codebuddy_cli._result(json.dumps({"type": "result", "result": "pretty"}, indent=2))["result"], "pretty")

    def test_missing_error_and_nonzero_results(self):
        cases = [("", "no result", 0), ('{"type":"result","is_error":true,"result":"quota exhausted"}', "quota exhausted", 0),
                 ('{"type":"result","result":"partial"}', "login required", 1)]
        for out, err, code in cases:
            with self.subTest(out=out), self.assertRaises(engines.EngineError) as caught:
                self.invoke(out, stderr=err, code=code)
            self.assertIn(err, str(caught.exception))
        with self.assertRaisesRegex(engines.EngineError, "stderr preserved"):
            self.invoke("", stderr="stderr preserved", failure=engines.EngineError("exit"))
        message = "Authentication required. Please use /login command to sign in to your account"
        for error in (message, {"message": message, "code": "not-for-display"}):
            out = json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True,
                              "errors": [error]})
            with self.subTest(error=error), self.assertRaises(engines.EngineError) as caught:
                self.invoke(out)
            self.assertIn(message, str(caught.exception))
            self.assertNotIn("error_during_execution", str(caught.exception))
            self.assertNotIn("not-for-display", str(caught.exception))

    def test_cancel_and_timeout_forwarded_without_retry(self):
        cancel = threading.Event()
        with self.assertRaises(engines.Cancelled):
            self.invoke("", cancel=cancel, c={"timeout": 19}, failure=engines.Cancelled())
        self.assertIs(self.calls[0]["cancel"], cancel)
        self.assertEqual(self.calls[0]["timeout"], 19)
        self.assertEqual(len(self.calls), 1)

    def test_extra_args_cannot_enable_tools_or_mcp(self):
        for arg in ("-y", "--tools=Write", "--mcp-config", "--settings"):
            with self.subTest(arg=arg), self.assertRaises(engines.EngineError):
                codebuddy_cli.build_args({"extra_args": [arg]})

    def test_path_dispatch_and_model_mapping(self):
        with mock.patch.object(codebuddy_cli.shutil, "which", return_value="custom.exe") as which:
            self.assertEqual(engines.cli_path("codebuddy", {"command": "custom"}), "custom.exe")
            which.assert_called_once_with("custom")
        items = chat_models.sanitize([{"id": "cb", "name": "Buddy", "engine": "codebuddy", "model": "chosen"}])
        cfg = config.DEFAULTS | {"chat": {"models": items, "default": "cb"}}
        ecfg, _ = chat_models.engine_cfg(cfg, "cb")
        self.assertEqual(ecfg["codebuddy"]["model"], "chosen")
        self.assertEqual(chat_models.translation_id(ecfg), "cb")
        self.assertEqual(engines.image_mode(ecfg), "attached")
        images = [self.cwd / "page.png"]
        with mock.patch.object(codebuddy_cli, "run", return_value="ok") as run:
            self.assertEqual(engines._run(ecfg, "p", self.cwd, images, None, None), "ok")
        self.assertEqual(run.call_args.args[3], images)
        with self.assertRaises(ValueError):
            chat_options.apply(ecfg, {"reasoning_effort": "high"})


if __name__ == "__main__":
    unittest.main()
