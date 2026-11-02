"""Voice Studio against the real engine and models: create a voice, preview it, speak with it live.

The reference is the interruption question spoken by a built-in preset (Vivian) and generated for this run
(conftest.speech_clips), so no one's personal voice is involved. Identity is checked with the Base model's own speaker encoder: every live turn in the
custom voice must be closer to the reference than any turn of the Aiden preset (which the ren-test persona keeps),
and the turns must agree with each other more than with Aiden. Pitch is a cross-check.
"""

import asyncio
import io
import json
import statistics
import time
from pathlib import Path
from urllib.request import Request, urlopen

import librosa
import numpy as np
import pytest
import realtime_bench as rb
import soundfile as sf

from numa_voice.voice_models import capabilities

from test_live_engine import text_turn

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not capabilities()["clone"]["available"], reason="needs the Qwen3-TTS Base model"),
]
TURNS = ["Hello! How are you today?", "Tell me one nice thing about autumn.", "Thanks, that's lovely."]


@pytest.fixture(autouse=True)
def own_engine_only(engine):
    """These tests create and delete voices: never in an engine started elsewhere (NUMA_VOICE_TEST_URL), whose voice
    store may hold someone's real recordings."""
    if engine.voices is None:
        pytest.skip("Voice Studio tests run only against the engine they start, with a temporary voice store")


def http(engine, method: str, path: str, body: bytes | dict | None = None, content_type="application/json"):
    base = engine.url.replace("ws://", "http://").split("/v1/")[0]
    data = json.dumps(body).encode() if isinstance(body, dict) else body
    request = Request(f"{base}/v1/numa/voices{path}", data=data, method=method,
                      headers={"content-type": content_type} if data is not None else {})
    with urlopen(request, timeout=300) as response:
        return response.status, response.read(), response.headers.get("content-type")


@pytest.fixture(scope="module")
def speaker_embedding():
    """Speaker embeddings from the Qwen3-TTS Base model's encoder (24 kHz input), compared by cosine similarity."""
    import mlx.core as mx
    import soxr
    from mlx_audio.tts.utils import load_model

    from numa_voice.voice_models import model_path

    model = load_model(str(model_path("tts/qwen3-tts-1.7b-base-6bit")))

    def embed(audio: np.ndarray, rate: int) -> np.ndarray:
        audio = soxr.resample(audio.astype(np.float32), rate, 24000) if rate != 24000 else audio.astype(np.float32)
        vector = np.array(model.extract_speaker_embedding(mx.array(audio))).reshape(-1)
        return vector / np.linalg.norm(vector)

    return embed


def wait_idle(engine, timeout_s: float = 60.0) -> None:
    """Generation is refused while a session holds the engine; earlier tests' sessions take a moment to release."""
    deadline = time.monotonic() + timeout_s
    while json.loads(http(engine, "GET", "")[1])["busy"]:
        assert time.monotonic() < deadline, "the engine stayed busy"
        time.sleep(0.5)


def median_pitch(audio: np.ndarray, rate: int) -> float:
    f0, _, _ = librosa.pyin(audio.astype(np.float32), fmin=70, fmax=400, sr=rate, frame_length=2048)
    return float(np.nanmedian(f0))


async def session(engine, persona: str) -> tuple[dict, list[dict]]:
    """A text conversation with `persona`; the engine's voice notice and, per turn, audio and first-audio latency."""
    async with await rb.connect(f"{engine.url}?persona={persona}") as ws:
        notice = json.loads(await asyncio.wait_for(ws.recv(), 10))
        ev = rb.Events(ws)
        recv = asyncio.create_task(ev.receive(ws))
        await ws.send(json.dumps(rb.SESSION_UPDATE))
        await asyncio.sleep(0.5)
        busy = http(engine, "GET", "")[1]
        turns = []
        for text in TURNS:
            before = set(ev.responses)
            await text_turn(ws, ev, text)
            r = next(ev.responses[k] for k in ev.responses if k not in before and ev.responses[k].audio_bytes)
            pcm = np.frombuffer(b"".join(r.chunks), dtype="<i2").astype(np.float32) / 32768
            turns.append({"audio": pcm, "first_audio_s": r.first_audio - r.created, "text": r.text,
                          "server_tts_ttfa_s": (r.latency or {}).get("tts_ttfa_s")})
        recv.cancel()
        return {**notice, "busy_during_session": json.loads(busy)["busy"]}, turns


@pytest.fixture(scope="module")
def created(engine, speech_clips):
    wait_idle(engine)
    status, body, _ = http(engine, "POST", "?name=Studio%20test&method=uploaded&consent=true",
                           Path(speech_clips["question"]["file"]).read_bytes(), "audio/wav")
    assert status == 201
    voice = json.loads(body)["voice"]
    reference, rate = sf.read(engine.voices / voice["id"] / "reference.wav")
    return voice, median_pitch(reference, rate)


def test_a_created_voice_keeps_its_reference_and_transcript(engine, created):
    voice, _ = created
    profile = json.loads((engine.voices / voice["id"] / "profile.json").read_text())
    assert profile["method"] == "uploaded" and profile["consent"]["confirmed"] is True
    assert "long form conversations" in profile["synthesis"]["reference_text"].lower().replace("-", " ")
    assert profile["synthesis"]["revision"] == "34ff5318365b59cba9c03ff729f2eee0814caf72"


def test_preview_is_real_synthesis_in_that_voice(engine, created):
    voice, reference_pitch = created
    wait_idle(engine)
    t0 = time.perf_counter()
    status, body, kind = http(engine, "POST", "/preview", {"voice_id": voice["id"], "text": "This is a short preview."})
    assert status == 200 and kind == "audio/wav"
    audio, rate = sf.read(io.BytesIO(body))
    assert 1.0 < len(audio) / rate < 8.0
    assert abs(median_pitch(audio, rate) - reference_pitch) / reference_pitch < 0.25
    print(f"preview: {time.perf_counter() - t0:.2f} s for {len(audio) / rate:.1f} s of audio")


def test_conversation_speaks_live_in_the_default_voice_and_a_preset_persona_keeps_its_own(engine, created, speaker_embedding):
    voice, reference_pitch = created
    reference = speaker_embedding(*sf.read(engine.voices / voice["id"] / "reference.wav"))
    http(engine, "PUT", "/default", {"voice_id": voice["id"]})

    notice, custom = asyncio.run(session(engine, "numa-assistant"))
    assert notice["type"] == "numa.session" and notice["voice"]["id"] == voice["id"] and not notice["voice_fallback"]
    assert notice["busy_during_session"] is True  # previews and creation wait for the conversation
    custom_pitch = [median_pitch(t["audio"], rb.RATE) for t in custom]
    assert all(abs(p - reference_pitch) / reference_pitch < 0.25 for p in custom_pitch), (reference_pitch, custom_pitch)

    notice, preset = asyncio.run(session(engine, "ren-test"))
    assert notice["voice"]["id"] == "preset-aiden"
    preset_pitch = [median_pitch(t["audio"], rb.RATE) for t in preset]
    custom_emb = [speaker_embedding(t["audio"], rb.RATE) for t in custom]
    preset_emb = [speaker_embedding(t["audio"], rb.RATE) for t in preset]
    aiden = np.mean(preset_emb, axis=0)
    aiden /= np.linalg.norm(aiden)
    similarity = {
        "custom_to_reference": [float(e @ reference) for e in custom_emb],
        "custom_to_aiden": [float(e @ aiden) for e in custom_emb],
        "custom_between_turns": [float(a @ b) for i, a in enumerate(custom_emb) for b in custom_emb[i + 1:]],
        "aiden_to_reference": [float(e @ reference) for e in preset_emb],
    }
    print(json.dumps({"similarity": {k: [round(x, 3) for x in v] for k, v in similarity.items()}}))
    # every custom turn is recognized as the reference's voice, not the preset the ren-test persona uses
    assert all(r > a for r, a in zip(similarity["custom_to_reference"], similarity["custom_to_aiden"], strict=True))
    # and the turns sound like each other more than like Aiden: one voice for the whole session
    assert min(similarity["custom_between_turns"]) > max(similarity["custom_to_aiden"])
    # Aiden's turns are further from the reference than the clone's
    assert max(similarity["aiden_to_reference"]) < min(similarity["custom_to_reference"])

    report = {name: {"first_audio_s": statistics.median(t["first_audio_s"] for t in turns),
                     "server_tts_ttfa_s": statistics.median(t["server_tts_ttfa_s"] or 0 for t in turns),
                     "pitch_hz": [round(p) for p in pitches]}
              for name, turns, pitches in (("custom", custom, custom_pitch), ("preset", preset, preset_pitch))}
    print(json.dumps({"reference_pitch_hz": round(reference_pitch), **report}))
    assert report["custom"]["server_tts_ttfa_s"] < 1.0


def test_generation_is_refused_while_a_conversation_runs(engine, created):
    voice, _ = created

    async def preview_during_session():
        async with await rb.connect(f"{engine.url}?persona=numa-assistant"):
            await asyncio.sleep(0.5)
            try:
                http(engine, "POST", "/preview", {"voice_id": voice["id"]})
            except Exception as error:  # urllib raises HTTPError for 409
                return getattr(error, "code", None)
            return 200

    assert asyncio.run(preview_during_session()) == 409


@pytest.mark.skipif(not capabilities()["design"]["available"], reason="needs the Qwen3-TTS VoiceDesign model")
def test_a_described_voice_is_designed_saved_and_reproduced(engine, speaker_embedding):
    import base64

    wait_idle(engine)
    t0 = time.perf_counter()
    status, body, _ = http(engine, "POST", "/design/candidates",
                           {"description": "A soft, warm and calm female voice, gentle and unhurried.", "count": 2})
    design_s = time.perf_counter() - t0
    assert status == 200
    found = json.loads(body)
    clips = [sf.read(io.BytesIO(base64.b64decode(c["audio"]))) for c in found["candidates"]]
    assert len(clips) == 2 and all(3 < len(a) / r < 20 for a, r in clips)

    status, body, _ = http(engine, "POST", "/design", {"token": found["token"], "index": 1, "name": "Soft designed"})
    assert status == 201
    voice = json.loads(body)["voice"]
    profile = json.loads((engine.voices / voice["id"] / "profile.json").read_text())
    assert profile["design"]["description"].startswith("A soft, warm") and profile["design"]["model"].endswith("voicedesign-6bit")
    assert profile["synthesis"]["reference_text"] == found["text"]

    # the saved voice reproduces the chosen candidate, not the other one
    wait_idle(engine)
    _, wav, _ = http(engine, "POST", "/preview", {"voice_id": voice["id"], "text": "Good evening, it's nice to talk again."})
    spoken = speaker_embedding(*sf.read(io.BytesIO(wav)))
    chosen, other = (speaker_embedding(*clips[i]) for i in (1, 0))
    print(json.dumps({"design_s_for_2": round(design_s, 1), "saved_to_chosen": round(float(spoken @ chosen), 3),
                      "saved_to_other": round(float(spoken @ other), 3)}))
    assert spoken @ chosen > spoken @ other

