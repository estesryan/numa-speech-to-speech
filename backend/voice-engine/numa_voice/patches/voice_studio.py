"""Serve the Voice Studio API (numa_voice/voice_api.py) from the Realtime server's own app.

The browser calls it cross-origin (localhost:3000 -> 127.0.0.1:8765), so CORS headers are added for the same
origins the Origin allowlist admits (patches/origin.py rejects every other origin before this runs). Whether a
conversation is live comes from upstream's pipeline pool: a unit with a session is in use.

The pipeline's Parakeet handler registers itself so Voice Studio transcribes new references with the model the
conversation already holds instead of loading a second copy.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from fastapi.middleware.cors import CORSMiddleware
from speech_to_speech.api.openai_realtime import server
from speech_to_speech.STT import parakeet_tdt_handler as pt

from .. import voice_api, voice_models
from . import require, require_source

require(server, "create_app")
require_source(server.RealtimeServer.run, "create_app(pool=self.pool")
require(pt.ParakeetTDTSTTHandler, "setup")
require_source(pt.ParakeetTDTSTTHandler._setup_mlx, 'self.backend = "mlx"', "self.model = load_model(model_name)")
_ORIGINAL_STT_SETUP = pt.ParakeetTDTSTTHandler.setup


def _stt_setup(self: Any, *args: Any, **kwargs: Any) -> None:
    _ORIGINAL_STT_SETUP(self, *args, **kwargs)
    voice_models.stt_handler = self


def apply(allowed_origins: Iterable[str]) -> str:
    previous = server.create_app
    origins = list(allowed_origins)

    def create_app(*args: Any, **kwargs: Any) -> Any:
        app = previous(*args, **kwargs)
        pool = kwargs.get("pool", args[0] if args else [])

        def busy() -> bool:
            return any(getattr(unit, "session", None) is not None for unit in pool)

        app.include_router(voice_api.router(busy))
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                           allow_headers=["content-type"])
        return app

    server.create_app = create_app
    pt.ParakeetTDTSTTHandler.setup = _stt_setup
    return "voice studio: /v1/numa/voices API for saved voices, previews and voice creation"
