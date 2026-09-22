"""Turn Claude's written answers into something Alexa can read out loud."""

from __future__ import annotations

import re

_CODE_FENCE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s*", re.MULTILINE)
_BULLET = re.compile(r"^\s{0,3}[-*+]\s+", re.MULTILINE)
_NUMBERED = re.compile(r"^\s{0,3}(\d+)[.)]\s+", re.MULTILINE)
_BOLD_ITALIC = re.compile(r"(\*\*|__|\*|_)(.*?)\1", re.DOTALL)
_LINK = re.compile(r"\[([^\]]+)\]\((?:[^)]+)\)")
_BLOCKQUOTE = re.compile(r"^\s{0,3}>\s?", re.MULTILINE)
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$", re.MULTILINE)
_MULTI_NEWLINE = re.compile(r"\n{2,}")
_MULTI_SPACE = re.compile(r"[ \t]{2,}")

SENTENCE_END = (". ", "! ", "? ", "; ", ".\n", "!\n", "?\n")


def to_speech(text: str, max_chars: int) -> str:
    """Strip markup Alexa would read literally, then trim to a sentence boundary."""
    cleaned = _CODE_FENCE.sub(" (trecho de código omitido) ", text)
    cleaned = _TABLE_ROW.sub(" ", cleaned)
    cleaned = _INLINE_CODE.sub(r"\1", cleaned)
    cleaned = _LINK.sub(r"\1", cleaned)
    cleaned = _HEADING.sub("", cleaned)
    cleaned = _BLOCKQUOTE.sub("", cleaned)
    cleaned = _BULLET.sub("", cleaned)
    cleaned = _NUMBERED.sub(r"\1. ", cleaned)
    cleaned = _BOLD_ITALIC.sub(r"\2", cleaned)
    cleaned = _MULTI_NEWLINE.sub(". ", cleaned)
    cleaned = cleaned.replace("\n", " ")
    cleaned = _MULTI_SPACE.sub(" ", cleaned).strip()
    cleaned = re.sub(r"\.\s*\.(\s|$)", r".\1", cleaned)
    return truncate_for_speech(cleaned, max_chars)


def truncate_for_speech(text: str, max_chars: int) -> str:
    """Cut at the last sentence end that fits; fall back to a word boundary."""
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    window = text[: max_chars + 1]
    cut = max(window.rfind(end) for end in SENTENCE_END)
    if cut > max_chars // 3:
        return window[: cut + 1].strip()
    space = window.rfind(" ")
    if space > 0:
        return window[:space].strip() + "..."
    return window[:max_chars].strip() + "..."


def title_from_question(question: str, max_chars: int = 60) -> str:
    """A short label so `list_conversations` reads well out loud."""
    collapsed = _MULTI_SPACE.sub(" ", question.replace("\n", " ")).strip()
    if len(collapsed) <= max_chars:
        return collapsed
    return collapsed[:max_chars].rsplit(" ", 1)[0] + "..."
