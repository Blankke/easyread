import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from easyread.library.library import Library
from easyread.bulk import runner as migrate
from tests.zotero.fake_zotero import FakeZotero, pdf_bytes


class NowThread:
    """后台线程直接在当前线程跑完，测试里不用等。"""
    def __init__(self, target, args=(), daemon=None):
        self.target, self.args = target, args

    def start(self):
        self.target(*self.args)


class MigrateTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.zdir = root / "Zotero"
        self.z = FakeZotero(self.zdir)
        self.addCleanup(self.z.close)
        (root / "lib").mkdir()
        self.app = MagicMock()
        self.app.lib = Library(root / "lib")
        self.prefs = {"library": {"cats": ["我的旧分类"]}}
        patches = [patch.object(migrate.threading, "Thread", NowThread),
                   patch.object(migrate.prefs, "load", side_effect=lambda: self.prefs),
                   patch.object(migrate.prefs, "save", side_effect=lambda p: self.prefs.update(p))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.mig = migrate.Migration(self.app)

    def build(self):
        z = self.z
        a = z.item(title="Paper A", added="2022-05-06 07:08:09")
        z.pdf(a, "A")
        b = z.item(title="Paper B", DOI="10.1/b")
        top = z.collection("ML")
        sub = z.collection("CV", parent=top)
        z.collection("Empty")
        z.put(sub, a)
        z.tag(a, "必读")
        z.close()

    def papers(self):
        return {ws.load("paper")["meta"]["title_en"]: ws for ws in self.app.lib.all()}

    def test_scan_counts_without_importing(self):
        self.build()
        s = self.mig.scan("zotero", str(self.zdir))
        self.assertEqual((s["total"], s["with_pdf"], s["no_pdf"], s["fetchable"], s["collections"], s["tags"]), (2, 1, 1, 1, 3, 1))
        self.assertEqual(self.app.lib.all(), [])

    def test_import_keeps_metadata_categories_tags_and_date(self):
        self.build()
        st = self.mig.start("zotero", str(self.zdir))
        self.assertEqual((st["state"], st["imported"], len(st["skipped"])), ("done", 1, 1))
        ws = self.papers()["Paper A"]
        item = ws.load("item")
        self.assertEqual(item["tags"], ["ML/CV", "Zotero 标签/必读"])
        self.assertEqual(item["added"], "2022-05-06T07:08:09+00:00")
        (queued,), kw = self.app.jobs.enqueue.call_args
        self.assertEqual((queued.id, kw), (ws.id, {"translate_after": False}))  # 只渲染，不翻译
        self.assertEqual(self.prefs["library"]["cats"], ["我的旧分类", "Empty", "ML", "ML/CV", "Zotero 标签/必读"])  # 和 Zotero 一样按字母排

    def test_without_tags_and_second_run_only_adds_categories(self):
        self.build()
        self.mig.start("zotero", str(self.zdir), with_tags=False)
        ws = self.papers()["Paper A"]
        self.assertEqual(ws.load("item")["tags"], ["ML/CV"])
        ws.update("item", lambda i: i["tags"].append("自己加的"))
        st = self.mig.start("zotero", str(self.zdir))
        self.assertEqual((st["imported"], st["existing"]), (0, 1))
        self.assertEqual(ws.load("item")["tags"], ["ML/CV", "自己加的", "Zotero 标签/必读"])
        self.assertEqual(len(self.app.lib.all()), 1)

    def test_fetch_downloads_items_with_doi(self):
        self.build()
        self.app.lib.fetch = MagicMock(return_value=(pdf_bytes("B"), "b.pdf", {"title_en": "From the web", "venue": "Web"}))
        st = self.mig.start("zotero", str(self.zdir), fetch=True)
        self.app.lib.fetch.assert_called_once_with("10.1/b")
        self.assertEqual(st["imported"], 2)
        meta = self.papers()["Paper B"].load("paper")["meta"]
        self.assertEqual(meta["venue"], "Web")  # Zotero 没有的字段用下载来的补上

    def test_failed_download_is_recorded_and_others_continue(self):
        self.build()
        self.app.lib.fetch = MagicMock(side_effect=ValueError("404"))
        st = self.mig.start("zotero", str(self.zdir), fetch=True)
        self.assertEqual((st["state"], st["imported"]), ("done", 1))
        self.assertEqual(st["failed"][0]["title"], "Paper B")

    def test_linked_import_preserves_original_and_deduplicates_reader_data(self):
        self.build()
        st = self.mig.start("zotero", str(self.zdir), link=True)
        self.assertEqual((st["state"], st["imported"], len(st["skipped"])), ("done", 1, 1))
        ws = self.papers()["Paper A"]
        source = ws.source_pdf
        self.assertTrue(source.is_relative_to(self.zdir.resolve()))
        self.assertFalse((ws.root / "source.pdf").exists())
        self.assertEqual(ws.load("item")["tags"], ["ML/CV", "Zotero 标签/必读"])
        ws.apply_reader_ops([{"op": "paper_note", "body": "My reading note"}, {"op": "progress", "ratio": .6}])
        saved = ws.reader_path.read_bytes()
        st = self.mig.start("zotero", str(self.zdir), link=True)
        self.assertEqual((st["imported"], st["existing"]), (0, 1))
        self.assertEqual(ws.reader_path.read_bytes(), saved)
        self.assertTrue(source.is_file())

    def test_linked_mode_rejects_network_download_before_starting(self):
        self.build()
        with self.assertRaises(ValueError):
            self.mig.start("zotero", str(self.zdir), fetch=True, link=True)
        self.assertEqual(self.mig.status["state"], "idle")
        self.assertEqual(self.app.lib.all(), [])

    def test_category_names_are_clipped(self):
        self.assertEqual(migrate.cat_path("x" * 50, " a/b "), "x" * 40 + "/a／b")


if __name__ == "__main__":
    unittest.main()
