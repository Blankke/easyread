"""Only extracted character data may be served alongside original PDF pages."""
from contextlib import nullcontext
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
import urllib.error
import urllib.request

from easyread.server.server import Handler
from scripts.smoke_backend import probe_pdf


class PDFTextTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source.pdf"
        self.source.write_bytes(probe_pdf())
        (self.root / "extract").mkdir()
        self.chars = [["A", .1, .2, .3, .4], ["字", .3, .2, .5, .4]]
        (self.root / "extract/page-001.chars.json").write_text(json.dumps(self.chars), encoding="utf-8")
        (self.root / "reader.json").write_text('{"private": true}', encoding="utf-8")
        (self.root / "extract/private.txt").write_text("private", encoding="utf-8")
        app = SimpleNamespace(lib=SimpleNamespace(ws=lambda pid: SimpleNamespace(root=self.root, source_pdf=self.source) if pid == "paper" else None),
                              location=SimpleNamespace(request=lambda *args: nullcontext(), status="idle"))
        handler = type("TextHandler", (Handler,), {"app": app, "log_message": lambda *args: None})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.url = f"http://127.0.0.1:{server.server_port}"

    def test_extracted_characters_have_json_content_type(self):
        with urllib.request.urlopen(self.url + "/p/paper/extract/page-001.chars.json") as response:
            self.assertEqual(json.load(response), self.chars)
            self.assertEqual(response.headers.get_content_type(), "application/json")

    def test_selection_requests_preserve_spaces_without_changing_layout_cache(self):
        with urllib.request.urlopen(self.url + "/p/paper/extract/page-001.chars.json?selection=2") as response:
            self.assertIn("EasyRead packaging smoke test.", "".join(row[0] for row in json.load(response)))
        self.assertEqual(json.loads((self.root / "extract/page-001.chars.json").read_text()), self.chars)

    def test_other_files_missing_pages_and_unknown_papers_are_not_exposed(self):
        for path in ("/p/paper/extract/private.txt", "/p/paper/extract/../reader.json",
                     "/p/paper/extract/page-002.chars.json", "/p/unknown/extract/page-001.chars.json"):
            with self.subTest(path=path), self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(self.url + path)
            self.assertEqual(error.exception.code, 404)
