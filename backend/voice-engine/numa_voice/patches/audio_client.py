"""Hook Numa's interruption fix into upstream's standalone audio client (`local` and `talk` commands).

Two classes in `speech_to_speech.api.openai_realtime.audio_client` are replaced with subclasses:

- PlaybackBuffer: additionally counts bytes handed to the speaker and bytes dropped on interruption, so the
  position of a reply's audio that was actually played is known exactly.
- _ToolCallCoordinator: upstream already calls it with every server event, before its own event handler clears
  the playback buffer on barge-in, and it holds the connection. The subclass also feeds events to
  `InterruptionHistory` and sends the events it returns.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import Any

from speech_to_speech.api.openai_realtime import audio_client as ac

from ..interruption import InterruptionHistory
from . import UpstreamIncompatible, require, require_source

logger = logging.getLogger("numa_voice.interruption")


def _check_upstream() -> None:
    """The subclasses below rely on these upstream internals and on the order of `_run_audio_session`."""
    require(ac, "PlaybackBuffer", "_ToolCallCoordinator", "_run_audio_session")
    require(ac.PlaybackBuffer, "append", "write", "clear")
    require(ac._ToolCallCoordinator, "handle_event")
    require_source(ac.PlaybackBuffer.__init__, "self.recv_rate = recv_rate", "self._audio = bytearray()",
                   "self._lock = Lock()")
    require_source(ac._ToolCallCoordinator.__init__, "self._conn = conn")
    session = require_source(ac._run_audio_session, "playback = PlaybackBuffer(", "_ToolCallCoordinator(conn, config)",
                             "tool_calls.handle_event(event)", "handle_server_event(")
    # the buffer must be created right before the coordinator, and the coordinator must see each event first
    if not (session.index("playback = PlaybackBuffer(") < session.index("_ToolCallCoordinator(conn, config)")
            and session.index("tool_calls.handle_event(event)") < session.index("handle_server_event(")):
        raise UpstreamIncompatible("_run_audio_session changed order upstream; re-validate numa_voice/patches/")


_check_upstream()
_ORIGINAL_BUFFER = ac.PlaybackBuffer
_ORIGINAL_COORDINATOR = ac._ToolCallCoordinator
_LATEST_BUFFER: TrackingPlaybackBuffer | None = None


class TrackingPlaybackBuffer(_ORIGINAL_BUFFER):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        global _LATEST_BUFFER
        super().__init__(*args, **kwargs)
        self.appended_bytes = 0  # every byte ever appended
        self.consumed_bytes = 0  # every byte that left the buffer: played, or dropped by clear()
        _LATEST_BUFFER = self

    def append(self, audio: bytes) -> None:
        super().append(audio)
        self.appended_bytes += len(audio)

    def write(self, outdata: Any) -> None:
        with self._lock:
            before = len(self._audio)
        super().write(outdata)
        with self._lock:
            after = len(self._audio)
        self.consumed_bytes += max(0, before - after)

    def clear(self) -> None:
        with self._lock:
            dropped = len(self._audio)
        super().clear()
        self.consumed_bytes += dropped


class InterruptionAwareCoordinator(_ORIGINAL_COORDINATOR):
    def __init__(self, conn: Any, config: Any) -> None:
        super().__init__(conn, config)
        self._history = InterruptionHistory(sample_rate=config.recv_rate)
        self._playback = _LATEST_BUFFER  # created by upstream immediately before this coordinator
        self._reply_start: dict[str, int] = {}  # response id -> appended-byte offset of its first audio
        self._reply_bytes: dict[str, int] = {}

    def _played_s(self, rid: str) -> float:
        if self._playback is None or rid not in self._reply_start:
            return 0.0
        played = self._playback.consumed_bytes - self._reply_start[rid]
        return max(0, min(played, self._reply_bytes.get(rid, 0))) / 2 / self._playback.recv_rate

    def handle_event(self, event: Any) -> None:
        super().handle_event(event)
        data = event.model_dump() if hasattr(event, "model_dump") else dict(event)
        if data.get("type") == "response.output_audio.delta" and self._playback is not None:
            rid = data.get("response_id")
            # this runs before upstream appends the chunk, so appended_bytes is the chunk's start offset
            self._reply_start.setdefault(rid, self._playback.appended_bytes)
            self._reply_bytes[rid] = self._reply_bytes.get(rid, 0) + len(base64.b64decode(data.get("delta", "")))
        outgoing = self._history.observe(data, self._played_s)
        if outgoing:
            logger.info("Interruption: removing the unheard reply and noting what the user heard")
            asyncio.get_running_loop().create_task(self._send(outgoing))

    async def _send(self, events: list[dict]) -> None:
        for e in events:
            await self._conn.send(e)


def apply() -> str:
    ac.PlaybackBuffer = TrackingPlaybackBuffer
    ac._ToolCallCoordinator = InterruptionAwareCoordinator
    return "interruption: audio client notes what the user heard when they interrupt the assistant"
