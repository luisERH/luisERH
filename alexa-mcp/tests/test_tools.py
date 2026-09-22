import json


def _structured(result: dict) -> dict:
    return result["result"]["structuredContent"]


async def test_initialize_negotiates_the_alexa_protocol_version(session):
    # `session` already ran initialize(); re-reading tools proves the session stuck.
    listing = await session.request("tools/list")
    names = {tool["name"] for tool in listing["result"]["tools"]}
    assert names == {"ask_claude", "list_conversations", "get_conversation"}


async def test_tools_describe_themselves_for_the_orchestrator(session):
    listing = await session.request("tools/list")
    ask = next(t for t in listing["result"]["tools"] if t["name"] == "ask_claude")
    assert "conversation_id" in ask["inputSchema"]["properties"]
    assert ask["inputSchema"]["required"] == ["question"]
    assert ask["description"]


async def test_ask_claude_returns_a_spoken_answer_and_a_conversation_id(session, fake_anthropic):
    result = await session.request(
        "tools/call", {"name": "ask_claude", "arguments": {"question": "Qual a capital do Pará?"}}
    )
    payload = _structured(result)
    assert payload["answer"] == "A resposta curta do Claude."
    assert payload["conversation_id"]
    assert payload["truncated"] is False

    call = fake_anthropic.messages.calls[-1]
    assert call["messages"][-1] == {"role": "user", "content": "Qual a capital do Pará?"}
    assert "read out loud" in call["system"]


async def test_conversation_id_carries_the_history_into_the_next_call(session, fake_anthropic):
    first = await session.request(
        "tools/call", {"name": "ask_claude", "arguments": {"question": "Primeira pergunta"}}
    )
    conversation_id = _structured(first)["conversation_id"]

    second = await session.request(
        "tools/call",
        {
            "name": "ask_claude",
            "arguments": {"question": "E daí?", "conversation_id": conversation_id},
        },
    )
    assert _structured(second)["conversation_id"] == conversation_id

    messages = fake_anthropic.messages.calls[-1]["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant", "user"]
    assert messages[0]["content"] == "Primeira pergunta"


async def test_markdown_from_claude_is_flattened_for_speech(fake_anthropic, session):
    fake_anthropic.messages.reply = "## Título\n\n- **Um** ponto\n- Outro ponto"
    result = await session.request(
        "tools/call", {"name": "ask_claude", "arguments": {"question": "Liste dois pontos"}}
    )
    answer = _structured(result)["answer"]
    assert "#" not in answer and "*" not in answer
    assert "Um ponto" in answer


async def test_long_answers_are_truncated_and_flagged(session, fake_anthropic):
    fake_anthropic.messages.reply = "Frase longa que se repete. " * 60
    result = await session.request(
        "tools/call", {"name": "ask_claude", "arguments": {"question": "Discorra"}}
    )
    payload = _structured(result)
    assert payload["truncated"] is True
    assert len(payload["answer"]) <= 600


async def test_list_and_get_conversation(session):
    first = await session.request(
        "tools/call", {"name": "ask_claude", "arguments": {"question": "Pergunta sobre café"}}
    )
    conversation_id = _structured(first)["conversation_id"]

    listing = await session.request(
        "tools/call", {"name": "list_conversations", "arguments": {"limit": 5}}
    )
    conversations = _structured(listing)["conversations"]
    assert conversations[0]["conversation_id"] == conversation_id
    assert conversations[0]["title"] == "Pergunta sobre café"
    assert conversations[0]["message_count"] == 2

    transcript = await session.request(
        "tools/call",
        {"name": "get_conversation", "arguments": {"conversation_id": conversation_id}},
    )
    messages = _structured(transcript)["messages"]
    assert messages[0]["content"] == "Pergunta sobre café"


async def test_unknown_conversation_is_a_tool_error(session):
    result = await session.request(
        "tools/call",
        {"name": "ask_claude", "arguments": {"question": "oi", "conversation_id": "nao-existe"}},
    )
    assert result["result"]["isError"] is True
    assert "not found" in json.dumps(result["result"]["content"])


async def test_get_conversation_rejects_an_unknown_id(session):
    result = await session.request(
        "tools/call",
        {"name": "get_conversation", "arguments": {"conversation_id": "nao-existe"}},
    )
    assert result["result"]["isError"] is True
