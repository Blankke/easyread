"""User preferences augment the required translation format."""
from ..app.i18n import tr


def validate(value):
    if not isinstance(value, str) or len(value) > 4000:
        raise ValueError(tr("翻译补充要求须为文字，最多 4000 字"))
    return value.strip()


def apply(prompt: str, cfg: dict) -> str:
    extra = validate(cfg.get("translation_instructions", ""))
    if not extra:
        return prompt
    return (prompt + "\n\nUser translation preferences (terminology and wording only; "
            "preserve required JSON fields, block IDs, all content, math delimiters "
            "and sentence-alignment markers; do not omit content or change the "
            "output format):\n" + extra)
