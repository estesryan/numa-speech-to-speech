"""The models Voice Studio uses, inside the voice-engine process.

- Presets use the pipeline's own CustomVoice model (the TTS handler registers itself here at setup), so previews
  and live speech share one copy of the weights.
- User voices are cloned live by the Base model, loaded on first use and then kept: it serves every turn of a
  Conversation that uses a custom voice.
- VoiceDesign (creating a voice from a description) and Parakeet (transcribing a new reference) are only needed
  while a voice is being created: they are loaded for that request and released afterwards.

All generation holds upstream's process-wide MLX lock, so a preview never runs at the same time as live speech.
"""

from __future__ import annotations

import gc
import logging
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import numpy as np

from .manifest import load_manifest, verify
from .paths import models_root
from .voices import CLONE_MODEL, DESIGN_MODEL, SAMPLE_RATE, Voice, VoiceError, VoiceStore, wav_bytes

logger = logging.getLogger("numa_voice.voice_models")
STT_MODEL = "stt/parakeet-tdt-0.6b-v3"

# Read by the designed voice; it becomes the voice's reference, so it is neutral and phonetically varied.
DESIGN_TEXT = (
    "Hello, it's lovely to meet you. I'm here whenever you'd like to talk, about something big or something "
    "small. Take your time, and let's see where the conversation takes us."
)

_lock = threading.Lock()
_base: Any = None
preset_handler: Any = None  # the pipeline's Qwen3TTSHandler; set by patches/custom_voice.py
stt_handler: Any = None  # the pipeline's Parakeet handler; set by patches/voice_studio.py


class ModelUnavailable(VoiceError):
    pass


class EngineBusy(VoiceError):
    """A conversation and Voice Studio generation cannot run at the same time."""


# Conversations and Voice Studio generation exclude each other: they share the GPU, and generation can hold the
# MLX lock for longer than live speech can wait. Sessions register here before upstream claims a slot.
_activity = threading.Lock()
_session_voices: list[str | None] = []
_generating = False


def begin_session(voice_id: str | None) -> bool:
    """Register a conversation speaking in `voice_id`; False while Voice Studio is generating."""
    with _activity:
        if _generating:
            return False
        _session_voices.append(voice_id)
        return True


def end_session(voice_id: str | None) -> None:
    with _activity:
        _session_voices.remove(voice_id)


def voice_in_use(voice_id: str) -> bool:
    with _activity:
        return voice_id in _session_voices


@contextmanager
def generation() -> Iterator[None]:
    """Hold for the duration of any Voice Studio generation; refuses while a conversation or generation runs."""
    global _generating
    with _activity:
        if _session_voices:
            raise EngineBusy("End the conversation first: voices are generated with the same model.")
        if _generating:
            raise EngineBusy("Another voice is being generated. Try again when it has finished.")
        _generating = True
    try:
        yield
    finally:
        with _activity:
            _generating = False


def model_path(model_id: str) -> Path:
    return load_manifest()[model_id].directory(models_root())


def revision(model_id: str) -> str:
    return str(load_manifest()[model_id].source.get("revision", ""))


def capabilities() -> dict[str, dict[str, Any]]:
    """Which creation methods work here, with the reason when one does not (shown in the UI as is)."""
    manifest = load_manifest()

    def present(model_id: str) -> str | None:
        problems = verify(manifest[model_id], models_root(), deep=False) if manifest[model_id].files else ["missing"]
        if problems:
            return f"needs {model_id}: run `uv run numa-voice models download --ids {model_id}`"
        return None

    clone, design = present(CLONE_MODEL), present(DESIGN_MODEL)
    return {
        "presets": {"available": True, "reason": None},
        "clone": {"available": clone is None, "reason": clone},
        "design": {"available": clone is None and design is None, "reason": design or clone},
    }


def _mlx_lock(name: str):
    from speech_to_speech.utils.mlx_lock import MLXLockContext

    return MLXLockContext(handler_name=name, timeout=60.0)


def _load(model_id: str) -> Any:
    from mlx_audio.tts.utils import load_model

    path = model_path(model_id)
    if not path.is_dir():
        raise ModelUnavailable(f"The model {model_id} is not installed.")
    logger.info("Loading %s from %s", model_id, path)
    return load_model(str(path))


def base_model() -> Any:
    global _base
    with _lock:
        if _base is None:
            if not capabilities()["clone"]["available"]:
                raise ModelUnavailable("Custom voices need the Qwen3-TTS Base model, which is not installed.")
            _base = _load(CLONE_MODEL)
        return _base


def warm_base_model() -> None:
    """Load the Base model in the background for a session that will speak in a saved voice.

    The model would be loaded on the session's first reply anyway; starting at connect hides the load behind the
    user's first turn. It uses no extra memory: the model stays loaded after first use either way.
    """

    def load() -> None:
        try:
            base_model()
        except Exception as error:  # the first reply reports the problem through the normal path
            logger.warning("Could not preload the Qwen3-TTS Base model: %s", error)

    if _base is None:
        threading.Thread(target=load, name="numa-base-preload", daemon=True).start()


def _release() -> None:
    import mlx.core as mx

    gc.collect()
    mx.clear_cache()


@contextmanager
def design_model() -> Iterator[Any]:
    if not capabilities()["design"]["available"]:
        raise ModelUnavailable("Designing voices needs the Qwen3-TTS VoiceDesign model, which is not installed.")
    model = _load(DESIGN_MODEL)
    try:
        yield model
    finally:
        del model
        _release()


def _collect(results: Any) -> np.ndarray:
    chunks = [np.array(r.audio, dtype=np.float32).reshape(-1) for r in results]
    audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    if audio.size == 0 or not np.isfinite(audio).all():
        raise VoiceError("The model produced no usable audio.")
    return audio


def clone_kwargs(store: VoiceStore, voice: Voice) -> dict[str, Any]:
    """The Base model's conditioning for a user voice, with the reference loaded into memory once."""
    import mlx.core as mx
    import soundfile as sf

    reference, text = store.reference(voice)
    audio, rate = sf.read(reference, dtype="float32")
    if rate != SAMPLE_RATE or audio.ndim != 1:
        raise VoiceError("This voice's reference audio has an unexpected format.")
    return {"ref_audio": mx.array(audio), "ref_text": text, "lang_code": "auto"}


def synthesize(store: VoiceStore, voice: Voice, text: str) -> np.ndarray:
    """Speech in `voice`, from the same model and conditioning live conversations use."""
    if not voice.available:
        raise VoiceError(voice.problem or "This voice is unavailable.")
    if voice.builtin:
        if preset_handler is None:
            raise ModelUnavailable("The voice engine's speech model is not ready yet.")
        with _mlx_lock("VoiceStudio-preview"):
            return _collect(preset_handler.model.generate_custom_voice(
                text=text, speaker=voice.profile["speaker"], language="auto", verbose=False))
    model = base_model()
    with _mlx_lock("VoiceStudio-preview"):
        return _collect(model.generate(text=text, verbose=False, **clone_kwargs(store, voice)))


def synthesize_reference(reference: np.ndarray, reference_text: str, text: str) -> np.ndarray:
    """Speech cloned from an unsaved reference (a design candidate), exactly as it would sound once saved."""
    import mlx.core as mx

    model = base_model()
    with _mlx_lock("VoiceStudio-preview"):
        return _collect(model.generate(text=text, ref_audio=mx.array(reference), ref_text=reference_text,
                                       lang_code="auto", verbose=False))


def design_candidates(description: str, count: int) -> tuple[list[np.ndarray], str]:
    """`count` different voices matching `description`, each reading DESIGN_TEXT."""
    clips = []
    with design_model() as model, _mlx_lock("VoiceStudio-design"):
        for _ in range(count):
            clips.append(_collect(model.generate(text=DESIGN_TEXT, instruct=description, lang_code="auto",
                                                 verbose=False)))
            _release()  # free each candidate's working memory before the next
    return clips, DESIGN_TEXT


def transcribe(audio: np.ndarray) -> str:
    """What is said in a new reference recording (it conditions the clone together with the audio).

    Reuses the conversation pipeline's Parakeet model when it is loaded (MLX backend); otherwise loads one for this
    request and releases it afterwards.
    """
    import soxr
    from mlx_audio.stt.utils import load_model

    shared = getattr(stt_handler, "model", None) if getattr(stt_handler, "backend", None) == "mlx" else None
    model = shared if shared is not None else load_model(str(model_path(STT_MODEL)))
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav") as f, _mlx_lock("VoiceStudio-transcribe"):
            f.write(wav_bytes(soxr.resample(audio, SAMPLE_RATE, 16000), 16000))
            f.flush()
            return str(model.generate(f.name).text).strip()
    finally:
        if shared is None:
            del model
            _release()
