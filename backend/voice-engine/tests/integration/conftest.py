"""A real voice engine for integration tests: `numa-voice serve --profile fast --persona ren-test`, offline.

Its saved voices are a temporary directory, never the user's data/voices.
Set NUMA_VOICE_TEST_URL to use an already running server instead (log-based assertions are then skipped).

Test speech is generated for each run (`speech_clips`): no recordings are committed.
"""

import io
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ENGINE_DIR / "bench"))
sys.path.insert(0, str(ENGINE_DIR / "tests"))


class Engine:
    def __init__(self, url: str, log: Path | None, voices: Path | None = None) -> None:
        self.url, self.log, self.voices = url, log, voices

    def log_since(self, offset: int) -> str:
        if self.log is None:
            pytest.skip("external server: no log to inspect")
        return self.log.read_text(errors="replace")[offset:]

    def log_offset(self) -> int:
        return len(self.log.read_text(errors="replace")) if self.log else 0


@pytest.fixture(scope="session")
def engine(tmp_path_factory):
    if os.environ.get("NUMA_VOICE_TEST_URL"):
        yield Engine(os.environ["NUMA_VOICE_TEST_URL"], None)
        return
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", 8765)) == 0:
            pytest.fail("port 8765 is busy: stop the running voice engine or set NUMA_VOICE_TEST_URL")
    log = tmp_path_factory.mktemp("engine") / "serve.log"
    # ren-test: the fixtures address the assistant as "Ren", and its prompt stays fixed between runs
    voices = tmp_path_factory.mktemp("voices")  # never the user's data/voices
    proc = subprocess.Popen([str(ENGINE_DIR / ".venv/bin/numa-voice"), "serve", "--profile", "fast", "--persona", "ren-test"],
                            cwd=ENGINE_DIR, stdout=open(log, "w"), stderr=subprocess.STDOUT,
                            env={**os.environ, "NUMA_VOICES_DIR": str(voices)})
    deadline = time.time() + 180
    while "Uvicorn running" not in log.read_text(errors="replace"):
        if proc.poll() is not None or time.time() > deadline:
            proc.kill()
            pytest.fail(f"voice engine did not start:\n{log.read_text(errors='replace')[-3000:]}")
        time.sleep(0.5)
    yield Engine("ws://127.0.0.1:8765/v1/realtime", log, voices)
    proc.terminate()
    proc.wait(30)


LINES = ENGINE_DIR / "tests" / "fixtures" / "interrupt" / "manifest.json"


def _preview(base: str, voice: str, text: str, timeout_s: float = 120.0) -> bytes:
    """Speech from the engine's Voice Studio preview; waits while an earlier session is still being released."""
    deadline = time.monotonic() + timeout_s
    while True:
        request = Request(f"{base}/v1/numa/voices/preview", data=json.dumps({"voice_id": voice, "text": text}).encode(),
                          method="POST", headers={"content-type": "application/json"})
        try:
            with urlopen(request, timeout=300) as response:
                return response.read()
        except HTTPError as error:
            if error.code != 409 or time.monotonic() > deadline:
                raise
            time.sleep(0.5)


@pytest.fixture(scope="session")
def speech_clips(engine, tmp_path_factory):
    """The user's lines from fixtures/interrupt/manifest.json, spoken by one of the engine's built-in voices and saved
    as 16 kHz mono WAVs in a temporary directory: {name: {"file", "text", "duration_s"}}. Nothing is committed."""
    import soundfile as sf
    import soxr

    script = json.loads(LINES.read_text())
    rate, out = script["rate"], tmp_path_factory.mktemp("speech")
    base = engine.url.replace("ws://", "http://").split("/v1/")[0]
    clips = {}
    for name, line in script["lines"].items():
        audio, source_rate = sf.read(io.BytesIO(_preview(base, script["voice"], line["text"])), dtype="float32")
        audio = soxr.resample(audio, source_rate, rate)
        path = out / f"{name}.wav"
        sf.write(path, audio, rate, subtype="PCM_16")
        clips[name] = {"file": str(path), "text": line["text"], "duration_s": round(len(audio) / rate, 2)}
    return clips
