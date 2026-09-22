from alexa_claude_mcp.voice import title_from_question, to_speech, truncate_for_speech


def test_strips_markdown_alexa_would_read_literally():
    spoken = to_speech(
        "## Resumo\n\n- **Primeiro** item\n- Segundo `item`\n\nVeja [a doc](https://exemplo.com).",
        max_chars=600,
    )
    assert "#" not in spoken
    assert "*" not in spoken
    assert "`" not in spoken
    assert "https" not in spoken
    assert "a doc" in spoken
    assert "Primeiro item" in spoken


def test_code_blocks_become_a_spoken_placeholder():
    spoken = to_speech("Assim:\n```python\nprint('oi')\n```\nPronto.", max_chars=600)
    assert "print" not in spoken
    assert "código omitido" in spoken


def test_truncates_at_a_sentence_boundary():
    text = "Primeira frase. Segunda frase. Terceira frase que estoura o limite."
    spoken = truncate_for_speech(text, max_chars=32)
    assert spoken == "Primeira frase. Segunda frase."


def test_truncation_falls_back_to_word_boundary():
    spoken = truncate_for_speech("palavra " * 20, max_chars=30)
    assert spoken.endswith("...")
    assert len(spoken) <= 33


def test_short_text_is_left_alone():
    assert to_speech("Tudo certo.", max_chars=600) == "Tudo certo."


def test_title_is_shortened_without_cutting_a_word():
    title = title_from_question("Me explique " + "detalhadamente " * 10)
    assert len(title) <= 63
    assert title.endswith("...")
