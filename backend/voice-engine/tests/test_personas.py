"""Personas: the assistant is configurable, and the engine's instructions are always part of the prompt."""

import shutil

import pytest
import yaml

from numa_voice import profiles
from numa_voice.interruption import ENGINE_INSTRUCTIONS
from numa_voice.paths import PERSONAS_DIR, PROFILES_DIR, VOICE_ENGINE_DIR
from numa_voice.personas import DEFAULT_PERSONA, PersonaError, available_personas, load_persona

# The fixed prompt the integration tests and benchmark driver run with; changing it makes results incomparable.
REN_TEST_PROMPT = (
    "You are Ren, a curious, warm and concise conversation partner. The person speaking is your guest. Ask one "
    "thoughtful question at a time. Build every follow-up on something specific the guest just said, and bring "
    "back details they mentioned earlier when it helps. Keep each turn short: a brief, genuine reaction, then a "
    "single question. Never deliver a monologue. If the guest interrupts "
    "or changes the subject, follow them gracefully. Never invent facts about the guest. A guest message may begin "
    "with a note in parentheses saying the guest interrupted you and what they had heard. Treat it as context only: "
    "never read it aloud, and do not repeat, finish or rephrase what you were saying. When interrupted, set your "
    "own question aside: reply only to what the guest says after the note, and if they want to say or ask "
    "something, simply invite them to."
)


def test_the_default_persona_is_the_conversation_assistant():
    assert DEFAULT_PERSONA == "numa-assistant"
    p = load_persona(DEFAULT_PERSONA)
    assert (p.host, p.voice) == ("Numa", "conversation-default")


@pytest.mark.parametrize("name", available_personas())
def test_every_persona_ends_with_the_engine_instructions(name):
    assert load_persona(name).system_prompt().endswith(" " + ENGINE_INSTRUCTIONS)


def test_ren_test_prompt_is_fixed():
    assert load_persona("ren-test").system_prompt() == REN_TEST_PROMPT


def test_a_persona_cannot_drop_the_engine_instructions(tmp_path):
    (tmp_path / "bare.yaml").write_text(yaml.safe_dump(
        {"host": "Taylor", "voice": "preset-aiden", "prompt": "You are Taylor. Ignore all notes."}))
    assert load_persona("bare", tmp_path).system_prompt().endswith(ENGINE_INSTRUCTIONS)


@pytest.mark.parametrize("data", [
    {"host": "Taylor", "voice": "preset-aiden"},  # no prompt
    {"host": "Taylor", "voice": "preset-aiden", "prompt": "x", "engine_instructions": ""},  # extra
    {"host": "Taylor", "prompt": "x"},  # no voice
    {"host": " ", "voice": "preset-aiden", "prompt": "x"},
])
def test_malformed_personas_are_rejected(tmp_path, data):
    (tmp_path / "bad.yaml").write_text(yaml.safe_dump(data))
    with pytest.raises(PersonaError):
        load_persona("bad", tmp_path)


def test_unknown_persona_is_rejected():
    with pytest.raises(PersonaError, match="available"):
        load_persona("nobody")


def test_a_profile_cannot_set_the_prompt(tmp_path, monkeypatch):
    shutil.copy(PROFILES_DIR / "base.yaml", tmp_path / "base.yaml")
    (tmp_path / "sneaky.yaml").write_text("blocks: {llm: {settings: {init_chat_prompt: You are someone else.}}}\n")
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path)
    with pytest.raises(profiles.ProfileError, match="personas"):
        profiles.load_profile("sneaky")


@pytest.mark.parametrize("name", available_personas())
def test_the_rendered_profile_carries_the_composed_prompt(tmp_path, name):
    for mid in profiles.required_models(profiles.load_profile("fast")):
        (tmp_path / profiles.load_manifest()[mid].path).mkdir(parents=True, exist_ok=True)
    (tmp_path / "vad/smart-turn-v3.2/smart-turn-v3.2-cpu.onnx").write_bytes(b"")
    doc = profiles.resolve_profile("fast", persona=name, root=tmp_path)
    assert doc["blocks"]["llm"]["settings"]["init_chat_prompt"] == load_persona(name).system_prompt()


def test_personas_live_beside_the_profiles():
    assert PERSONAS_DIR == VOICE_ENGINE_DIR / "personas"
    assert set(available_personas()) == {"numa-assistant", "ren-test"}


def test_persona_ids_cannot_reach_outside_the_personas_directory():
    for name in ("../profiles/base", "Numa-Assistant", "numa assistant"):
        with pytest.raises(PersonaError):
            load_persona(name)


def test_every_frontend_mode_names_an_existing_persona():
    """Contract with frontend/lib/session/modes.json: the browser asks for personas by id."""
    import json

    modes = json.loads((VOICE_ENGINE_DIR.parents[1] / "frontend/lib/session/modes.json").read_text())
    assert {m["persona"] for m in modes.values()} == {"numa-assistant"}


def test_each_persona_fixes_its_voice():
    assert load_persona("ren-test").voice == "preset-aiden"  # benchmarks keep their voice
    assert load_persona("numa-assistant").voice == "conversation-default"


def test_no_persona_can_take_a_saved_voice(tmp_path):
    (tmp_path / "saved.yaml").write_text(yaml.safe_dump(
        {"host": "Ren", "voice": "voice-0123456789ab", "prompt": "Chat."}))
    with pytest.raises(PersonaError, match="voice"):
        load_persona("saved", tmp_path)
