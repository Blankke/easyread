"""Editable translation style, separate from the document/output contract."""
from ..app import i18n
from ..app.i18n import tr
from . import langs

START = "<translation-style>"
END = "</translation-style>"
DEFAULT = """- 忠实：保留原文的论证顺序、章节编号、公式、表格、引用号 [n]、限定词（may/suggest/likely/at least）、否定和比较对象。可以调整中文语序、拆长句，读起来要像中文母语者写的学术文字。
- 只翻译，不解释、不总结、不加原文没有的内容。原文的笔误照录，不要改。
- 术语全文统一；首次出现的核心术语写“中文（English）”。已有术语表必须遵守。统计学里 standard error 译“标准误差”。"""

_EN = """- Be faithful: preserve the argument order, section numbers, equations, tables, citations [n], qualifications (may/suggest/likely/at least), negation and objects of comparison. You may reorder clauses and split long sentences so the translation reads like academic writing by a native {language} speaker.
- Translate only: do not explain, summarize or add information absent from the source. Preserve errors in the original without silently correcting them.
- Use terminology consistently throughout. On first occurrence, write core terms as {term}. Follow the existing glossary.{statistics}"""

_HANT = """- 忠實：保留原文的論證順序、章節編號、公式、表格、引用號 [n]、限定詞（may/suggest/likely/at least）、否定和比較對象。可以調整語序、拆長句，讀起來要像以{language}為母語的人寫的學術文字。
- 只翻譯，不解釋、不總結、不加原文沒有的內容。原文的筆誤照錄，不要改。
- 術語全文統一；首次出現的核心術語寫「{term}」。已有術語表必須遵守。{statistics}"""


def default(target="zh", language=None):
    """The editor and translator use the same localized factory prompt."""
    target, language = langs.valid(target), language or i18n.lang()
    if language == "en":
        name = "Simplified Chinese" if target == "zh" else langs.TARGETS[target][2]
        term = '"English term (original-language term)"' if target == "en" else f'"{name} term (English)"'
        statistics = (' In statistics, translate standard error as "' + ("標準誤差" if target == "zh-Hant" else "标准误差") + '".') if langs.chinese(target) else ""
        return _EN.format(language=name, term=term, statistics=statistics)
    if language == "zh-Hant":
        name = {"zh":"簡體中文", "zh-Hant":"繁體中文", "en":"英文", "ja":"日文", "ko":"韓文",
                "es":"西班牙文", "fr":"法文", "de":"德文", "it":"義大利文"}[target]
        term = "English term（原文術語）" if target == "en" else name + "譯名（English）"
        statistics = ("統計學裡 standard error 譯為「" + ("標準誤差" if target == "zh-Hant" else "标准误差") + "」。") if langs.chinese(target) else ""
        return _HANT.format(language=name, term=term, statistics=statistics)
    from . import prompts
    text = prompts._swap(DEFAULT, prompts._RULES_SWAP, target)
    if target == "zh-Hant":
        text = text.replace("中文母语者", "繁体中文使用者").replace("中文（English）", "繁体中文（English）").replace("标准误差", "標準誤差")
    return text


def validate(value):
    if value is None:
        return None  # Factory default; also keeps old preferences until edited.
    if not isinstance(value, str) or not value.strip() or len(value) > 12000:
        raise ValueError(tr("翻译提示词不能为空，最多 12000 字"))
    return value.strip()


def effective(cfg, language=None):
    custom = validate(cfg.get("translation_prompt"))
    if custom is not None:
        # Older editor saves stored the unmodified Chinese default as a custom prompt.
        return default(cfg.get("target"), language) if custom == DEFAULT else custom
    legacy = cfg.get("translation_instructions", "").strip()
    return default(cfg.get("target"), language) + ("\n\n" + legacy if legacy else "")
