"""Extract model JSON without mistaking citation brackets for a result.

Adapted from bisuwuss-netizen's EasyRead PR #64. Keep block-array responses
supported, and skip malformed outer containers instead of rescuing their children.
"""
from __future__ import annotations

import json
import re

_TEX_COMMANDS = frozenset({"begin", "bar", "beta", "frac", "nabla", "nu", "operatorname", "overline",
                           "right", "rm", "sqrt", "text", "times", "top", "underbrace"})
_TEX_COMMAND_PATTERN = re.compile(r"[A-Za-z]+")
_TEX_ENVIRONMENT = re.compile(r"(begin|end)\{([A-Za-z*]+)\}")
_ROW_ENVIRONMENTS = frozenset({"matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix",
                               "smallmatrix", "array", "aligned", "alignedat", "gathered", "cases"})


def repair_escapes(body: str) -> str:
    """只修 JSON 字符串内的反斜杠，防止 TeX 命令被当成 JSON 的换行或制表符。"""
    out = []
    inside = math = tex = False
    environments = []
    i = 0
    while i < len(body):
        char = body[i]
        if not inside:
            if char == '"':
                inside = True
                tex = bool(re.search(r'"tex"\s*:\s*$', body[max(0, i - 80):i]))
                math = False
                environments = []
        elif char == '"':
            inside = math = tex = False
            environments = []
        elif char == "$":
            # $$ 是一个行间公式边界，不能连续翻转两次。
            pair = body.startswith("$$", i)
            math = not math
            out.append("$$" if pair else "$")
            i += 2 if pair else 1
            continue
        elif char == "\\":
            nxt = body[i + 1] if i + 1 < len(body) else ""
            end = i + 1
            while end < len(body) and body[end] == "\\":
                end += 1
            width = end - i
            environment = _TEX_ENVIRONMENT.match(body, end) if width <= 2 else None
            if environment:
                action, name = environment.groups()
                if action == "begin":
                    # 单斜杠的 begin 说明该环境直接输出了 TeX，尚未做 JSON 转义。
                    environments.append((name, width == 1))
                elif environments and environments[-1][0] == name:
                    environments.pop()
            if width >= 4:
                # 已正确转义的行分隔符原样保留；奇数尾巴交给下一轮处理 TeX 命令。
                paired = width - width % 2
                out.append("\\" * paired)
                i += paired
                continue
            if nxt in ('"', "\\"):
                if (nxt == "\\" and not environment and environments
                        and environments[-1][0] in _ROW_ENVIRONMENTS and environments[-1][1]):
                    # 原始 TeX 中的双斜杠是矩阵/多行公式换行，JSON 中必须写成四个。
                    # 正常 JSON 的双斜杠 begin 不进入此分支，避免重复转义合法公式。
                    out.extend((char, nxt))
                out.extend((char, nxt))
                i += 2
                continue
            command = _TEX_COMMAND_PATTERN.match(body, i + 1)
            tex_command = bool(command and command.group() in _TEX_COMMANDS)
            unicode_escape = nxt == "u" and bool(re.fullmatch(r"[0-9a-fA-F]{4}", body[i + 2:i + 6]))
            if ((math or tex or tex_command) and not unicode_escape) or not (nxt in "/bfnrt" or unicode_escape):
                out.append("\\")
        out.append(char)
        i += 1
    return "".join(out)


_DECODER = json.JSONDecoder(strict=False)


def _end(text: str, start: int) -> int:
    depth, quoted, escaped = 0, False, False
    for i in range(start, len(text)):
        char = text[i]
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "[{":
            depth += 1
        elif char in "]}":
            depth -= 1
            if depth == 0:
                return i + 1
    return len(text)


def _payload(text: str):
    error, pos = None, 0
    while pos < len(text):
        match = re.search(r"[\[{]", text[pos:])
        if not match:
            break
        start = pos + match.start()
        pos = _end(text, start)
        try:
            # 每个完整候选先修复 TeX 转义，再解析；保留上游对引用和残缺外层的检查。
            body = text[start:pos]
            try:
                obj = _DECODER.decode(repair_escapes(body))
            except json.JSONDecodeError:
                obj = _DECODER.decode(body)
            if (isinstance(obj, dict) or isinstance(obj, list)
                    and all(isinstance(block, dict) for block in obj)):
                return obj, None
        except json.JSONDecodeError as exc:
            error = error or exc
    return None, error


def extract(text: str):
    """Return (object or block array, first decode error); numeric citations lose."""
    text = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
    return _payload(text)
