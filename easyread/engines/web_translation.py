"""网页翻译的本地任务协议与有界上下文。

用法：由 chatgpt_web.stream 调用 prepare；测试用 python -m unittest
tests.engines.test_web_translation（先激活项目 .venv）。不提取或推断 PDF 语义。
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from uuid import uuid4

from ..library.store import Workspace, now_iso, read_json, write_json_atomic

PROTOCOL = "easyread-translation-v1"
MAX_BYTES = 32 * 1024 * 1024
RULES_VERSION = 3


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def file_hash(path: Path) -> str:
    # 项目支持 Python 3.10；分块读取也避免把整个 PDF 载入内存。
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def recovery_batches(cwd: Path, batches: list[list[int]], read_only: bool = False) -> list[list[int]]:
    """恢复原始批次边界，避免重启后批量配置变化让已提交任务失去入口。"""
    folder = cwd / "web-tasks"
    if not folder.is_dir():
        return batches
    remaining = {n for batch in batches for n in batch}
    claimed = set()
    recovered = []
    for file in sorted(folder.glob("*.json")):
        saved = read_json(file)
        if (saved.get("read_only", False) != read_only or "merged_pages" in saved
                or saved.get("status") not in ("pending", "received")
                or not (saved.get("submission_started") or saved.get("text"))):
            continue
        pages = saved.get("requested_pages", [])
        if set(pages) & claimed:
            raise ValueError("多个未确认任务页码重叠，请先核对原会话")
        if not set(pages) & remaining:
            continue
        if saved.get("source_sha256") != file_hash(cwd / "source.pdf"):
            raise ValueError("待恢复任务的 PDF 已改变，请先核对原任务")
        if not set(pages) <= remaining:
            raise ValueError("待恢复任务与当前页码范围部分重叠，请先核对原批次及本地进度")
        recovered.append(pages)
        claimed.update(pages)
        remaining.difference_update(pages)
    return sorted(recovered + [[n for n in batch if n in remaining] for batch in batches
                                if any(n in remaining for n in batch)], key=lambda batch: batch[0])


def snapshot(ws: Workspace, pages: list[int], source_hash: str) -> Path:
    """每次按本地权威数据刷新；时间不参与内容指纹，不因重复生成破坏附件复用。"""
    paper, reader = ws.load("paper"), ws.load("reader")
    meta = paper.get("meta") or {}
    before = [b for b in paper.get("blocks", []) if isinstance(b.get("page"), int) and b["page"] < min(pages)]
    previous = next((b for b in reversed(before) if b.get("type") == "para"), {})
    headings = [b for b in before if b.get("type") == "heading"][-3:]
    data = {"schema": 1, "rules_version": RULES_VERSION, "paper_id": ws.id,
            "source_sha256": source_hash, "title": str(meta.get("title_en") or "")[:500],
            "target": meta.get("target") or "zh", "requested_pages": pages,
            "done_pages": sorted(set((paper.get("translation") or {}).get("done_pages", []))),
            "data_version": digest([paper, reader]), "reader_rev": reader.get("rev", 0),
            "headings": [{k: str(b.get(k) or "")[:300] for k in ("num", "en", "zh")} for b in headings],
            "previous_paragraph": {k: str(previous.get(k) or "")[:1500] for k in ("id", "en", "zh")},
            "reader_note": str((reader.get("paper_note") or {}).get("body") or "")[:1500],
            "glossary": [], "marks": [],
            "authority": "仅作当前论文的上下文；PDF、原页图和本轮指定材料为原文依据。读者笔记不代表作者观点。完成页码只由本地验证与合并决定。"}
    # 按完整条目纳入，明确告知省略数量；不能切断 JSON 或把半个术语当成权威译名。
    for key, candidates, budget in (
        ("glossary", paper.get("glossary", []), 14000),
        ("marks", [n for n in (reader.get("notes") or {}).values() if not n.get("deleted")], 3000),
    ):
        used = 0
        for item in candidates:
            if key == "marks":
                anchor = next((b for b in paper.get("blocks", []) if b.get("id") == item.get("anchor")), {})
                if anchor.get("page") not in set(pages + [min(pages) - 1]):
                    continue
                item = {k: str(item.get(k) or "")[:500] for k in ("anchor", "kind", "quote", "body")}
            length = len(json.dumps(item, ensure_ascii=False))
            if used + length > budget:
                continue
            data[key].append(item)
            used += length
        data[key + "_omitted"] = len(candidates) - len(data[key])
    content_hash = digest(data)
    out = ws.root / "web-attachments" / "context.json"
    out.parent.mkdir(exist_ok=True)
    existing = read_json(out) if out.is_file() else {}
    if existing.get("content_hash") != content_hash:
        write_json_atomic(out, {**data, "content_hash": content_hash, "generated_at": now_iso()})
    return out


def validate(value: dict, task: dict) -> dict:
    """只核对传输信封；块、公式、漏页仍由原翻译管线验证，完成声明不写入进度。"""
    if not isinstance(value, dict):
        raise ValueError("结果文件必须是 JSON 对象")
    if (not isinstance(value.get("requested_pages"), list)
            or any(type(n) is not int for n in value["requested_pages"])):
        raise ValueError("结果文件页码必须为整数数组")
    for key in ("protocol", "task_id", "source_sha256", "requested_pages"):
        if value.get(key) != task.get(key):
            raise ValueError(f"结果文件任务归属不符：{key}")
    if value.get("status") != "complete":
        raise ValueError("结果文件未声明完整交付")
    result = value.get("result")
    if not isinstance(result, dict):
        raise ValueError("结果必须是对象")
    # 与原论文块协议保持同一语义：续批不重复元数据，无对应内容的辅助数组可以省略。
    result = dict(result)
    if "meta" not in result and 1 not in task["requested_pages"]:
        result["meta"] = {}
    if not isinstance(result.get("meta"), dict):
        raise ValueError("结果缺少 meta 对象")
    for key in ("blocks", "glossary", "references", "checks"):
        required = key == "blocks" or key == "references" and any(
            isinstance(block, dict) and block.get("type") == "references" for block in result["blocks"])
        if key not in result and not required:
            result[key] = []
        if not isinstance(result.get(key), list) or any(not isinstance(x, dict) for x in result[key]):
            raise ValueError(f"结果缺少有效的 {key} 数组")
    ids = set()
    for block in result["blocks"]:
        bid = block.get("id")
        if not isinstance(bid, str) or not bid or bid in ids:
            raise ValueError("结果文件的块 ID 缺失或重复")
        ids.add(bid)
        if type(block.get("page")) is not int or block["page"] not in task["requested_pages"]:
            raise ValueError("结果文件包含任务范围外的块")
    # translation/done_pages 等软件状态永远不由模型提供。
    return {key: result[key] for key in ("meta", "glossary", "references", "checks", "blocks")}


def prepare(cwd: Path, cfg: dict, prompt: str, files: list[str], session: str) -> tuple[dict, Path] | None:
    pages = cfg.get("requested_pages")
    if not pages or not (cwd / "source.pdf").is_file():
        return None
    if any(type(n) is not int or n < 1 for n in pages) or sorted(set(pages)) != pages:
        raise ValueError("网页任务页码必须为升序、唯一的正整数")
    mode = cfg.get("output_mode", "text")
    if mode not in ("text", "file", "auto"):
        raise ValueError("网页输出模式必须为 text、file 或 auto")
    source_hash = file_hash(cwd / "source.pdf")
    # 恢复已开始提交的批次时使用冻结输入；读者滚动/标记带来的新 rev 不应触发重复请求。
    task_dir = cwd / "web-tasks"
    if task_dir.is_dir():
        pending = []
        for file in task_dir.glob("*.json"):
            saved = read_json(file)
            if ((saved.get("submission_started") or saved.get("text"))
                    and saved.get("status") in ("pending", "received") and "merged_pages" not in saved
                    and saved.get("source_sha256") == source_hash and saved.get("requested_pages") == pages
                    and saved.get("session") == session
                    and saved.get("read_only", False) == cfg.get("read_only", False)):
                pending.append((saved, file))
        if len(pending) > 1:
            raise ValueError("同一页码存在多个未确认任务，请先核对原会话")
        if pending:
            return pending[0]
    context = snapshot(Workspace(cwd), pages, source_hash)
    key = digest([prompt, cfg.get("model"), pages, source_hash, mode, session, read_json(context)["content_hash"],
                  [(Path(f).name, file_hash(Path(f))) for f in files]])
    record = cwd / "web-tasks" / f"{key}.json"
    record.parent.mkdir(exist_ok=True)
    previous_attempts = []
    if record.is_file():
        saved = read_json(record)
        if saved.get("status") != "rejected":
            return saved, record
        previous_attempts = [*saved.get("previous_attempts", []),
                             {k: saved.get(k) for k in ("task_id", "status", "metrics", "error", "validated_at")}]
    task = {"protocol": PROTOCOL, "task_id": uuid4().hex, "paper_id": cwd.name,
            "source_sha256": source_hash, "requested_pages": pages, "output_mode": mode,
            "model": cfg.get("model") or "", "prompt_hash": digest(prompt), "status": "prepared",
            "previous_attempts": previous_attempts, "retry_count": len(previous_attempts),
            "read_only": bool(cfg.get("read_only")),
            "marks_rev": next((Path(f).stem.removeprefix("marks-") for f in files if Path(f).name.startswith("marks-")), ""),
            "created_at": now_iso(), "files": [*files, str(context)], "session": session,
            "snapshot_hash": read_json(context)["content_hash"]}
    instruction = (f"\n\n本轮论文 ID：{cwd.name}；PDF SHA256：{source_hash}。"
                   "context.json 是这篇论文的本地上下文，当前术语表优先；其中进度不授权扩大翻译范围。")
    if mode != "text":
        envelope = {k: task[k] for k in ("protocol", "task_id", "source_sha256", "requested_pages")}
        envelope.update(status="complete", result={"meta": {}, "glossary": [], "references": [], "checks": [], "blocks": []})
        instruction += ("\n本轮交付方式覆盖前文的正文输出要求：请生成一个 UTF-8 JSON 文件，文件名为 "
                        f"easyread-{task['task_id']}.json，并在最终回答中提供该文件的可下载附件。"
                        "result 内严格遵守前述完整结构；必须保留原文、译文、数学公式、表格、图内文字、引用和原译文对应关系。"
                        "blocks 必须完整填写，不得用摘要代替正文。包含第 1 页时必须提供 meta；"
                        "续批可省略 meta，无新术语、参考文献列表或检查项时可省略相应数组；提供字段时必须符合上述类型。"
                        "完成声明仅在本批全部处理完毕时填写 complete。信封格式：\n" + json.dumps(envelope, ensure_ascii=False))
        if mode == "auto":
            instruction += "\n如果当前工具无法生成附件，请直接在回答正文输出同一完整信封 JSON，供本地验证后回收。"
    task["prompt"] = prompt + instruction
    # 冻结本任务快照；后续刷新 context.json 不会改变未确认任务的输入附件。
    frozen = context.with_name(f"context-{task['task_id']}.json")
    frozen.write_bytes(context.read_bytes())
    task["files"][-1] = str(frozen)
    task["prompt"] = task["prompt"].replace("context.json", frozen.name)
    write_json_atomic(record, task)
    return task, record
