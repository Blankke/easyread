"""Start the issue preview with an isolated copy of selected local papers."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
parser = argparse.ArgumentParser()
parser.add_argument("--source-library", type=Path, required=True)
parser.add_argument("--port", type=int, default=18765)
args = parser.parse_args()
home = root / "outputs" / "issue-preview" / "data"
library = home / "library"
library.mkdir(parents=True, exist_ok=True)
for pid in ("22570aaf1313", "92cb3a2b7136", "f8eeac73f437"):
    source, target = args.source_library / pid, library / pid
    if source.is_dir() and not target.exists():
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("history", "job.json", ".lock", "*.html"))
config = home / "config.json"
if not config.exists():
    config.write_text(json.dumps({"library_dir": str(library), "auto_translate": False, "engine": "none", "check_updates": False}), encoding="utf-8")
os.environ.update(EASYREAD_HOME=str(home), EASYREAD_LIBRARY=str(library), PYTHONUTF8="1")
from easyread.server.launch import serve
serve(args.port)
