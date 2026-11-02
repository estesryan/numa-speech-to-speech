"""Live speech in Voice Studio voices (upstream speech-to-speech 1.1.0, Qwen3-TTS on MLX).

Upstream loads one TTS model per pipeline: here the CustomVoice model, whose preset speakers (Aiden for the
test persona) are selected per session through `audio.output.voice`. Its voice-clone path needs a Base model and
takes any audio file path a client names, so it is not used. Instead:

- A session voice of the form `numa-voice:<id>` (set only by the server, patches/session_persona.py) selects a
  saved user voice. Its utterances are cloned by the Base model (voice_models.base_model) from the voice's own
  reference audio and transcript, through upstream's own MLX streaming path, so streaming, cancellation and the
  MLX lock behave as for presets.
- Any other session voice goes to upstream unchanged.

The handler also registers itself so Voice Studio previews reuse its CustomVoice weights.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from typing import Any

from speech_to_speech.TTS import qwen3_tts_handler as qt

from .. import voice_models
from ..voices import VoiceStore
from . import require, require_source

logger = logging.getLogger("numa_voice.custom_voice")
TOKEN = "numa-voice:"

Handler = qt.Qwen3TTSHandler
require(Handler, "setup", "_apply_session_voice_override", "_process_custom_voice", "_stream_mlx_generation",
        "_estimate_max_new_tokens", "on_session_end")
require_source(Handler.process, "self._apply_session_voice_override(model_type, runtime_config, response)",
               'elif model_type == "custom_voice":', "self._process_custom_voice(text, request_language)")
require_source(Handler._apply_session_voice_override, "response.audio.output.voice", "runtime_config.session.audio")
require_source(Handler._stream_mlx_generation, "MLXLockContext", "generation_fn(")
_ORIGINAL = {name: getattr(Handler, name) for name in
             ("setup", "_apply_session_voice_override", "_process_custom_voice", "on_session_end")}


def _session_voice(runtime_config: Any, response: Any) -> str | None:
    """The session's requested voice, read the way upstream reads it (the response overrides the session)."""
    for holder in (response, getattr(runtime_config, "session", None)):
        output = getattr(getattr(holder, "audio", None), "output", None)
        voice = getattr(output, "voice", None)
        if voice:
            return str(voice)
    return None


def setup(self, *args: Any, **kwargs: Any) -> None:
    _ORIGINAL["setup"](self, *args, **kwargs)
    self._numa_voice = None
    voice_models.preset_handler = self


def _apply_session_voice_override(self, model_type: str, runtime_config: Any = None, response: Any = None) -> None:
    requested = _session_voice(runtime_config, response)
    if requested and requested.startswith(TOKEN):
        voice_id = requested[len(TOKEN):]
        current = getattr(self, "_numa_voice", None)
        if current is not None and current[0] == voice_id:
            return  # already loaded for this session; keeps working even if the voice is deleted meanwhile
        try:
            store = VoiceStore()
            voice = store.get(voice_id)  # validated id; the session also checked it when it connected
            self._numa_voice = (voice_id, voice_models.clone_kwargs(store, voice))
            logger.info("Speaking in Voice Studio voice %s (%s)", voice_id, voice.method)
        except Exception as error:  # never fall back to another voice silently: say nothing, and log why
            logger.error("Voice Studio voice %s cannot be used: %s", voice_id, error)
            self._numa_voice = (voice_id, None)
        return
    self._numa_voice = None
    _ORIGINAL["_apply_session_voice_override"](self, model_type, runtime_config, response)


def _process_custom_voice(self, text: str, language: str | None = None) -> Iterator[Any]:
    selected = getattr(self, "_numa_voice", None)
    if selected is None or self.backend != "mlx":
        yield from _ORIGINAL["_process_custom_voice"](self, text, language)
        return
    voice_id, conditioning = selected
    if conditioning is None:
        return
    model = voice_models.base_model()
    yield from self._stream_mlx_generation(
        model.generate,
        label="numa_voice_clone_mlx",
        max_tokens=self._estimate_max_new_tokens(text),
        text=text,
        **{**conditioning, "lang_code": language or conditioning["lang_code"]},
    )


def on_session_end(self) -> None:
    self._numa_voice = None
    _ORIGINAL["on_session_end"](self)


def apply() -> str:
    Handler.setup = setup
    Handler._apply_session_voice_override = _apply_session_voice_override
    Handler._process_custom_voice = _process_custom_voice
    Handler.on_session_end = on_session_end
    return "custom voice: sessions can speak in saved Voice Studio voices (cloned by the Qwen3-TTS Base model)"
