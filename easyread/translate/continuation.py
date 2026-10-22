"""跨页续文核对：模型对一批页返回空（整批都是上一页那段的续文，已经并进上一段），确认属实才算译完。

只有原页文字完整出现在上一段英文的结尾、原页上又没有图形时才接受，不能据此吞掉没译的内容。
（思路和测试来自 NGman-s 的 PR #30。）
"""
from __future__ import annotations

import re
import unicodedata
from contextlib import closing

from ..engines import engines
from ..pdf import pdfwork
from ..app.i18n import tr
from ..library.paperdata import fill_zh
from .prompts import _is_note
from ..library.store import Workspace

_LIGATURES = str.maketrans({"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st"})
_BREAK = re.compile(
    r"(?<=[^\W\d_])[­￾](?:[ \t]*\n[ \t]*)?(?=[^\W\d_])"
    r"|(?<=[^\W\d_]{2})-[ \t]*\n[ \t]*(?=[^\W\d_]{2})"
)


def _text(text: str) -> str:
    """只统一空白和 PDF 连字，保留大小写、词间边界、连字符及上下标。"""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text).translate(_LIGATURES)).strip()


def _pattern(text: str) -> str:
    """仅原页明确的断词位置允许有/无连字符，不删除普通词中或公式里的减号。"""
    text = unicodedata.normalize("NFC", text).translate(_LIGATURES).strip()
    return "[-­￾]?".join(re.escape(_text(part)) for part in _BREAK.split(text))


def _source(ws: Workspace, batch: list[int]) -> str | None:
    """文字吻合不能证明图形也已处理；只接受可核对的纯文本 PDF 页。"""
    import pypdfium2 as pdfium

    parts = []
    try:
        source = ws.source_pdf
        if not source.exists():
            return None
        with pdfwork.open_pdf(source) as doc:
            for n in batch:
                path = ws.root / "extract" / f"page-{n:03d}.txt"
                if not path.exists():
                    return None
                lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
                with closing(doc[n - 1]) as page, closing(page.get_textpage()) as textpage:
                    if not textpage.count_chars() or any(obj.type != pdfium.raw.FPDF_PAGEOBJ_TEXT for obj in page.get_objects()):
                        return None
                    width, height = page.get_size()
                    footer = _text(textpage.get_text_bounded(0, 0, width, height * 0.08))
                    if lines and lines[-1] == str(n) and footer == str(n):
                        lines.pop()  # 仅忽略原页底部单独的页码，不把正文数字当页码丢掉
                text = "\n".join(lines)
                if not text or not any(c.isalpha() for c in text):
                    return None  # 空白页、扫描页、只有页码，都没有可核对的正文
                parts.append(text)
        return "\n".join(parts)
    except (OSError, UnicodeError, pdfium.PdfiumError, IndexError, ValueError):
        return None  # 原页读不出就保留失败状态，不能仅凭缓存文本宣告完成


def covered(ws: Workspace, batch: list[int], read: bool) -> bool:
    """这批（连续的页、上面还没有块）的原文已经完整并在上一段结尾：空输出算译完。
    read：只读原文，上一段有英文就行；否则上一段还得已经有译文。在合并锁里调。"""
    paper = ws.load("paper")
    if not batch or batch != list(range(batch[0], batch[-1] + 1)):
        return False
    if batch[0] - 1 not in paper.get("translation", {}).get("done_pages", []):
        return False
    blocks = paper.get("blocks", [])
    if any(b.get("page") in batch for b in blocks):
        return False  # 重译空输出不能删掉这些页上已有的块
    # 脚注不算上一段（和 prompts._context 一致：模型常把脚注排在页的最后一块）
    prev = next((b for b in reversed(blocks) if (b.get("page") or 0) < batch[0] and not _is_note(b)), None)
    if not prev or prev.get("type") != "para" or not prev.get("en") or (not read and not (prev.get("zh") or "").strip()):
        return False
    text = _source(ws, batch)
    return text is not None and re.search(_pattern(text) + r"\Z", _text(prev["en"])) is not None


class WaitPrev(Exception):
    """这几页模型没给新内容，可能整页都是上一页那段的续文，但上一页还在别的段里译，现在核对不了：
    先放着，全部译完再核对（settle）。核对通过就调 finish 把这几页记为完成。"""

    def __init__(self, pages: list[int], read: bool, finish):
        super().__init__(pages)
        self.pages, self.read, self.finish = pages, read, finish


def _runs(pages: list[int]) -> list[list[int]]:
    """把页码切成几段连续的。"""
    out: list[list[int]] = []
    for n in pages:
        if out and out[-1][-1] == n - 1:
            out[-1].append(n)
        else:
            out.append([n])
    return out


def fill_empty(ws: Workspace, empty: list[int], wait: bool) -> None:
    """补译文时没有块的页：上一段已经有译文、续文核对得上，就移出 en_pages；
    核对不上抛错，wait（上一页还在别的段里译）时抛 WaitPrev 等全部译完再核对。在合并锁里调。"""
    left = [n for run in _runs(empty) if not covered(ws, run, read=False) for n in run]
    done = [n for n in empty if n not in left]
    if done:
        fill_zh(ws, {}, done, set())
    if left and wait:
        raise WaitPrev(left, False, lambda: fill_zh(ws, {}, left, set()))
    if left:
        raise engines.EngineError(tr("模型没有译出任何内容"))


def settle(ws: Workspace, later: WaitPrev, lock, retry=None, note=lambda m: None) -> str:
    """全部译完后核对先放着的页：是续文就记完成；核对不上再调 retry 译一次（相当于失败重试，挪到了最后）。
    返回失败原因，成功返回 ""。note 写翻译记录。"""
    with lock:
        if covered(ws, later.pages, later.read):
            later.finish()
            note(tr("整页是上一段的续文"))
            return ""
    err = tr("模型没有整理出任何内容") if later.read else tr("模型没有译出任何内容")
    if not retry:
        return err
    note(tr("核对不是上一段的续文，再译一次"))
    try:
        retry()
        return ""
    except engines.Cancelled:
        raise
    except Exception as e:  # noqa: BLE001
        return (str(e) if isinstance(e, engines.EngineError) else f"{type(e).__name__}: {e}")[:300]
