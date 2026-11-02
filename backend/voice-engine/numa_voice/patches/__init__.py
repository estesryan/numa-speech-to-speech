"""Runtime fixes for speech-to-speech 1.1.0, applied by `numa-voice` before upstream starts.

Nothing inside the virtual environment is edited: each patch replaces one attribute in memory. Before patching,
each one checks the upstream version and the exact upstream code it depends on, and stops the launcher with
`UpstreamIncompatible` if either differs. The compaction fix becomes a no-op once upstream fixes that defect.
NUMA_VOICE_ALLOW_UNTESTED_UPSTREAM=1 skips the version check only; the code checks always run.
"""

from __future__ import annotations

import inspect
import logging
import os
from typing import Any

TESTED_UPSTREAM = "1.1.0"
logger = logging.getLogger("numa_voice.patches")


class UpstreamIncompatible(RuntimeError):
    pass


def check_upstream_version() -> None:
    import speech_to_speech  # not at module import: the CLI sets the offline environment first

    if speech_to_speech.__version__ != TESTED_UPSTREAM and not os.environ.get("NUMA_VOICE_ALLOW_UNTESTED_UPSTREAM"):
        raise UpstreamIncompatible(
            f"speech-to-speech {speech_to_speech.__version__} is installed; Numa's fixes were written for "
            f"{TESTED_UPSTREAM}. Re-validate numa_voice/patches/ before upgrading."
        )


def require(owner: Any, *names: str) -> None:
    """Fail unless `owner` has every attribute in `names`."""
    missing = [n for n in names if not hasattr(owner, n)]
    if missing:
        raise UpstreamIncompatible(f"{getattr(owner, '__name__', owner)} no longer has {missing}; "
                                   "re-validate numa_voice/patches/")


def require_source(func: Any, *needles: str) -> str:
    """Fail unless the source of `func` still contains every snippet the patch relies on; return the source."""
    source = inspect.getsource(func)
    missing = [n for n in needles if n not in source]
    if missing:
        raise UpstreamIncompatible(f"{func.__qualname__} changed upstream (no longer contains {missing}); "
                                   "re-validate numa_voice/patches/")
    return source


def apply_server_patches(realtime: dict[str, Any] | None = None) -> list[str]:
    check_upstream_version()
    from . import compaction, custom_voice, origin, session_persona, voice_studio

    realtime = realtime or {}
    # middleware added last runs first: the Origin check precedes CORS (voice_studio) and persona handling
    return [compaction.apply(), custom_voice.apply(),
            voice_studio.apply(origin.resolve_origins(realtime.get("allowed_origins"))),
            session_persona.apply(), origin.apply(**realtime)]


def apply_client_patches() -> list[str]:
    check_upstream_version()
    from . import audio_client

    return [audio_client.apply()]
