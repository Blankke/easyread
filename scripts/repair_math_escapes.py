"""从原始网页回答恢复被 JSON 转义损坏的公式，先预览，指定 --apply 才写入。

用法（项目根目录，先激活 .venv，并确认 which python 或 sys.executable）：
  python -m scripts.repair_math_escapes library/论文ID --answer 缓存回答.json --block eq1
  python -m scripts.repair_math_escapes library/论文ID --answer 缓存回答.json --block eq1 --apply
只恢复指定公式的双斜杠；其他差异拒绝覆盖。写入前备份到该论文的 history 目录。
"""
from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

from easyread.engines.engines import parse_json
from easyread.library.checks import tex_problems
from easyread.library.store import dir_lock, write_json_atomic


def progress(step: int, message: str) -> None:
    """按三个实际阶段显示进度，不输出整篇论文或完整模型回答。"""
    print(f"[{'#' * step}{'-' * (3 - step)}] {step}/3 {message}", flush=True)


def find_math(data: dict, block_id: str) -> dict:
    matches = [b for b in data.get("blocks", []) if b.get("id") == block_id and b.get("type") == "math"]
    if len(matches) != 1 or not isinstance(matches[0].get("tex"), str):
        raise ValueError("未找到唯一且含 TeX 的指定公式块")
    return matches[0]


def repair(root: Path, answer: Path, block_id: str, apply: bool = False) -> bool:
    paper_file = root / "paper.json"
    paper = json.loads(paper_file.read_text(encoding="utf-8"))
    original = find_math(paper, block_id)["tex"]
    cached = json.loads(answer.read_text(encoding="utf-8"))
    recovered = find_math(parse_json(cached["text"]), block_id)["tex"]
    progress(1, f"已读取公式 {block_id} 和原始回答")
    if original == recovered:
        progress(3, "公式已与原始回答一致，无需修改")
        return False
    if recovered.replace("\\\\", "\\") != original:
        raise ValueError("公式存在换行转义以外的差异，已停止覆盖")
    if not shutil.which("node"):
        raise RuntimeError("缺少 Node.js，无法验证公式渲染")
    problems = tex_problems([(block_id, recovered, True)])
    if problems:
        raise ValueError("；".join(problems))
    progress(2, "恢复后的公式已通过项目内置 KaTeX 校验")
    print("原公式：", json.dumps(original, ensure_ascii=False)[:200])
    print("恢复后：", json.dumps(recovered, ensure_ascii=False)[:200])
    if not apply:
        progress(3, "预览完成；增加 --apply 参数可写入")
        return False
    # 使用与应用相同的写锁，并重新读取，避免覆盖用户在校验期间做的其他编辑。
    with dir_lock(root):
        current = json.loads(paper_file.read_text(encoding="utf-8"))
        block = find_math(current, block_id)
        if block["tex"] != original:
            raise ValueError("校验期间公式发生变化，请重新预览")
        history = root / "history"
        history.mkdir(exist_ok=True)
        backup = history / f"paper-before-math-repair-{time.time_ns()}.json"
        with backup.open("xb") as stream:
            stream.write(paper_file.read_bytes())
        block["tex"] = recovered
        write_json_atomic(paper_file, current)
    progress(3, f"已恢复公式；原文件备份：{backup}")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paper", type=Path, help="论文目录")
    parser.add_argument("--answer", required=True, type=Path, help="含 text 字段的网页回答缓存")
    parser.add_argument("--block", required=True, help="公式块 ID")
    parser.add_argument("--apply", action="store_true", help="备份后写入恢复结果")
    args = parser.parse_args()
    repair(args.paper, args.answer, args.block, args.apply)


if __name__ == "__main__":
    main()
