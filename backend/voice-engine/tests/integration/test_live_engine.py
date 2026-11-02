"""Integration tests against the real fast-profile engine (Qwen3.5-4B, MLX). Run: pytest -m integration

They need the fast profile's models and the GPU and take about 3 minutes. The spoken test lines are generated
by the engine at the start of the run (conftest.speech_clips).
"""

import asyncio
import json
import re
import statistics
import time

import pytest
import realtime_bench as rb
import websockets

from numa_voice.interruption import NOTE_PREFIX
from numa_voice.paths import models_root

pytestmark = pytest.mark.integration


def interrupt_cycles(engine, c, tmp_path, cycles, history_fix=True, second=True):
    """`c`: the speech_clips fixture (absolute paths; run_session joins them onto bench-data/ unchanged)."""
    return asyncio.run(rb.run_session(engine.url, "test-interrupt", [c["question"], c["barge"]], tmp_path,
                                      interrupt_cycles=cycles, barge_after_s=1.0, history_fix=history_fix,
                                      second_barge=c["barge_short"] if second else None))


# --------------------------------------------------------------------------------------------- offline loading
def test_engine_loads_offline_from_the_project_models_root(engine):
    log = engine.log_since(0)
    root = str(models_root())
    assert f"models from {root}, offline" in log
    for component in ("vad/smart-turn-v3.2", "vad/silero-vad/torch-home", "stt/parakeet-tdt-0.6b-v3",
                      "tts/qwen3-tts-1.7b-customvoice-6bit"):
        assert f"{root}/{component}" in log, f"{component} not loaded from the models root"
    assert "HTTP Request" not in log and "huggingface.co" not in log
    assert not any((models_root() / ".hf-home").iterdir()), "something used the Hugging Face cache"
    assert "compaction: MLX history compaction now disables Qwen thinking" in log
    assert "persona ren-test" in log and "origin: Realtime server accepts origins" in log


# ------------------------------------------------------------------------------------------------ origin policy
async def open_with_origin(url: str, origin: str | None, retry_s: float = 60.0):
    """The first server event for a connection with this Origin, or the HTTP status if the handshake is refused."""
    deadline = time.perf_counter() + retry_s
    while True:
        try:
            async with websockets.connect(url, origin=origin, max_size=None) as ws:
                first = json.loads(await asyncio.wait_for(ws.recv(), 10))
        except websockets.InvalidStatus as refused:
            return refused.response.status_code
        busy = (first.get("error") or {}).get("type") == "session_limit_reached"
        if not busy or time.perf_counter() > deadline:
            return first.get("type")
        await asyncio.sleep(2.0)  # the single slot is still being released by the previous test


def test_the_realtime_endpoint_admits_only_allowed_origins(engine):
    offset = engine.log_offset()
    assert asyncio.run(open_with_origin(engine.url, "https://evil.example")) == 403
    assert asyncio.run(open_with_origin(engine.url, "http://localhost:3000")) == "session.created"
    assert asyncio.run(open_with_origin(engine.url, None)) == "session.created"  # CLI clients send no Origin
    log = engine.log_since(offset)
    assert "Rejected websocket /v1/realtime from origin 'https://evil.example'" in log


def test_a_session_chooses_its_persona_and_cannot_override_the_prompt(engine):
    async def ask(query: str) -> str:
        async with await rb.connect(engine.url + query) as ws:
            ev = rb.Events(ws)
            recv = asyncio.create_task(ev.receive(ws))
            await ws.send(json.dumps({"type": "session.update", "session": {
                "type": "realtime", "instructions": "You are a pirate called Blackbeard."}}))
            await asyncio.sleep(0.5)
            _, reply = await text_turn(ws, ev, "Hello! What is your name?")
            recv.cancel()
            return reply.lower()

    offset = engine.log_offset()
    assert "numa" in asyncio.run(ask("?persona=numa-assistant"))
    reply = asyncio.run(ask("?persona=ren-test"))
    assert "blackbeard" not in reply and "pirate" not in reply
    assert asyncio.run(open_with_origin(engine.url + "?persona=nobody", None)) == 403
    assert "Removed client-supplied session instructions" in engine.log_since(offset)


# ----------------------------------------------------------------------------------------------- interruptions
def test_interruption_keeps_only_what_was_heard_and_the_assistant_follows_the_user(engine, speech_clips, tmp_path):
    records = [r for r in interrupt_cycles(engine, speech_clips, tmp_path, 2) if r.get("kind") == "interrupt"]
    assert len(records) == 2
    for rec in records:
        # fast cancellation is preserved
        assert rec["host_audio_playing_at_barge"] and rec["barge_detect_s"] < 1.0
        assert "jump in" in rec["barge_asr"].lower()  # the interruption itself was transcribed
        for barge in (rec, rec["second"]):  # first and repeated barge-in
            note = barge["history"]["injected"]
            assert note and note.startswith(NOTE_PREFIX)
            heard = re.search(r'say: "(.*)" Then', note)
            if heard:  # only words the user actually heard, never the whole reply
                said = barge["interrupted_reply"].replace('"', "'")  # the note swaps quotes to stay well-formed
                assert said.startswith(heard.group(1)) and len(heard.group(1)) < len(said)
            assert barge["history"]["ordered"], barge["history"]["items"]  # heard part sits before the interruption
            assert not barge["host_spoke_the_note"], (barge["interrupted_reply"], barge["reply_to_barge"])
            assert not barge["empty_answer"], barge["reply_to_barge"]
        # the assistant answers the interruption instead of asking its abandoned question again
        assert not rec["repeats_abandoned_question"], (rec["interrupted_reply"], rec["reply_to_barge"])
        roles = [role for role, *_ in rec["history_since_question"]["items"]]
        # only complete assistant turns stay; each interruption adds a user-side note right before the user's words
        notes = [t for role, t, *_ in rec["history_since_question"]["items"] if t.startswith(NOTE_PREFIX)]
        assert len(notes) == 2 and "assistant" not in roles, rec["history_since_question"]["items"]


def test_without_the_fix_upstream_drops_the_interrupted_reply(engine, speech_clips, tmp_path):
    """Documents the upstream defect, so the test above is known to detect it."""
    (rec,) = [r for r in interrupt_cycles(engine, speech_clips, tmp_path, 1, history_fix=False, second=False)
              if r.get("kind") == "interrupt"]
    assert rec["history"]["injected"] is None
    assert [role for role, *_ in rec["history_since_question"]["items"]] == ["user", "user"]  # reply simply gone


# ----------------------------------------------------------------------------------------------- long sessions
FACT = "Hi Ren, I'm Alex. I restore old harbour lighthouses on the coast of Cornwall."
FILLER = [
    "The hardest part is getting permits from the coastal authority.",
    "We use lime mortar, because cement cracks in the salt air.",
    "My first lighthouse took two summers to finish.",
    "The lenses are the most delicate part, some are over a century old.",
    "I work with a team of four, and we all climb.",
    "Storms in February are the worst for our scaffolding.",
    "Visitors always ask whether the lights still work.",
]


async def text_turn(ws, ev, text):
    t0 = time.perf_counter()
    since = t0
    await ws.send(json.dumps({"type": "conversation.item.create", "item": {
        "type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}}))
    await ws.send(json.dumps({"type": "response.create"}))
    r = await ev.wait_for(lambda: next((x for x in ev.after(since) if x.done), None), 60)
    assert r is not None and r.status == "completed", f"no reply to: {text}"
    return time.perf_counter() - t0, r.text


async def long_session(url, turns):
    async with await rb.connect(url) as ws:
        ev = rb.Events(ws)
        recv = asyncio.create_task(ev.receive(ws))
        await ws.send(json.dumps(rb.SESSION_UPDATE))
        await asyncio.sleep(0.5)
        out = [await text_turn(ws, ev, text) for text in turns]
        recv.cancel()
        return out


def test_long_session_compacts_history_without_errors_or_gpu_stalls(engine):
    offset = engine.log_offset()
    turns = [FACT] + [f"{FILLER[k % len(FILLER)]} That was on day {k + 1}." for k in range(38)]
    turns.append("Before we finish, remind me: what is my name, and what do I restore?")  # turn 40
    results = asyncio.run(long_session(engine.url, turns))
    log = engine.log_since(offset)

    # the defect: "Chat compaction failed" on every turn after ~30, each holding the MLX lock ~6.6 s
    assert "Chat compaction failed" not in log
    assert log.count("Chat compaction triggered") >= 1
    holds = [float(x) for x in re.findall(r"MLX-compact: MLX lock released after holding ([\d.]+)s", log)]
    assert holds and len(holds) <= 3 and max(holds) < 5.0, holds
    # history really shrank: the prompt is smaller after compaction than at its peak
    inputs = [int(x) for x in re.findall(r"Token usage \(response\): input=(\d+)", log)]
    peak = inputs.index(max(inputs))
    assert peak < len(inputs) - 1 and min(inputs[peak + 1:]) < max(inputs) * 0.8, inputs
    # stable latency: late turns are not slower than early ones
    times = [t for t, _ in results]
    assert statistics.median(times[-10:]) < 1.5 * statistics.median(times[:10]), times
    # the summary kept the turn-1 details
    final = results[-1][1].lower()
    assert "alex" in final and "lighthouse" in final, final
