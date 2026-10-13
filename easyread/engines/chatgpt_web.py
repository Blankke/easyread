"""桌面版 ChatGPT 网页任务桥。

用法：Electron 启动后端时设置 EASYREAD_WEB_BRIDGE_SECRET；网页任务由
run()/stream() 排队，桌面主进程通过 /api/desktop/web/next 领取并回传事件。
浏览器页面本身不能读取桥的凭据，也不能直接提交任务结果。
"""
from __future__ import annotations

import os
import hashlib
import json
import queue
import threading
import time
from pathlib import Path
from uuid import uuid4

from ..app.i18n import tr
from ..library.store import read_json, write_json_atomic
from .engines import Cancelled, EngineError

SECRET = os.environ.get("EASYREAD_WEB_BRIDGE_SECRET", "")
_pending: queue.PriorityQueue = queue.PriorityQueue()
_active: dict[str, dict] = {}
_lock = threading.Lock()
_order = 0
_heartbeat = 0.0


def available() -> bool:
    """网页来源只有桌面桥在线时才可执行。"""
    return bool(SECRET and time.monotonic() - _heartbeat < 15)


def heartbeat() -> dict:
    global _heartbeat
    _heartbeat = time.monotonic()
    return {"ok": True}


def next_task() -> dict:
    """优先领取聊天任务；过期或已取消的任务跳过。"""
    heartbeat()
    try:
        while True:
            _, _, rid = _pending.get_nowait()
            with _lock:
                task = _active.get(rid)
            if task and not task["cancel"].is_set():
                return {"request": task["request"]}
    except queue.Empty:
        return {"request": None}


def event(body: dict) -> dict:
    rid = str(body.get("id") or "")
    with _lock:
        task = _active.get(rid)
        if not task:
            return {"accepted": False, "cancelled": True}
        if task["cancel"].is_set():
            return {"accepted": False, "cancelled": True}
        seq = body.get("seq")
        if not isinstance(seq, int) or seq <= task["seq"]:
            return {"accepted": False, "cancelled": task["cancel"].is_set()}
        # 同一请求的序号核对和入队必须原子化，避免 HTTP 重试与迟到回包交错。
        part = str(body.get("text") or "")
        if body.get("done") and task["checkpoint"]:
            # 先原子落盘完整网页回答，再确认完成事件；此刻退出也能从本地继续解析。
            if not Path(task["request"]["cwd"]).exists():
                return {"accepted": False, "cancelled": True}
            full = task["answer"] + part
            if full:
                task["checkpoint"].parent.mkdir(exist_ok=True)
                write_json_atomic(task["checkpoint"], {"text": full})
        task["answer"] += part
        task["seq"] = seq
        task["events"].put(body)
        return {"accepted": True, "cancelled": task["cancel"].is_set()}


def cancel_paper_chat(cwd: Path) -> None:
    """阅读页点停止时，取消该论文尚在网页生成的问答。"""
    root = str(cwd.resolve())
    with _lock:
        for task in _active.values():
            req = task["request"]
            if req["cwd"] == root and req["kind"] == "chat":
                task["cancel"].set()


def _notes(ws) -> tuple[str, str]:
    """从已经落盘的标记生成附件，避免把尚在浏览器待同步的内容误称为最新。"""
    paper = ws.load("paper") or {}
    reader = ws.load("reader") or {}
    blocks = {b.get("id"): b for b in paper.get("blocks", [])}
    lines = ["EasyRead 阅读标记", "论文：" + str((paper.get("meta") or {}).get("title_en") or "")]
    note = (reader.get("paper_note") or {}).get("body")
    if note:
        lines += ["", "整篇笔记：", str(note)]
    for n in (reader.get("notes") or {}).values():
        if n.get("deleted"):
            continue
        b = blocks.get(n.get("anchor")) or {}
        lines += ["", "类型：" + str(n.get("kind") or "note"),
                  "颜色：" + str(n.get("color") or ""),
                  "页码：" + str(b.get("page") or ""),
                  "段落：" + str(n.get("anchor") or ""),
                  "引用：" + str(n.get("quote") or ""),
                  "内容：" + str(n.get("body") or "")]
    data = "\n".join(lines) + "\n"
    return data, str(reader.get("rev") or "0")


def _prepare(cwd: Path, kind: str, images: list[Path] | None) -> tuple[list[str], str]:
    from ..library.store import Workspace

    # 引擎既可能在论文目录运行，也可能在临时目录用于“试译一句”。
    if not (cwd / "paper.json").is_file():
        return [], ""
    ws = Workspace(cwd)
    marks, rev = _notes(ws)
    out = cwd / "web-attachments"
    out.mkdir(exist_ok=True)
    marks_path = out / f"marks-{rev}.txt"
    if not marks_path.exists() or marks_path.read_text(encoding="utf-8") != marks:
        marks_path.write_text(marks, encoding="utf-8")
    attachments = [str(marks_path)]
    pdf = cwd / "source.pdf"
    if pdf.is_file():
        attachments.insert(0, str(pdf))
    if kind == "translation":
        attachments.extend(str(p) for p in images or [] if p.is_file())
    return attachments, rev


def _checkpoint(cwd: Path, kind: str, prompt: str, model: str, session: str,
                files: list[str], rev: str) -> Path | None:
    """每次网页翻译用提示词、模型和附件版本定位回答快照。"""
    if kind != "translation" or not (cwd / "paper.json").is_file():
        return None
    versions = [(str(Path(file).relative_to(cwd)), Path(file).stat().st_size, Path(file).stat().st_mtime_ns)
                for file in files]
    key = json.dumps([kind, prompt, model, session, rev, versions], ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return cwd / "web-answers" / f"{digest}.json"


def discard(cfg: dict, prompt: str, cwd: Path, images: list[Path] | None = None,
            kind: str = "translation", session: str = "") -> None:
    """网页回答格式无效时丢弃该批快照，让下一次请求可以重新生成。"""
    cwd = cwd.resolve()
    files, rev = _prepare(cwd, kind, images)
    checkpoint = _checkpoint(cwd, kind, prompt, cfg.get("model") or "", session or f"{cwd}/{kind}", files, rev)
    if checkpoint:
        checkpoint.unlink(missing_ok=True)


def stream(cfg: dict, prompt: str, cwd: Path, cancel: threading.Event | None = None,
           images: list[Path] | None = None, kind: str = "chat", session: str = ""):
    """等待桌面网页执行，并逐段返回回答；取消后立刻作废请求编号。"""
    global _order
    cwd = cwd.resolve()
    stop = cancel or threading.Event()
    if stop.is_set() or not cwd.exists():
        raise Cancelled()
    files, rev = _prepare(cwd, kind, images)
    session = session or f"{cwd}/{kind}"
    checkpoint = _checkpoint(cwd, kind, prompt, cfg.get("model") or "", session, files, rev)
    try:
        saved = read_json(checkpoint) if checkpoint and checkpoint.is_file() else None
    except (ValueError, OSError):
        saved = None
    if isinstance(saved, dict) and isinstance(saved.get("text"), str) and saved["text"]:
        # 进程重启后先消费已完成的网页回答；后续校验与合并仍走原翻译流程。
        if stop.is_set() or not cwd.exists():
            raise Cancelled()
        yield saved["text"]
        return
    # 桌面后端会先于网页容器启动，续译任务可能已经排队。给启动握手留时间。
    if SECRET and not available():
        deadline = time.monotonic() + 45
        while not available() and time.monotonic() < deadline:
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            time.sleep(0.2)
    if not available():
        raise EngineError(tr("ChatGPT 网页未连接，请在桌面版打开并登录"))
    rid = uuid4().hex
    entry = {"request": {"id": rid, "kind": kind, "model": cfg.get("model") or "",
                         "prompt": prompt, "cwd": str(cwd), "session": session,
                         "files": files, "marks_rev": rev},
             "events": queue.Queue(), "cancel": stop, "seq": 0, "answer": "", "checkpoint": checkpoint}
    with _lock:
        _active[rid] = entry
        _order += 1
        _pending.put((0 if kind == "chat" else 1, _order, rid))
    last = time.monotonic()
    try:
        while True:
            if stop.is_set():
                raise Cancelled()
            if not cwd.exists():
                raise Cancelled()
            if not available():
                raise EngineError(tr("ChatGPT 网页连接中断；请检查桌面应用"))
            try:
                item = entry["events"].get(timeout=0.3)
            except queue.Empty:
                if time.monotonic() - last > 1200:
                    raise EngineError(tr("等待 ChatGPT 网页回复超时"))
                continue
            last = time.monotonic()
            if item.get("error"):
                raise EngineError(str(item["error"])[:500])
            if item.get("text"):
                yield str(item["text"])
            if item.get("done"):
                return
    finally:
        with _lock:
            _active.pop(rid, None)


def run(cfg: dict, prompt: str, cwd: Path, images=None, cancel=None, kind="translation") -> str:
    return "".join(stream(cfg, prompt, cwd, cancel, images, kind))
