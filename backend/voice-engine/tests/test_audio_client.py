"""The audio-client patch: playback accounting (TrackingPlaybackBuffer) and the coordinator that turns it into
interruption notes (InterruptionAwareCoordinator), driven with real Realtime event types."""

import asyncio
import base64
import json
from pathlib import Path

import pytest
from openai.types.realtime import RealtimeServerEvent
from pydantic import TypeAdapter
from speech_to_speech.api.openai_realtime import audio_client as ac

from numa_voice.patches.audio_client import InterruptionAwareCoordinator, TrackingPlaybackBuffer

RATE = 16000
TRACES = sorted((Path(__file__).parent / "fixtures" / "traces").glob("*.json"))
_EVENTS = TypeAdapter(RealtimeServerEvent)


def pcm(seconds: float) -> bytes:
    return b"\x00\x00" * round(RATE * seconds)


def play(buffer: TrackingPlaybackBuffer, seconds: float, chunk: int = 2048) -> None:
    """Pull audio the way the sounddevice output callback does."""
    remaining = round(RATE * seconds) * 2
    while remaining > 0:
        out = bytearray(min(chunk, remaining))
        buffer.write(out)
        remaining -= len(out)


def server_event(spec: dict):
    """A parsed server event from a trace step, with protocol fields the traces leave out."""
    e = {"event_id": "evt", **spec}
    kind = e["type"]
    if kind == "response.output_audio.delta":
        e["delta"] = base64.b64encode(pcm(e.pop("seconds"))).decode()
    if kind.startswith(("response.output_audio", "response.output_audio_transcript")):
        e = {"item_id": "item", "output_index": 0, "content_index": 0, **e}
    if kind == "response.output_item.added":
        e = {"output_index": 0, **e, "item": {"type": "message", "role": "assistant", "content": [], **e["item"]}}
    if kind == "input_audio_buffer.speech_started":
        e = {"audio_start_ms": 0, "item_id": "user_item", **e}
    return _EVENTS.validate_python(e)


class Conn:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, event: dict) -> None:
        self.sent.append(event)


class Client:
    """Coordinator and buffer as upstream's `_run_audio_session` wires them: the buffer is created first, the
    coordinator sees each event before `handle_server_event` changes the buffer (checked in the patch)."""

    def __init__(self) -> None:
        self.buffer = TrackingPlaybackBuffer(RATE)
        self.conn = Conn()
        self.coordinator = InterruptionAwareCoordinator(self.conn, ac.RealtimeAudioClientConfig(recv_rate=RATE))

    async def receive(self, spec: dict) -> None:
        event = server_event(spec)
        self.coordinator.handle_event(event)
        # what upstream's handle_server_event does to the playback buffer for these events
        if event.type == "response.output_audio.delta":
            self.buffer.append(base64.b64decode(event.delta))
        elif event.type == "response.output_audio.done":
            self.buffer.finish()
        elif event.type == "input_audio_buffer.speech_started":
            self.buffer.clear()
        elif event.type == "response.done":
            self.buffer.clear() if event.response.status == "cancelled" else self.buffer.finish()
        await asyncio.sleep(0)  # let the coordinator's send task run

    async def replay(self, steps: list[dict]) -> list[dict]:
        for step in steps:
            if "play_s" in step:
                play(self.buffer, step["play_s"])
            else:
                await self.receive(step["event"])
        await asyncio.sleep(0)
        return self.conn.sent


# ------------------------------------------------------------------------------------------ playback accounting
def test_written_audio_counts_as_consumed():
    b = TrackingPlaybackBuffer(RATE)
    b.append(pcm(3.0))
    play(b, 1.0)
    assert (b.appended_bytes, b.consumed_bytes) == (len(pcm(3.0)), len(pcm(1.0)))


def test_silence_written_while_empty_is_not_counted():
    b = TrackingPlaybackBuffer(RATE)
    b.append(pcm(0.5))
    play(b, 2.0)  # 1.5 s of padding after the audio runs out
    assert b.consumed_bytes == len(pcm(0.5))


def test_clearing_queued_audio_accounts_for_the_dropped_bytes():
    b = TrackingPlaybackBuffer(RATE)
    b.append(pcm(3.0))
    play(b, 1.0)
    b.clear()
    assert b.consumed_bytes == b.appended_bytes  # the next reply starts at a clean offset
    b.append(pcm(2.0))
    play(b, 0.5)
    assert b.consumed_bytes - len(pcm(3.0)) == len(pcm(0.5))


def run(coro):
    return asyncio.run(coro)


async def replay(steps: list[dict]) -> list[dict]:
    return await Client().replay(steps)  # the coordinator needs a running event loop when it is created


def test_played_position_is_per_reply_and_capped_at_its_length():
    async def scenario():
        c = Client()
        await c.replay([{"event": {"type": "response.created", "response": {"id": "r1"}}},
                        {"event": {"type": "response.output_audio.delta", "response_id": "r1", "seconds": 2.0}},
                        {"play_s": 1.25}])
        mid = c.coordinator._played_s("r1")
        await c.replay([{"event": {"type": "response.created", "response": {"id": "r2"}}},
                        {"event": {"type": "response.output_audio.delta", "response_id": "r2", "seconds": 3.0}},
                        {"play_s": 2.0}])  # finishes r1 (0.75 s), then 1.25 s of r2
        return mid, c.coordinator._played_s("r1"), c.coordinator._played_s("r2"), c.coordinator._played_s("unknown")

    assert run(scenario()) == (1.25, 2.0, 1.25, 0.0)


def test_played_position_is_read_before_upstream_clears_the_buffer():
    async def scenario():
        c = Client()
        await c.replay([{"event": {"type": "response.created", "response": {"id": "r1"}}},
                        {"event": {"type": "response.output_audio.delta", "response_id": "r1", "seconds": 4.0}},
                        {"play_s": 1.0}])
        seen = []
        c.coordinator._history.observe = lambda event, played_s: seen.append(played_s("r1")) or []
        await c.receive({"type": "input_audio_buffer.speech_started"})
        return seen, c.buffer.consumed_bytes

    seen, consumed = run(scenario())
    assert seen == [1.0]  # not the 4.0 s the clear will add to consumed_bytes
    assert consumed == len(pcm(4.0))


# --------------------------------------------------------------------------------------------- event traces
@pytest.mark.parametrize("path", TRACES, ids=[p.stem for p in TRACES])
def test_trace(path):
    trace = json.loads(path.read_text())
    sent = run(replay(trace["steps"]))
    assert sent == trace["expected"], trace["description"]


def test_traces_never_add_assistant_turns_or_unheard_questions():
    for path in TRACES:
        trace = json.loads(path.read_text())
        sent = run(replay(trace["steps"]))
        assert all(e["type"] == "conversation.item.delete" or e["item"]["role"] == "user" for e in sent)
        notes = " ".join(e["item"]["content"][0]["text"] for e in sent if e["type"] == "conversation.item.create")
        assert "?" not in notes, path.name  # the abandoned question never reaches the history


def test_traces_cover_the_required_cases():
    assert {p.stem for p in TRACES} >= {"cut-mid-first-sentence", "cut-after-first-sentence",
                                        "late-barge-on-completed-reply", "repeated-barge-in", "fully-heard-reply"}
