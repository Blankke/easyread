"""翻译 / 回答用的模型后端。

- claude：本机的 Claude Code 无头模式（claude -p），用你已有的登录，不需要 Key；能自己读原页图核对公式和表格。
- codex：本机的 Codex CLI（codex exec），同样用已有登录，原页图作为附件发过去。
- grok / agy / cursor：Grok Build、Antigravity CLI、Cursor CLI，同样用已有登录，自己读原页图（见 agent_cli.py）。
- openai：任何 OpenAI 兼容接口（Ollama、智谱、硅基流动、DeepSeek、Gemini……），在设置里填地址、模型和 Key；
  Chat Completions 和 Responses 两种格式都行（见 openai_api.py）。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from ..app.i18n import tr
from . import agent_cli, codex_lean, netcheck, usage
from ..app.log import log




class EngineError(RuntimeError):
    pass


class InvalidModelOutput(EngineError):
    """模型已回答，但返回内容无法解析；同一批可以安全地重新生成。"""


class Cancelled(RuntimeError):
    pass


ENGINE_NAMES = {"claude": "Claude Code", "codex": "Codex CLI", **{k: v["name"] for k, v in agent_cli.SPECS.items()},
                "openai": "API", "chatgpt_web": "ChatGPT 网页", "none": "不翻译"}  # i18n-ok 显示时用 engine_name()
CLI_ENGINES = ("claude", "codex", *agent_cli.ENGINES)  # 本机 CLI：起子进程、用已登录的订阅


def engine_name(engine: str | None) -> str:
    return tr("不翻译") if engine == "none" else tr("ChatGPT 网页") if engine == "chatgpt_web" else ENGINE_NAMES.get(engine, engine or "")


def run(cfg: dict, prompt: str, cwd: Path, images: list[Path] | None = None, cancel: threading.Event | None = None,
        meter: usage.Meter | None = None) -> str:
    """meter：传了就把这次调用的 token 用量记进去（整篇翻译时用）。"""
    bad = netcheck.problem(cfg)
    if bad:
        raise EngineError(bad)
    try:
        return _run(cfg, prompt, cwd, images, cancel, meter)
    except EngineError as e:
        raise EngineError(netcheck.explain(cfg, str(e))) from None


def _run(cfg: dict, prompt: str, cwd: Path, images: list[Path] | None, cancel: threading.Event | None, meter) -> str:
    engine = cfg.get("engine")
    if engine == "chatgpt_web":
        from . import chatgpt_web
        return chatgpt_web.run(cfg.get("chatgpt_web") or {}, prompt, cwd, images, cancel)
    if engine == "claude":
        return run_claude(cfg["claude"], prompt, cwd, cancel, meter)
    if engine == "codex":
        return run_codex(cfg["codex"], prompt, cwd, images or [], cancel, meter)
    if engine == "openai":
        return run_openai(cfg["openai"], prompt, images or [], cancel, meter)
    if engine in agent_cli.ENGINES:
        return agent_cli.run(engine, cfg[engine], prompt, cwd, cancel, meter)
    raise EngineError(tr("没有配置翻译引擎（设置 → 模型）"))


def image_mode(cfg: dict) -> str:
    """提示词里怎么说原页图：claude（和 grok / agy / cursor）自己用读文件的工具读；codex 和能看图的接口作为附件；其余没有图。"""
    engine = cfg.get("engine")
    if engine == "claude" or engine in agent_cli.ENGINES:
        return "claude"
    if engine in ("codex", "chatgpt_web") or (engine == "openai" and cfg["openai"].get("vision")):
        return "attached"
    return "text"


def who(cfg: dict) -> str:
    engine = cfg.get("engine")
    if engine == "openai":
        return cfg["openai"].get("model") or "API"
    return (cfg.get("chatgpt_web") or {}).get("model", "") if engine == "chatgpt_web" else engine if engine in CLI_ENGINES else ""


# ---------- 本机 CLI ----------
_NO_WINDOW = 0x08000000 if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
# stream-json 比 json 多一条 rate_limit_event（订阅额度用了百分之几）；-p 下用它必须加 --verbose
_CLAUDE_ARGS = ["--output-format", "stream-json", "--verbose", "--allowedTools", "Read", "--strict-mcp-config",
                "--disable-slash-commands", "--no-session-persistence"]


def claude_path(c: dict) -> str | None:
    return shutil.which(c.get("command") or "claude")


def codex_path(c: dict) -> str | None:
    return shutil.which(c.get("command") or "codex")


def cli_path(engine: str, c: dict) -> str | None:
    """本机 CLI 的可执行文件；没装返回 None。"""
    if engine == "claude":
        return claude_path(c)
    if engine == "codex":
        return codex_path(c)
    return agent_cli.path(engine, c)


def _popen(args: list[str], cwd: Path):
    return subprocess.Popen(args, cwd=str(cwd), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace", creationflags=_NO_WINDOW,
                            env=netcheck.proxy_env())


def run_claude(c: dict, prompt: str, cwd: Path, cancel=None, meter=None) -> str:
    exe = claude_path(c)
    if not exe:
        raise EngineError(tr("找不到 Claude Code 命令：{cmd}（先装好并登录 Claude Code）", cmd=c.get("command") or "claude"))
    args = [exe, "-p", *_CLAUDE_ARGS]
    if c.get("model"):
        args += ["--model", c["model"]]
    args += list(c.get("extra_args") or [])
    if c.get("reasoning_effort"):
        args += ["--effort", c["reasoning_effort"]]
    # lean（翻译时）：只给 Read 一个工具。--allowedTools 只是免确认，别的内置工具的定义照样每次都发，
    # 实测空调用固定上下文从约 3.2 万 token 降到约 5 千。用户设置（代理、默认模型、登录）照旧读。
    lean = CLAUDE_LEAN if c.get("lean") else []
    try:
        out = _communicate(_popen(args + lean, cwd), prompt, int(c.get("timeout") or 1200), cancel)
    except EngineError as e:
        if not lean or not option_unknown(e):
            raise
        log.warning("Claude Code 不认 --tools，照旧调用：%s", str(e)[-300:])
        out = _communicate(_popen(args, cwd), prompt, int(c.get("timeout") or 1200), cancel)
    events = _json_lines(out)
    res = next((e for e in reversed(events) if e.get("type") == "result"), None)
    if res is None:
        raise EngineError(tr("Claude Code 输出不是 JSON：{out}", out=out[:300]))
    if meter is not None:
        meter.add(**usage.from_claude(res, next((e for e in reversed(events) if e.get("type") == "rate_limit_event"), None)))
    if res.get("is_error") or res.get("subtype", "success") != "success":
        msg = str(res.get("result") or res.get("terminal_reason") or res.get("subtype"))
        if "limit" in msg.lower():
            msg += tr("（用量到上限了，等额度恢复后点“重试”，或在设置里换个引擎）")
        raise EngineError(tr("Claude Code 出错：{msg}", msg=msg))
    return res.get("result") or ""


def run_codex(c: dict, prompt: str, cwd: Path, images: list[Path], cancel=None, meter=None) -> str:
    """c["lean"]：不拉起用户 Codex 配置里的 MCP 服务（翻译时用，见 codex_lean）。
    这些覆盖参数让 Codex 报配置错误时，去掉它们照旧再调一次。"""
    exe = codex_path(c)
    if not exe:
        raise EngineError(tr("找不到 Codex 命令：{cmd}（先装好并登录 Codex CLI）", cmd=c.get("command") or "codex"))
    lean = codex_lean.args() if c.get("lean") else []
    try:
        text, out = _codex_once(exe, c, prompt, cwd, images, cancel, lean)
    except EngineError as e:  # 配置覆盖不被认时 codex 直接退出、只写 stderr
        if not lean or not _CONFIG_ERR.search(str(e)):
            raise
        text, out = "", str(e)
    if not text and lean and _CONFIG_ERR.search(out or ""):
        log.warning("Codex 不认关掉 MCP 的参数，照旧调用：%s", (out or "")[-300:])
        text, out = _codex_once(exe, c, prompt, cwd, images, cancel, [])
    events = _json_lines(out)
    if meter is not None:
        for e in events:
            if e.get("type") == "turn.completed":
                meter.add(**usage.from_codex(e))
    if not text:
        errs = [str(e.get("message") or (e.get("error") or {}).get("message") or "") for e in events if e.get("type") in ("error", "turn.failed")]
        raise EngineError(tr("Codex 没有给出结果：{msg}", msg=(next((m for m in reversed(errs) if m), "") or (out or "")[-300:])))
    return text


_CONFIG_ERR = re.compile(r"config|mcp_servers|notify|unknown (field|key)|invalid", re.I)
_OPTION_ERR = re.compile(r"unknown option|--tools", re.I)
CLAUDE_LEAN = ["--tools", "Read"]  # 只给 Read 一个工具（见 run_claude）


def option_unknown(err) -> bool:
    """Claude Code 版本太旧、不认 --tools 时的报错。"""
    return bool(_OPTION_ERR.search(str(err)))


def for_translation(cfg: dict) -> dict:
    """本机 CLI 只带用得到的东西（见 run_claude、run_codex）：整篇翻译、问 AI、回答笔记、重译一段都走这里。"""
    out = dict(cfg)
    for e in ("claude", "codex"):
        if isinstance(cfg.get(e), dict):
            out[e] = {**cfg[e], "lean": True}
    return out


def _codex_once(exe: str, c: dict, prompt: str, cwd: Path, images: list[Path], cancel, extra: list[str]) -> tuple[str, str]:
    fd, last = tempfile.mkstemp(suffix=".txt", prefix="easyread-codex-")
    os.close(fd)
    args = [exe, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--color", "never", "--json", "-o", last]
    if c.get("model"):
        args += ["--model", c["model"]]
    for img in images:
        args += ["-i", str(img)]
    args += list(c.get("extra_args") or [])
    for field, key in (("reasoning_effort", "model_reasoning_effort"), ("service_tier", "service_tier")):
        if c.get(field):
            args += ["-c", key + "=" + json.dumps(c[field])]
    args += extra + ["-"]
    try:
        out = _communicate(_popen(args, cwd), prompt, int(c.get("timeout") or 1200), cancel)
        text = Path(last).read_text(encoding="utf-8", errors="replace").strip()
    finally:
        Path(last).unlink(missing_ok=True)
    return text, out


def _json_lines(out: str) -> list[dict]:
    """CLI 一行一个 JSON 事件；夹杂的非 JSON 行跳过。"""
    events = []
    for line in (out or "").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return events


def _communicate(proc, stdin_text: str, timeout: int, cancel) -> str:
    result = {}

    def talk():
        result["out"], result["err"] = proc.communicate(stdin_text)

    t = threading.Thread(target=talk, daemon=True)
    t.start()
    waited = 0.0
    while t.is_alive():
        t.join(0.5)
        waited += 0.5
        if cancel is not None and cancel.is_set():
            proc.kill()
            raise Cancelled()
        if waited > timeout:
            proc.kill()
            raise EngineError(tr("超过 {n} 秒没有结果", n=timeout))
    if proc.returncode not in (0, None) and not result.get("out"):
        raise EngineError((result.get("err") or "")[-500:] or tr("退出码 {code}", code=proc.returncode))
    return result.get("out", "")


# ---------- OpenAI 兼容接口 ----------
def run_openai(c: dict, prompt: str, images: list[Path], cancel=None, meter=None) -> str:
    from . import openai_api  # 它要用本文件的 EngineError，放这里免得循环导入
    return openai_api.complete(c, prompt, images, cancel, meter)


_TEX_COMMANDS = frozenset({"begin", "bar", "beta", "frac", "nabla", "nu", "operatorname", "overline",
                           "right", "rm", "sqrt", "text", "times", "top", "underbrace"})
_TEX_COMMAND_PATTERN = re.compile(r"[A-Za-z]+")


def _repair_json_escapes(body: str) -> str:
    """只修 JSON 字符串内的反斜杠，防止 TeX 命令被当成 JSON 的换行或制表符。"""
    out = []
    inside = math = tex = False
    i = 0
    while i < len(body):
        char = body[i]
        if not inside:
            if char == '"':
                inside = True
                tex = bool(re.search(r'"tex"\s*:\s*$', body[max(0, i - 80):i]))
                math = False
        elif char == '"':
            inside = math = tex = False
        elif char == "$":
            # $$ 是一个行间公式边界，不能连续翻转两次。
            pair = body.startswith("$$", i)
            math = not math
            out.append("$$" if pair else "$")
            i += 2 if pair else 1
            continue
        elif char == "\\":
            nxt = body[i + 1] if i + 1 < len(body) else ""
            if nxt in ('"', "\\"):
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


def parse_json(text: str):
    """从模型输出里取出 JSON（容忍 ```json 围栏和前后废话）。"""
    t = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()  # 推理模型（deepseek-r1、qwen3）先输出的思考过程
    # 先取最外层的 { … }：译文里可能本身带代码块（论文附录的 PyTorch 代码），按 ``` 围栏切会切到半截
    bodies = []
    for s in (t, *(m.group(1).strip() for m in re.finditer(r"```(?:json)?\s*([\s\S]*?)```", t))):
        start = min([i for i in (s.find("{"), s.find("[")) if i >= 0], default=-1)
        if start >= 0:
            end = max(s.rfind("}"), s.rfind("]"))
            bodies.append(s[start:end + 1] if end >= start else s[start:])
    if not bodies:
        raise InvalidModelOutput(tr("模型输出里没有 JSON：{out}", out=text[:200]))
    first = None
    for body in bodies:
        fixed = _repair_json_escapes(body)
        # 优先解析公式转义修复后的内容；若它仍不合法，再试原文。
        for candidate in (fixed, body) if fixed != body else (body,):
            try:
                return json.loads(candidate, strict=False)
            except json.JSONDecodeError as e:
                first = first or e
    raise InvalidModelOutput(tr("模型输出的 JSON 格式有错（{err}）", err=first))


def _version(exe: str) -> str:
    try:
        return subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=30,
                              creationflags=_NO_WINDOW).stdout.strip().splitlines()[0]
    except Exception:  # noqa: BLE001
        return ""


def test(cfg: dict) -> dict:
    """设置页“测试”按钮：真的让模型回一句，确认引擎能用。"""
    engine = cfg.get("engine")
    if engine == "chatgpt_web":
        from . import chatgpt_web
        if not chatgpt_web.available():
            return {"ok": False, "message": tr("ChatGPT 网页未连接，请在桌面版登录")}
    if engine in CLI_ENGINES:
        exe = cli_path(engine, cfg[engine])
        if not exe:
            return {"ok": False, "message": tr("找不到 {engine} 命令，先安装并登录", engine=engine)}
    if engine == "none":
        return {"ok": True, "message": tr("未启用自动翻译")}
    try:
        out = run(cfg, '只回复 JSON，不要别的文字：{"ok": true}', Path(tempfile.gettempdir()), None, None)  # i18n-ok
        parse_json(out)
        return {"ok": True, "message": tr("可以用：{out}", out=out.strip()[:40])}
    except (EngineError, Cancelled) as e:
        return {"ok": False, "message": str(e)[:300]}
