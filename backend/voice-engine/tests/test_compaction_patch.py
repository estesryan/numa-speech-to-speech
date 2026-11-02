"""The long-session compaction fix: Qwen thinking must be disabled on upstream's MLX compaction path."""

from types import SimpleNamespace

import pytest

from numa_voice.patches import TESTED_UPSTREAM, check_upstream_version, compaction


class FakeTokenizer:
    def __init__(self):
        self.calls = []

    def apply_chat_template(self, messages, **kwargs):
        self.calls.append(kwargs)
        return "PROMPT"


def test_installed_upstream_is_the_tested_version():
    import speech_to_speech

    assert speech_to_speech.__version__ == TESTED_UPSTREAM
    check_upstream_version()


def test_upstream_1_1_0_still_has_the_defect():
    # if this fails, upstream fixed it: the patch becomes a no-op and can be removed
    assert compaction.upstream_is_affected()


def test_patched_mlx_compaction_disables_thinking(monkeypatch):
    import mlx_lm

    monkeypatch.setattr(mlx_lm, "generate", lambda *a, **k: '{"summary": "ok"}')
    tok = FakeTokenizer()
    handler = SimpleNamespace(backend="mlx", model=object(), tokenizer=tok)
    generate = compaction._build_compaction_generate_fn(handler)
    assert generate("system", "user") == '{"summary": "ok"}'
    assert tok.calls == [{"tokenize": False, "add_generation_prompt": True, "enable_thinking": False}]


def test_other_backends_use_upstream_code(monkeypatch):
    sentinel = object()
    monkeypatch.setattr(compaction, "_ORIGINAL", lambda self: sentinel)
    assert compaction._build_compaction_generate_fn(SimpleNamespace(backend="transformers")) is sentinel


def test_apply_is_a_no_op_once_upstream_is_fixed(monkeypatch):
    from speech_to_speech.LLM import language_model as lm

    before = lm.LanguageModelHandler._build_compaction_generate_fn
    monkeypatch.setattr(compaction, "upstream_is_affected", lambda: False)
    assert "not needed" in compaction.apply()
    assert lm.LanguageModelHandler._build_compaction_generate_fn is before


def test_apply_installs_the_fix(monkeypatch):
    from speech_to_speech.LLM import language_model as lm

    monkeypatch.setattr(lm.LanguageModelHandler, "_build_compaction_generate_fn", compaction._ORIGINAL)
    compaction.apply()
    assert lm.LanguageModelHandler._build_compaction_generate_fn is compaction._build_compaction_generate_fn


def test_untested_upstream_version_is_refused(monkeypatch):
    import speech_to_speech

    monkeypatch.setattr(speech_to_speech, "__version__", "9.9.9")
    monkeypatch.delenv("NUMA_VOICE_ALLOW_UNTESTED_UPSTREAM", raising=False)
    with pytest.raises(RuntimeError, match="Re-validate"):
        check_upstream_version()
