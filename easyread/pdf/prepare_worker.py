"""Run memory-heavy PDF preparation outside the long-lived application process."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

OOM_EXIT = 73


def is_memory_error(error):
    return isinstance(error, MemoryError) or (
        isinstance(error, OSError) and
        ((getattr(error, "winerror", 0) or 0) & 0xFFFFFFFF) == 0xE0000008)


def prepare_isolated(root: Path) -> list[dict]:
    """A failed native allocation cannot poison the next queued paper.

    Only derived page/text files are written by the child. User notes and the
    paper metadata remain owned by the parent. Each retry gets a fresh process.
    """
    prefix = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, "-m", "easyread"]
    package_root = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix="easyread-prepare-") as tmp:
        result = Path(tmp) / "result.json"
        for scale in (2.4, 1.2):
            result.unlink(missing_ok=True)
            completed = subprocess.run(
                prefix + ["--pdf-prepare-worker", str(root.resolve()), str(result), str(scale)],
                cwd=package_root, capture_output=True, encoding="utf-8", errors="replace",
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            data = json.loads(result.read_text(encoding="utf-8")) if result.exists() else {}
            if completed.returncode == 0 and "pages" in data:
                return data["pages"]
            oom = completed.returncode == OOM_EXIT or (completed.returncode & 0xFFFFFFFF) == 0xE0000008
            if not oom:
                raise RuntimeError(data.get("error") or completed.stderr[-800:] or
                                   f"PDF preparation worker exited ({completed.returncode})")
        from ..app.i18n import tr
        raise MemoryError(tr("PDF 处理内存不足，降低清晰度重试后仍未完成。请关闭占用内存较多的程序后重试。"))


def main(args):
    root, result, scale = Path(args[0]), Path(args[1]), float(args[2])
    from . import pdfwork
    try:
        # Reopen the document between rendered pages so native caches cannot
        # accumulate throughout a scanned book before the first text pass.
        pages = pdfwork.render_pages(root_source(root), root / "pages", scale=scale, reopen=True)
        pdfwork.extract_text(root_source(root), root / "extract")
        result.write_text(json.dumps({"pages": pages}), encoding="utf-8")
    except Exception as error:
        result.write_text(json.dumps({"error": f"{type(error).__name__}: {error}"}), encoding="utf-8")
        return OOM_EXIT if is_memory_error(error) else 1
    return 0


def root_source(root):
    from ..library.store import Workspace
    return Workspace(root).source_pdf
