"""The Claude side of the bridge: prompt, call, persist, shorten for speech."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol

from .config import Config
from .storage import Store
from .voice import title_from_question, to_speech

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are Claude, answering through an Alexa smart speaker.

Your reply is read out loud by a text-to-speech voice, so:
- Answer in {language} unless the user clearly writes in another language.
- Be direct: lead with the answer, then at most a sentence or two of context.
- Stay under {max_chars} characters. If the topic needs more, give the short answer and
  offer to go deeper on the next turn.
- Write plain spoken prose. No markdown, no bullet lists, no headings, no URLs, no code
  blocks - they are unreadable out loud. Spell out symbols and abbreviations when they
  would sound wrong.
- If you are unsure, say so in one sentence instead of guessing.
"""


class AnthropicLike(Protocol):
    """The slice of the Anthropic client this module uses (kept small so tests can fake it)."""

    messages: Any


@dataclass
class Answer:
    text: str
    conversation_id: str
    truncated: bool


class ClaudeBridge:
    def __init__(self, config: Config, store: Store, client: AnthropicLike | None = None) -> None:
        self._config = config
        self._store = store
        self._client = client or self._build_client()

    def _build_client(self) -> AnthropicLike:
        from anthropic import AsyncAnthropic

        return AsyncAnthropic(api_key=self._config.anthropic_api_key)

    @property
    def system_prompt(self) -> str:
        return SYSTEM_PROMPT.format(
            language=self._config.language, max_chars=self._config.max_spoken_chars
        )

    async def ask(self, *, subject: str, question: str, conversation_id: str | None = None) -> Answer:
        question = question.strip()
        if not question:
            raise ValueError("question must not be empty")

        if conversation_id:
            if not self._store.conversation_exists(conversation_id, subject):
                raise ValueError(f"conversation {conversation_id} not found")
        else:
            conversation_id = self._store.create_conversation(subject, title_from_question(question))

        history = self._store.recent_messages(conversation_id, self._config.history_turns)
        messages = [*history, {"role": "user", "content": question}]

        response = await self._client.messages.create(
            model=self._config.anthropic_model,
            max_tokens=self._config.anthropic_max_tokens,
            system=self.system_prompt,
            messages=messages,
        )
        raw = _text_of(response)
        spoken = to_speech(raw, self._config.max_spoken_chars)

        self._store.append_message(conversation_id, "user", question)
        self._store.append_message(conversation_id, "assistant", raw)

        return Answer(text=spoken, conversation_id=conversation_id, truncated=len(spoken) < len(raw))


def _text_of(response: Any) -> str:
    """Join the text blocks of a Messages API response."""
    parts: list[str] = []
    for block in getattr(response, "content", []) or []:
        if getattr(block, "type", None) == "text":
            parts.append(getattr(block, "text", ""))
    text = "\n".join(part for part in parts if part).strip()
    if not text:
        logger.warning(
            "Claude returned no text block (stop_reason=%s)", getattr(response, "stop_reason", None)
        )
        return "Não consegui gerar uma resposta agora. Tente de novo."
    return text
