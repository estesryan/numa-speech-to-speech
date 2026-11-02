"""Voice Studio API with a fake model backend (real inference is covered by the integration tests)."""

import base64
import io

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from numa_voice import voice_api, voice_models
from numa_voice.voices import SAMPLE_RATE, VoiceStore

from .test_voices import speech


class FakeModels:
    def __init__(self):
        self.calls = []
        self.fail_with = None
        self.clone = True

    def capabilities(self):
        reason = None if self.clone else "needs tts/qwen3-tts-1.7b-base-6bit"
        return {"presets": {"available": True, "reason": None},
                "clone": {"available": self.clone, "reason": reason},
                "design": {"available": self.clone, "reason": reason}}

    def _tone(self, seconds=1.0, hz=220.0):
        if self.fail_with:
            raise self.fail_with
        t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
        return (0.3 * np.sin(2 * np.pi * hz * t)).astype(np.float32)

    def synthesize(self, store, voice, text):
        self.calls.append(("synthesize", voice.id, text))
        return self._tone()

    def synthesize_reference(self, reference, reference_text, text):
        self.calls.append(("candidate", len(reference), text))
        return self._tone()

    def transcribe(self, audio):
        self.calls.append(("transcribe", len(audio)))
        return "This is how I sound."

    def design_candidates(self, description, count):
        self.calls.append(("design", description, count))
        return [self._tone(5, 180 + 40 * i) for i in range(count)], "Hello, it's lovely to meet you."


@pytest.fixture
def api(private_voices_dir):
    models = FakeModels()
    state = {"busy": False}
    app = FastAPI()
    app.include_router(voice_api.router(lambda: state["busy"], lambda: VoiceStore(private_voices_dir), models))
    return TestClient(app), models, state


def upload(client, name="Me", consent="true", data=None, method="recorded"):
    return client.post(f"/v1/numa/voices?name={name}&method={method}&consent={consent}",
                       content=data if data is not None else speech(), headers={"content-type": "audio/wav"})


def test_lists_presets_default_and_capabilities(api):
    client, _, _ = api
    body = client.get("/v1/numa/voices").json()
    assert body["default"] == "preset-serena" and body["busy"] is False  # factory default
    assert {v["id"] for v in body["voices"]} >= {"preset-aiden", "preset-serena"}
    assert body["capabilities"]["clone"]["available"] is True


def test_preview_returns_real_synthesis_as_wav(api):
    client, models, _ = api
    r = client.post("/v1/numa/voices/preview", json={"voice_id": "preset-serena", "text": "Hello there."})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    audio, rate = sf.read(io.BytesIO(r.content))
    assert rate == SAMPLE_RATE and len(audio) == SAMPLE_RATE
    assert models.calls == [("synthesize", "preset-serena", "Hello there.")]


def test_recorded_voice_is_transcribed_saved_and_selectable(api):
    client, models, _ = api
    r = upload(client, name="Morning voice")
    assert r.status_code == 201, r.text
    voice = r.json()["voice"]
    assert voice["method"] == "recorded" and voice["name"] == "Morning voice"
    assert ("transcribe", pytest.approx(6 * SAMPLE_RATE, rel=0.05)) in [(c[0], c[1]) for c in models.calls]
    assert client.put("/v1/numa/voices/default", json={"voice_id": voice["id"]}).json()["default"] == voice["id"]
    preview = client.post("/v1/numa/voices/preview", json={"text": "Hi"})  # no id: the Conversation default
    assert preview.status_code == 200 and models.calls[-1][1] == voice["id"]


def test_consent_is_required(api):
    client, models, _ = api
    r = upload(client, consent="false")
    assert r.status_code == 400 and "permission" in r.json()["detail"]
    assert models.calls == []


@pytest.mark.parametrize(("data", "message"), [(b"garbage", "decoded"), (speech(seconds=1), "at least 3")])
def test_unsuitable_uploads_are_refused_before_any_model_runs(api, data, message):
    client, models, _ = api
    r = upload(client, data=data, method="uploaded")
    assert r.status_code == 400 and message in r.json()["detail"]
    assert models.calls == []


def test_designed_voice_flow(api):
    client, models, _ = api
    r = client.post("/v1/numa/voices/design/candidates", json={"description": "A soft, warm, calm female voice", "count": 3})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["candidates"]) == 3
    assert sf.read(io.BytesIO(base64.b64decode(body["candidates"][1]["audio"])))[1] == SAMPLE_RATE
    p = client.post("/v1/numa/voices/preview", json={"candidate": {"token": body["token"], "index": 1}, "text": "Hi"})
    assert p.status_code == 200 and models.calls[-1][0] == "candidate"
    saved = client.post("/v1/numa/voices/design", json={"token": body["token"], "index": 1, "name": "Soft"})
    assert saved.status_code == 201
    voice = saved.json()["voice"]
    assert voice["method"] == "designed" and voice["description"] == "A soft, warm, calm female voice"
    again = client.post("/v1/numa/voices/design", json={"token": body["token"], "index": 1, "name": "Soft"})
    assert again.status_code == 404  # candidates are used once


def test_generation_waits_for_the_conversation_to_end(api):
    client, models, state = api
    state["busy"] = True
    assert client.post("/v1/numa/voices/preview", json={"voice_id": "preset-aiden"}).status_code == 409
    assert upload(client).status_code == 409
    assert client.post("/v1/numa/voices/design/candidates", json={"description": "A calm deep voice"}).status_code == 409
    assert client.put("/v1/numa/voices/default", json={"voice_id": "preset-serena"}).status_code == 200
    assert models.calls == []


def test_rename_delete_and_their_errors(api):
    client, _, _ = api
    vid = upload(client).json()["voice"]["id"]
    assert any(v["name"] == "Renamed" for v in client.patch(f"/v1/numa/voices/{vid}", json={"name": "Renamed"}).json()["voices"])
    assert client.patch("/v1/numa/voices/preset-aiden", json={"name": "x"}).status_code == 400
    assert client.delete(f"/v1/numa/voices/{vid}").status_code == 200
    assert client.delete(f"/v1/numa/voices/{vid}").status_code == 404
    assert client.patch("/v1/numa/voices/..%2Fsettings.json", json={"name": "x"}).status_code in (404, 400)


def test_model_failures_are_reported_and_recoverable(api):
    client, models, _ = api
    models.fail_with = RuntimeError("Metal ran out of memory")
    r = client.post("/v1/numa/voices/preview", json={"voice_id": "preset-serena"})
    assert r.status_code == 500 and "Metal" not in r.json()["detail"]  # details go to the log, not the browser
    models.fail_with = None
    assert client.post("/v1/numa/voices/preview", json={"voice_id": "preset-serena"}).status_code == 200


def test_missing_models_are_reported_not_faked(api):
    client, models, _ = api
    models.clone = False
    r = upload(client)
    assert r.status_code == 503 and "base-6bit" in r.json()["detail"]
    models.fail_with = voice_models.ModelUnavailable("Designing voices needs the VoiceDesign model")
    assert client.post("/v1/numa/voices/design/candidates", json={"description": "A calm deep voice"}).status_code == 503


def test_uploads_over_the_limit_are_refused_without_reading_them_whole(api, monkeypatch):
    client, models, _ = api
    monkeypatch.setattr(voice_api, "MAX_UPLOAD_BYTES", 1000)
    r = upload(client, data=b"x" * 1001)
    assert r.status_code == 413 and "15 MB" in r.json()["detail"]

    def chunks():  # no Content-Length: the limit applies while streaming
        for _ in range(5):
            yield b"x" * 400

    r = client.post("/v1/numa/voices?name=Me&method=recorded&consent=true", content=chunks())
    assert r.status_code == 413 and models.calls == []


def test_the_voice_of_a_running_conversation_cannot_be_deleted(api):
    client, _, _ = api
    vid = upload(client).json()["voice"]["id"]
    assert voice_models.begin_session(vid)
    try:
        r = client.delete(f"/v1/numa/voices/{vid}")
        assert r.status_code == 409 and "End the conversation" in r.json()["detail"]
    finally:
        voice_models.end_session(vid)
    assert client.delete(f"/v1/numa/voices/{vid}").status_code == 200


def test_generation_is_refused_while_a_session_is_connecting_or_another_generation_runs(api):
    client, models, _ = api
    assert voice_models.begin_session(None)  # registered before upstream reports the pool busy
    try:
        assert client.post("/v1/numa/voices/preview", json={"voice_id": "preset-aiden"}).status_code == 409
    finally:
        voice_models.end_session(None)
    with voice_models.generation():
        r = client.post("/v1/numa/voices/preview", json={"voice_id": "preset-aiden"})
        assert r.status_code == 409 and "Another voice" in r.json()["detail"]
    assert client.post("/v1/numa/voices/preview", json={"voice_id": "preset-aiden"}).status_code == 200


def test_transcription_reuses_the_pipelines_parakeet_model(monkeypatch):
    import contextlib
    import types

    import mlx_audio.stt.utils as stt_utils

    heard = []
    shared = types.SimpleNamespace(generate=lambda path: heard.append(path) or types.SimpleNamespace(text=" Hi. "))
    monkeypatch.setattr(voice_models, "_mlx_lock", lambda name: contextlib.nullcontext())
    monkeypatch.setattr(voice_models, "stt_handler", types.SimpleNamespace(backend="mlx", model=shared))
    monkeypatch.setattr(stt_utils, "load_model", lambda path: pytest.fail("loaded a second Parakeet"))
    assert voice_models.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32)) == "Hi."
    assert len(heard) == 1

    own = types.SimpleNamespace(generate=lambda path: types.SimpleNamespace(text="Own."))
    monkeypatch.setattr(voice_models, "stt_handler", None)  # e.g. outside the server: load one for the request
    monkeypatch.setattr(voice_models, "_release", lambda: None)
    monkeypatch.setattr(stt_utils, "load_model", lambda path: own)
    assert voice_models.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32)) == "Own."
