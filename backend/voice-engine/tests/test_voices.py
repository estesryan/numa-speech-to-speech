"""Voice Studio storage: saved voices survive restarts, stay private and fail safely."""

import io
import json

import numpy as np
import pytest
import soundfile as sf

from numa_voice.voices import (FALLBACK_VOICE, SAMPLE_RATE, VoiceError, VoiceNotFound, VoiceStore, prepare_reference,
                               wav_bytes)


def speech(seconds=6.0, rate=48000, level=0.3, clip=False) -> bytes:
    t = np.arange(int(seconds * rate)) / rate
    audio = level * np.sin(2 * np.pi * 180 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))
    if clip:
        audio = np.clip(audio * 4, -1, 1)
    buf = io.BytesIO()
    sf.write(buf, audio.astype(np.float32), rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def make(store: VoiceStore, name="My voice", method="recorded", consent=True):
    audio, _ = prepare_reference(speech())
    return store.create(name=name, method=method, audio=audio, reference_text="Hello there.", revision="abc",
                        consent=consent)


@pytest.fixture
def store(private_voices_dir):
    return VoiceStore(private_voices_dir)


def test_presets_are_listed_and_read_only(store):
    ids = [v.id for v in store.list()]
    assert ids[:2] == ["preset-aiden", "preset-ryan"] and "preset-serena" in ids
    with pytest.raises(VoiceError, match="Built-in"):
        store.delete("preset-aiden")
    with pytest.raises(VoiceError, match="Built-in"):
        store.rename("preset-serena", "Mine")


def test_a_saved_voice_keeps_everything_needed_to_speak_again(store):
    voice = make(store)
    profile = json.loads((store.root / voice.id / "profile.json").read_text())
    assert profile["synthesis"] == {"model": "tts/qwen3-tts-1.7b-base-6bit", "revision": "abc", "mode": "clone",
                                    "reference_audio": "reference.wav", "reference_text": "Hello there.",
                                    "language": "auto"}
    assert profile["consent"]["confirmed"] is True and profile["created_at"]
    audio, rate = sf.read(store.root / voice.id / "reference.wav")
    assert rate == SAMPLE_RATE and audio.ndim == 1
    assert sorted(p.name for p in (store.root / voice.id).iterdir()) == ["profile.json", "reference.wav"]


def test_voices_and_the_default_survive_a_restart(store, private_voices_dir):
    voice = make(store)
    store.set_default(voice.id)
    again = VoiceStore(private_voices_dir)  # a new process
    assert again.default_id() == voice.id
    assert again.get(voice.id).name == "My voice"


def test_recordings_need_the_owners_consent(store):
    with pytest.raises(VoiceError, match="permission"):
        make(store, consent=False)


def test_rename_and_delete(store):
    voice = make(store)
    assert store.rename(voice.id, "  Calm   evening ").name == "Calm evening"
    store.set_default(voice.id)
    assert store.delete(voice.id) == FALLBACK_VOICE  # the default falls back to a valid voice
    assert not (store.root / voice.id).exists()
    assert [v for v in store.list() if not v.builtin] == []


@pytest.mark.parametrize("bad", ["../etc", "voice-XYZ", "preset-nobody", "voice-0123456789ab/../x", ""])
def test_invalid_ids_never_reach_the_filesystem(store, bad):
    with pytest.raises(VoiceNotFound):
        store.get(bad)
    with pytest.raises(VoiceError):
        store.set_default(bad)


def test_damaged_voices_are_listed_as_unavailable_and_never_used(store):
    voice = make(store)
    store.set_default(voice.id)
    (store.root / voice.id / "reference.wav").write_bytes(b"not audio")
    listed = {v.id: v for v in store.list()}
    assert listed[voice.id].available is False and "damaged" in (listed[voice.id].problem or "")
    used, reason = store.resolve_default()
    assert used.id == FALLBACK_VOICE and reason


def test_serena_is_the_factory_default_and_an_explicit_choice_is_kept(store, private_voices_dir):
    assert FALLBACK_VOICE == "preset-serena"
    assert store.default_id() == "preset-serena" and store.resolve_default() == (store.get("preset-serena"), None)
    store.set_default("preset-aiden")  # a user who explicitly chose Aiden keeps Aiden
    assert VoiceStore(private_voices_dir).default_id() == "preset-aiden"


def test_a_corrupt_settings_file_falls_back(store):
    (store.root).mkdir(parents=True, exist_ok=True)
    (store.root / "settings.json").write_text("{not json")
    assert store.default_id() == FALLBACK_VOICE


def test_interrupted_writes_are_cleaned_up_but_not_writes_in_progress(store):
    import os
    import time

    make(store)
    old = time.time() - 7200
    for name in (".new-abc", ".deleted-voice-0123456789ab-ff"):
        (store.root / name).mkdir()
        os.utime(store.root / name, (old, old))
    (store.root / ".new-inprogress").mkdir()  # another request is writing this voice right now
    store.cleanup()
    assert sorted(p.name for p in store.root.iterdir() if p.name.startswith(".")) == [".new-inprogress"]


def test_the_browser_view_has_no_paths_transcripts_or_consent(store):
    public = make(store).public()
    assert set(public) == {"id", "name", "method", "builtin", "created_at", "description", "available", "problem"}


@pytest.mark.parametrize(("audio", "message"), [
    (speech(seconds=1.5), "at least 3"),
    (speech(seconds=40), "at most 30"),
    (speech(level=0.002), "too quiet"),
    (speech(clip=True), "clipping"),
    (b"RIFF....garbage", "could not be decoded"),
    (speech(rate=8000), "too low"),
])
def test_unsuitable_references_are_refused(audio, message):
    with pytest.raises(VoiceError, match=message):
        prepare_reference(audio)


def test_references_are_trimmed_resampled_and_normalized():
    silence = np.zeros(48000, dtype=np.float32)
    buf = io.BytesIO()
    body, _ = sf.read(io.BytesIO(speech(5)), dtype="float32")
    sf.write(buf, np.concatenate([silence, body, silence]), 48000, format="WAV")
    audio, info = prepare_reference(buf.getvalue())
    assert 4.8 < info["duration_s"] < 5.4  # one second of silence trimmed at each end
    assert abs(float(np.max(np.abs(audio))) - 0.89) < 0.01
    assert len(wav_bytes(audio)) > 0
