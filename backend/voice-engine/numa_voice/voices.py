"""Voice Studio storage: built-in preset voices and user-created voices, and the Conversation default.

User voices live in `data/voices/<id>/` (outside the engine code and the model weights):

    profile.json     everything needed to synthesize the voice again: model and revision, reference transcript,
                     how it was made (recorded, uploaded, designed), the design description, owner consent
    reference.wav    the conditioning reference (24 kHz mono PCM16) that the Base model clones live

`data/voices/settings.json` holds the Conversation default. Ids are generated (`voice-<12 hex>`); names are display
text only. Every write goes to a temporary file or directory first and is moved into place, so a crash never leaves
a half-written voice. Profiles that fail validation are listed as unavailable instead of breaking the list.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import secrets
import shutil
import tempfile
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from .paths import voices_dir

SCHEMA = 1
SAMPLE_RATE = 24000  # Qwen3-TTS codec rate
CLONE_MODEL = "tts/qwen3-tts-1.7b-base-6bit"
DESIGN_MODEL = "tts/qwen3-tts-1.7b-voicedesign-6bit"
# Conversation's factory default, and its fallback when a saved choice cannot be used. Personas with a fixed voice
# (such as ren-test) never use it.
FALLBACK_VOICE = "preset-serena"
CONVERSATION_DEFAULT = "conversation-default"  # a persona's `voice` that follows the user's choice
METHODS = ("recorded", "uploaded", "designed")
CONSENT_STATEMENT = (
    "I confirm this is my own voice, or that its owner has given me permission to create a synthetic copy of it."
)

# CustomVoice speakers that speak English natively or well; the dialect speakers are left out.
PRESETS = {
    "aiden": ("Aiden", "male"),
    "ryan": ("Ryan", "male"),
    "serena": ("Serena", "female"),
    "vivian": ("Vivian", "female"),
    "sohee": ("Sohee", "female"),
    "ono_anna": ("Ono Anna", "female"),
}

VOICE_ID = re.compile(r"voice-[0-9a-f]{12}")
PRESET_ID = re.compile(r"preset-([a-z_]+)")

MIN_SECONDS, MAX_SECONDS = 3.0, 30.0
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
MIN_RMS_DBFS = -40.0
MAX_CLIPPED = 0.005


class VoiceError(ValueError):
    """A request the store refuses (bad id, name, audio...); the message is shown to the user."""


class VoiceNotFound(VoiceError):
    pass


@dataclass
class Voice:
    id: str
    name: str
    method: str  # preset | recorded | uploaded | designed
    builtin: bool
    created_at: str | None = None
    description: str | None = None
    available: bool = True
    problem: str | None = None
    profile: dict[str, Any] = field(default_factory=dict, repr=False)

    def public(self) -> dict[str, Any]:
        """What the browser may see: no paths, transcripts or consent records."""
        return {k: v for k, v in asdict(self).items() if k != "profile"}


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def valid_name(name: str) -> str:
    name = " ".join(str(name).split())
    if not 1 <= len(name) <= 40 or any(ord(c) < 32 for c in name):
        raise VoiceError("Give the voice a name of 1 to 40 characters.")
    return name


def is_voice_id(voice_id: str) -> bool:
    return bool(VOICE_ID.fullmatch(voice_id) or (PRESET_ID.fullmatch(voice_id) and voice_id[7:] in PRESETS))


# ------------------------------------------------------------------------------------------------- audio
def prepare_reference(data: bytes) -> tuple[np.ndarray, dict[str, Any]]:
    """Decode, check and normalize a reference recording; returns 24 kHz mono float32 and its measurements."""
    import soundfile as sf
    import soxr

    if len(data) > MAX_UPLOAD_BYTES:
        raise VoiceError("The recording is larger than 15 MB. Use a shorter clip (up to 30 seconds).")
    try:
        audio, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception:
        raise VoiceError("This file could not be decoded as audio. Use WAV, FLAC or OGG.") from None
    if rate < 16000:
        raise VoiceError(f"The sample rate ({rate} Hz) is too low; record at 16 kHz or more.")
    audio = audio.mean(axis=1)
    clipped = float(np.mean(np.abs(audio) >= 0.999)) if audio.size else 0.0
    # trim leading and trailing silence (below -45 dBFS in 20 ms frames)
    frame = int(rate * 0.02)
    frames = audio[: len(audio) // frame * frame].reshape(-1, frame) if len(audio) >= frame else audio[None, :]
    loud = np.flatnonzero(np.sqrt(np.mean(frames**2, axis=1)) > 10 ** (-45 / 20))
    if loud.size:
        audio = audio[max(0, loud[0] - 5) * frame : min(len(frames), loud[-1] + 6) * frame]
    duration = len(audio) / rate
    rms = float(np.sqrt(np.mean(audio**2))) if audio.size else 0.0
    rms_db = 20 * np.log10(rms) if rms > 0 else -120.0
    if duration < MIN_SECONDS:
        raise VoiceError(f"The recording has {duration:.1f} s of speech; at least {MIN_SECONDS:.0f} s is needed.")
    if duration > MAX_SECONDS:
        raise VoiceError(f"The recording is {duration:.0f} s long; use at most {MAX_SECONDS:.0f} s.")
    if rms_db < MIN_RMS_DBFS:
        raise VoiceError("The recording is too quiet. Move closer to the microphone and try again.")
    if clipped > MAX_CLIPPED:
        raise VoiceError("The recording is distorted (clipping). Move back from the microphone and try again.")
    if rate != SAMPLE_RATE:
        audio = soxr.resample(audio, rate, SAMPLE_RATE)
    peak = float(np.max(np.abs(audio)))
    if peak > 0:
        audio = audio * min(4.0, 0.89 / peak)  # about -1 dBFS peak, never boosting noise more than 12 dB
    return audio.astype(np.float32), {"duration_s": round(duration, 2), "rms_dbfs": round(rms_db, 1)}


def wav_bytes(audio: np.ndarray, rate: int = SAMPLE_RATE) -> bytes:
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, np.clip(audio, -1, 1), rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


# ------------------------------------------------------------------------------------------------- store
class VoiceStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or voices_dir()

    # -- reading
    def _preset(self, key: str) -> Voice:
        name, gender = PRESETS[key]
        return Voice(id=f"preset-{key}", name=name, method="preset", builtin=True,
                     description=f"Built-in {gender} voice", profile={"speaker": key})

    def _load(self, voice_id: str) -> Voice:
        directory = self.root / voice_id
        try:
            profile = json.loads((directory / "profile.json").read_text())
            if profile.get("schema") != SCHEMA or profile.get("id") != voice_id:
                raise ValueError("unknown profile format")
            if profile.get("method") not in METHODS:
                raise ValueError("unknown creation method")
            synthesis = profile["synthesis"]
            reference = directory / synthesis["reference_audio"]
            if reference.parent != directory or not reference.is_file():
                raise ValueError("reference audio is missing")
            if hashlib.sha256(reference.read_bytes()).hexdigest() != profile["reference"]["sha256"]:
                raise ValueError("reference audio was changed or damaged")
            if not str(synthesis.get("reference_text", "")).strip():
                raise ValueError("reference transcript is missing")
            return Voice(id=voice_id, name=valid_name(profile["name"]), method=profile["method"], builtin=False,
                         created_at=profile.get("created_at"), description=(profile.get("design") or {}).get("description"),
                         profile=profile)
        except (OSError, ValueError, KeyError, TypeError) as error:
            return Voice(id=voice_id, name=voice_id, method="unknown", builtin=False, available=False,
                         problem=f"This voice's files are damaged or incomplete ({error}).")

    def list(self) -> list[Voice]:
        custom = []
        if self.root.is_dir():
            for d in sorted(self.root.iterdir()):
                if d.is_dir() and VOICE_ID.fullmatch(d.name):
                    custom.append(self._load(d.name))
        custom.sort(key=lambda v: v.created_at or "")
        return [self._preset(k) for k in PRESETS] + custom

    def get(self, voice_id: str) -> Voice:
        if not is_voice_id(voice_id):
            raise VoiceNotFound("Unknown voice.")
        if voice_id.startswith("preset-"):
            return self._preset(voice_id[7:])
        if not (self.root / voice_id).is_dir():
            raise VoiceNotFound("Unknown voice.")
        return self._load(voice_id)

    def reference(self, voice: Voice) -> tuple[Path, str]:
        """The reference audio and its transcript for a usable user voice."""
        if voice.builtin or not voice.available:
            raise VoiceError("This voice has no usable reference.")
        synthesis = voice.profile["synthesis"]
        return self.root / voice.id / synthesis["reference_audio"], synthesis["reference_text"]

    # -- the Conversation default
    def _settings(self) -> dict[str, Any]:
        try:
            data = json.loads((self.root / "settings.json").read_text())
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def default_id(self) -> str:
        chosen = self._settings().get("conversation_default")
        return chosen if isinstance(chosen, str) and is_voice_id(chosen) else FALLBACK_VOICE

    def resolve_default(self) -> tuple[Voice, str | None]:
        """The Conversation voice to use now, and why the fallback was used instead (None if it was not)."""
        try:
            voice = self.get(self.default_id())
        except VoiceNotFound:
            return self.get(FALLBACK_VOICE), "the selected voice no longer exists"
        if not voice.available:
            return self.get(FALLBACK_VOICE), voice.problem
        return voice, None

    def set_default(self, voice_id: str) -> Voice:
        voice = self.get(voice_id)
        if not voice.available:
            raise VoiceError(voice.problem or "This voice is unavailable.")
        settings = {**self._settings(), "conversation_default": voice.id, "updated_at": _now()}
        _atomic_write(self.root / "settings.json", json.dumps(settings, indent=1).encode())
        return voice

    # -- changes
    def create(self, *, name: str, method: str, audio: np.ndarray, reference_text: str, revision: str,
               consent: bool = False, design: dict[str, Any] | None = None) -> Voice:
        name = valid_name(name)
        if method not in METHODS:
            raise VoiceError("Unknown creation method.")
        if method in ("recorded", "uploaded") and consent is not True:
            raise VoiceError("Confirm that you own this voice or have its owner's permission.")
        if not reference_text.strip():
            raise VoiceError("No speech was recognized in the recording.")
        voice_id = f"voice-{secrets.token_hex(6)}"
        reference = wav_bytes(audio)
        profile = {
            "schema": SCHEMA,
            "id": voice_id,
            "name": name,
            "method": method,
            "created_at": _now(),
            "synthesis": {
                "model": CLONE_MODEL,
                "revision": revision,
                "mode": "clone",
                "reference_audio": "reference.wav",
                "reference_text": reference_text.strip(),
                "language": "auto",
            },
            "reference": {"sample_rate": SAMPLE_RATE, "duration_s": round(len(audio) / SAMPLE_RATE, 2),
                          "sha256": hashlib.sha256(reference).hexdigest()},
        }
        if design:
            profile["design"] = design
        if method in ("recorded", "uploaded"):
            profile["consent"] = {"confirmed": True, "statement": CONSENT_STATEMENT, "confirmed_at": _now()}
        self.root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(dir=self.root, prefix=".new-"))
        try:
            (staging / "reference.wav").write_bytes(reference)
            (staging / "profile.json").write_text(json.dumps(profile, indent=1))
            for f in staging.iterdir():
                with open(f, "rb") as fh:
                    os.fsync(fh.fileno())
            os.rename(staging, self.root / voice_id)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        return self.get(voice_id)

    def _editable(self, voice_id: str) -> Voice:
        voice = self.get(voice_id)
        if voice.builtin:
            raise VoiceError("Built-in voices cannot be changed.")
        return voice

    def rename(self, voice_id: str, name: str) -> Voice:
        voice = self._editable(voice_id)
        if not voice.available:
            raise VoiceError(voice.problem or "This voice is unavailable.")
        profile = {**voice.profile, "name": valid_name(name)}
        _atomic_write(self.root / voice_id / "profile.json", json.dumps(profile, indent=1).encode())
        return self.get(voice_id)

    def delete(self, voice_id: str) -> str:
        """Remove the voice and all its private files; returns the Conversation default afterwards."""
        self._editable(voice_id)
        trash = self.root / f".deleted-{voice_id}-{secrets.token_hex(3)}"
        os.rename(self.root / voice_id, trash)  # atomic: the voice is gone even if removal below is interrupted
        shutil.rmtree(trash, ignore_errors=True)
        if self._settings().get("conversation_default") == voice_id:
            self.set_default(FALLBACK_VOICE)
        return self.default_id()

    def cleanup(self, older_than_s: float = 3600) -> None:
        """Remove leftovers of interrupted writes and deletions; recent ones may still be in progress."""
        if self.root.is_dir():
            cutoff = time.time() - older_than_s
            for d in self.root.iterdir():
                if d.is_dir() and d.name.startswith((".new-", ".deleted-")) and d.stat().st_mtime < cutoff:
                    shutil.rmtree(d, ignore_errors=True)
