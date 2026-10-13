"""Conversation-local overrides, independent of translation/model-card defaults."""
from ..app import cli_models
from ..app.i18n import tr
from ..engines import agent_cli


# 网页版无法设置模型内部推理预算；这些档位只约束本轮回答的详略和核对程度。
WEB_DEPTH_INSTRUCTIONS = {
    "brief": "先给结论，再用一到三点说明关键依据。回答简短，保留必要的条件、数字和例外。",
    "balanced": "先给结论，再解释主要依据和必要条件；篇幅与问题的复杂度相称。",
    "detailed": "先给结论，再逐点解释依据、关键推导和具体例子；保留重要条件与适用范围。",
    "rigorous": "回答前仔细核对相关原文、公式、数值和前提，指出不确定之处与可能的例外；只输出整理后的结论和依据。",
    "deep": "深入分析问题所需的多个角度，核对前提、推导、证据与反例，解释关键联系；只输出与问题有关的结论和依据。",
}


def web_depth_instruction(value: str) -> str:
    """把界面的回答深度转换成本轮网页提问中的指令。"""
    return "本轮回答深度要求：" + WEB_DEPTH_INSTRUCTIONS[value] + "\n"


def apply(ecfg: dict, options: dict | None) -> dict:
    if ecfg["engine"] == "chatgpt_web":
        selected = options if isinstance(options, dict) else {}
        depth = selected.get("answer_depth") or "balanced"
        if not isinstance(depth, str) or depth not in WEB_DEPTH_INSTRUCTIONS:
            raise ValueError(tr("不支持的回答深度"))
        ecfg["chatgpt_web"]["answer_depth"] = depth
        return {"answer_depth": depth}
    if not isinstance(options, dict):
        return {}
    out = {}
    effort = options.get("reasoning_effort")
    if effort is not None:
        allowed = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        engine = ecfg["engine"]
        if engine == "claude":
            allowed = [""] if "haiku" in ecfg[engine].get("model", "") else ["", "low", "medium", "high", "xhigh", "max"]
        elif engine == "codex":
            listing = cli_models.codex()
            model = ecfg[engine].get("model") or listing["default"]
            match = next((m for m in listing["models"] if m["id"] == model), {})
            if match.get("reasoning_levels"):
                allowed = ["", *match["reasoning_levels"]]
        elif engine in agent_cli.ENGINES:
            allowed = ["", *agent_cli.SPECS[engine]["efforts"]]
        elif engine == "codebuddy":
            allowed = [""]
        if effort not in allowed:
            raise ValueError("Unsupported reasoning effort")
        ecfg[engine]["reasoning_effort"] = effort
        out["reasoning_effort"] = effort
    return out
