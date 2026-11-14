"""User preferences augment the required translation format."""
from ..app.i18n import tr
from . import prompt_style


def validate(value):
    if not isinstance(value, str) or len(value) > 4000:
        raise ValueError(tr("翻译补充要求须为文字，最多 4000 字"))
    return value.strip()


def apply(prompt: str, cfg: dict) -> str:
    start, end = prompt.find(prompt_style.START), prompt.find(prompt_style.END)
    if start >= 0 and end > start:
        style = prompt_style.effective(cfg)
        prompt = prompt[:start] + style + prompt[end + len(prompt_style.END):]
    if cfg.get("translate_figure_text") is False:
        prompt += ("\n\nFigure text preference overrides the earlier figure-text instructions: "
                   "leave image_en and image_zh empty; do not transcribe or translate labels inside figures. "
                   "Still retain figures, crop boxes and fully translate figure captions and body text.")
    extra = validate(cfg.get("translation_extra", ""))
    # Repair prompts do not contain a style section. Keep legacy preferences there too.
    legacy = validate(cfg.get("translation_instructions", "")) if cfg.get("translation_prompt") is None else ""
    if start < 0 and legacy:
        extra = legacy + ("\n" + extra if extra else "")
    if start >= 0:
        prompt = ("Translation style may adjust terminology and wording only; preserve required JSON fields, "
                   "block IDs, all content, math delimiters and sentence-alignment markers. "
                   "The document structure and output format requirements take precedence.\n\n" + prompt)
    if not extra:
        return prompt
    return ("User translation preferences (terminology and wording only; "
            "preserve required JSON fields, block IDs, all content, math delimiters "
            "and sentence-alignment markers; do not omit content or change the "
            "output format):\n" + extra + "\n\n" + prompt)


def filter_figure_text(data: dict, cfg: dict) -> None:
    """Enforce the preference even when a model ignores the instruction."""
    if cfg.get("translate_figure_text") is not False:
        return
    for block in data.get("blocks", []):
        if block.get("type") == "figure":
            for key in ("image_en", "image_zh", "image_text_en", "image_text_zh"):
                block.pop(key, None)
    if isinstance(data.get("zh"), dict):
        data["zh"] = {k: v for k, v in data["zh"].items() if not k.endswith("#image")}
