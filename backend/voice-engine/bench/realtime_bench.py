"""Benchmark driver for a running `speech-to-speech serve` Realtime server.

Test tooling, not product streaming: it plays recorded speech into the server over the same WebSocket protocol and
session settings as upstream's audio client (`speech_to_speech/api/openai_realtime/audio_client.py`), the way
upstream's own Big Bench Audio evaluator does. The microphone is emulated continuously: one 40 ms PCM16 frame at
16 kHz every 40 ms of wall-clock time, silence between clips, exactly like a real microphone that never stops.

Per turn it records the server's own latency record (stt, llm, tts_ttfa, e2e from `response.done` metadata) and,
client-side, the time from the true end of speech to the first audio received. Upstream's client starts playback
on the first audio (0 ms buffer), so first audio received is the moment playback starts, before the sound
device's output latency.

The integration tests (tests/integration/) use it as their Realtime client. Its benchmark sessions read recorded
inputs from bench-data/, which this repository does not include.

    .venv/bin/python bench/realtime_bench.py --run 4b --sessions interrupt
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import re
import subprocess
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf
import websockets

from numa_voice.interruption import NOTE_PREFIX, InterruptionHistory

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "bench-data"
RESULTS = HERE.parent / "results"
RATE = 16000
FRAME = 640  # 40 ms
FRAME_S = FRAME / RATE


def load(path: Path) -> np.ndarray:
    audio, sr = sf.read(path, dtype="float32")
    assert sr == RATE, f"{path}: {sr} Hz"
    return audio if audio.ndim == 1 else audio.mean(1)


def speech_bounds(audio: np.ndarray) -> tuple[float, float]:
    """(onset, end) of speech in seconds: 20 ms frames within 35 dB of the loudest frame."""
    hop = RATE // 50
    n = len(audio) // hop
    db = 10 * np.log10(np.mean(audio[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    active = np.nonzero(db > db.max() - 35)[0]
    return float(active[0] * hop / RATE), float((active[-1] + 1) * hop / RATE)


# ------------------------------------------------------------------------------------------- microphone emulation
@dataclass
class Playback:
    started: float = 0.0       # perf_counter when the clip's first frame was delivered
    speech_onset: float = 0.0  # estimated wall-clock time speech began
    speech_end: float = 0.0    # estimated wall-clock time speech ended
    finished: float = 0.0


class Mic:
    def __init__(self, ws) -> None:
        self.ws = ws
        self.pending: deque[tuple[np.ndarray, Playback, asyncio.Event, asyncio.Event]] = deque()
        self.stop = False

    def play(self, audio: np.ndarray) -> tuple[Playback, asyncio.Event, asyncio.Event]:
        info, started, done = Playback(), asyncio.Event(), asyncio.Event()
        self.pending.append((audio, info, started, done))
        return info, started, done

    async def run(self) -> None:
        t0 = time.perf_counter()
        n = 0
        current = None
        pos = 0
        while not self.stop:
            if current is None and self.pending:
                current, pos = self.pending.popleft(), 0
            if current is not None:
                audio, info, started, done = current
                frame = audio[pos : pos + FRAME]
                if len(frame) < FRAME:
                    frame = np.pad(frame, (0, FRAME - len(frame)))
            else:
                frame = np.zeros(FRAME, dtype=np.float32)
            pcm = (np.clip(frame, -1, 1) * 32767).astype("<i2").tobytes()
            await self.ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm).decode()}))
            sent = time.perf_counter()
            if current is not None:
                # a real microphone delivers a frame when its last sample has been spoken
                frame_start = sent - FRAME_S
                if pos == 0:
                    onset, end = speech_bounds(audio)
                    info.started = frame_start
                    info.speech_onset = frame_start + onset
                    info.speech_end = frame_start + end
                    started.set()
                pos += FRAME
                if pos >= len(audio):
                    info.finished = sent
                    done.set()
                    current = None
            n += 1
            await asyncio.sleep(max(0.0, t0 + n * FRAME_S - time.perf_counter()))


# ------------------------------------------------------------------------------------------------ server events
@dataclass
class Response:
    id: str
    created: float
    first_audio: float | None = None
    last_audio: float | None = None
    audio_bytes: int = 0
    text: str = ""
    done: float | None = None
    status: str | None = None
    latency: dict | None = None
    chunks: list = field(default_factory=list, repr=False)

    @property
    def audio_s(self) -> float:
        return self.audio_bytes / 2 / RATE


def _item_text(item: dict) -> str:
    parts = item.get("content") or []
    return " ".join(p.get("text") or p.get("transcript") or "" for p in parts if isinstance(p, dict)).strip()


class Events:
    def __init__(self, ws=None, history_fix: bool = False) -> None:
        self.responses: dict[str, Response] = {}
        self.order: list[str] = []
        self.speech_started: list[float] = []
        self.speech_stopped: list[float] = []
        self.user_transcripts: list[tuple[float, str]] = []
        self.cleared: list[float] = []
        self.errors: list[dict] = []
        self.items: list[dict] = []  # conversation.item.created: the server's history, in its order
        self.deleted: list[tuple[float, str]] = []
        self.sent: list[tuple[float, dict]] = []  # events written back by the interruption fix
        self.changed = asyncio.Event()
        self.ws = ws
        # Numa's interruption fix (numa_voice.interruption), with playback emulated in real time
        self.history = InterruptionHistory(RATE) if history_fix else None

    def after(self, t: float) -> list[Response]:
        return [self.responses[i] for i in self.order if self.responses[i].created >= t]

    def played_s(self, rid: str) -> float:
        """Seconds of a reply a real-time player would have played by now."""
        r = self.responses.get(rid)
        if r is None or r.first_audio is None:
            return 0.0
        return max(0.0, min(r.audio_s, time.perf_counter() - r.first_audio))

    async def receive(self, ws) -> None:
        async for raw in ws:
            t = time.perf_counter()
            ev = json.loads(raw)
            kind = ev.get("type", "")
            rid = ev.get("response_id") or (ev.get("response") or {}).get("id")
            if kind == "input_audio_buffer.speech_started":
                self.speech_started.append(t)
            elif kind == "input_audio_buffer.speech_stopped":
                self.speech_stopped.append(t)
            elif kind == "conversation.item.input_audio_transcription.completed":
                self.user_transcripts.append((t, ev.get("transcript", "")))
            elif kind == "response.created" and rid:
                self.responses[rid] = Response(rid, t)
                self.order.append(rid)
            elif kind == "response.output_audio.delta" and rid in self.responses:
                r = self.responses[rid]
                pcm = base64.b64decode(ev.get("delta", ""))
                r.first_audio = r.first_audio or t
                r.last_audio = t
                r.audio_bytes += len(pcm)
                r.chunks.append(pcm)
            elif kind == "response.output_audio_transcript.delta" and rid in self.responses:
                self.responses[rid].text += ev.get("delta", "")
            elif kind == "response.done" and rid in self.responses:
                r = self.responses[rid]
                r.done, r.status = t, ev["response"].get("status")
                raw_lat = (ev["response"].get("metadata") or {}).get("speech_to_speech.turn_latency")
                r.latency = json.loads(raw_lat) if raw_lat else None
            elif kind == "output_audio_buffer.cleared":
                self.cleared.append(t)
            elif kind == "conversation.item.created":
                item = ev.get("item") or {}
                self.items.append({"t": t, "id": item.get("id"), "role": item.get("role"),
                                   "previous": ev.get("previous_item_id"), "text": _item_text(item)})
            elif kind == "conversation.item.deleted":
                self.deleted.append((t, ev.get("item_id")))
            elif kind == "error":
                self.errors.append(ev)
            if self.history is not None:
                for out in self.history.observe(ev, self.played_s):
                    await ws.send(json.dumps(out))
                    self.sent.append((time.perf_counter(), out))
            self.changed.set()

    async def wait_for(self, predicate, timeout: float):
        deadline = time.perf_counter() + timeout
        while True:
            value = predicate()
            if value:
                return value
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                return None
            self.changed.clear()
            # re-check at least every 100 ms: some conditions become true by time passing, not by a new event
            try:
                await asyncio.wait_for(self.changed.wait(), min(remaining, 0.1))
            except TimeoutError:
                pass


# --------------------------------------------------------------------------------------------- resource sampling
class Sampler(threading.Thread):
    """Server footprint (MB), CPU %, and GPU device utilization % (ioreg, no sudo), once per second."""

    def __init__(self, pid: int) -> None:
        super().__init__(daemon=True)
        self.pid, self.samples, self.running = pid, [], True

    def run(self) -> None:
        while self.running:
            t = time.perf_counter()
            fp = re.search(r"phys_footprint:\s+([\d.]+)\s*(MB|GB)", subprocess.run(
                ["footprint", "-p", str(self.pid)], capture_output=True, text=True).stdout)
            mb = (float(fp.group(1)) * (1024 if fp.group(2) == "GB" else 1)) if fp else None
            cpu = subprocess.run(["ps", "-o", "%cpu=", "-p", str(self.pid)], capture_output=True, text=True).stdout.strip()
            gpu = re.search(r'"Device Utilization %"=(\d+)', subprocess.run(
                ["ioreg", "-r", "-d", "1", "-w", "0", "-c", "AGXAccelerator"], capture_output=True, text=True).stdout)
            self.samples.append({"t": t, "footprint_mb": mb, "cpu_pct": float(cpu) if cpu else None,
                                 "gpu_util_pct": int(gpu.group(1)) if gpu else None})
            time.sleep(max(0.0, 1.0 - (time.perf_counter() - t)))


# ------------------------------------------------------------------------------------------------------ sessions
SESSION_UPDATE = {
    "type": "session.update",
    "session": {
        "type": "realtime",
        "extensions": ["speech_to_speech.input_audio_transcription.snapshot"],
        "audio": {"input": {"turn_detection": {"type": "server_vad", "interrupt_response": True}}, "output": {}},
    },
}


async def finish_listening(ev: Events, played: Playback, timeout: float = 90.0) -> list[Response]:
    """Wait until every response to this clip is done and its audio would have finished playing."""
    def settled():
        # Speculative drafts cancelled when the speaker resumes get no response.done (upstream documents that
        # abandoned responses have no terminal record), so wait for the last response that produced audio.
        rs = ev.after(played.started)
        spoken = [r for r in rs if r.first_audio]
        if not spoken:
            return None
        last = spoken[-1]
        newer = any(r.created > last.created for r in rs)
        if last.done and not newer and time.perf_counter() - last.done > 1.5:
            return rs
        return None
    rs = await ev.wait_for(settled, timeout) or ev.after(played.started)
    playing_until = max((r.first_audio + r.audio_s for r in rs if r.first_audio), default=time.perf_counter())
    await asyncio.sleep(max(0.0, playing_until - time.perf_counter()) + 0.6)  # natural pause before replying
    return rs


def turn_record(kind: str, idx: int, item: dict, played: Playback, rs: list[Response], ev: Events) -> dict:
    spoken = [r for r in rs if r.first_audio]
    first = spoken[0] if spoken else None
    asr = [txt for t, txt in ev.user_transcripts if t >= played.started]
    return {
        "kind": kind, "turn": idx, "input": item.get("file"), "reference": item.get("text"),
        "input_speech_s": round(played.speech_end - played.speech_onset, 3),
        "asr": " ".join(asr), "responses": len(rs), "statuses": [r.status for r in rs],
        "reply": first.text if first else None, "reply_audio_s": round(first.audio_s, 3) if first else None,
        "client_e2e_s": round(first.first_audio - played.speech_end, 4) if first else None,
        "server_latency": first.latency if first else None,
        "split_turn": len(spoken) > 1,
        "abandoned_drafts": sum(1 for r in rs if r.done is None and not r.first_audio),
    }


def save_audio(rs: list[Response], outdir: Path, stem: str) -> None:
    for k, r in enumerate(x for x in rs if x.chunks):
        pcm = np.frombuffer(b"".join(r.chunks), dtype="<i2").astype(np.float32) / 32768
        sf.write(outdir / f"{stem}-r{k}.wav", pcm, RATE, subtype="PCM_16")


async def connect(url: str, retry_s: float = 90.0):
    """Open a session. The server has one pipeline slot and frees it a moment after the previous client leaves; a
    busy server accepts the socket, sends a `session_limit_reached` error and closes, so retry until it is free."""
    deadline = time.perf_counter() + retry_s
    while True:
        ws = await websockets.connect(url, max_size=None)
        first = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if first.get("type") == "session.created":
            return ws
        await ws.close()
        if (first.get("error") or {}).get("type") != "session_limit_reached" or time.perf_counter() > deadline:
            raise RuntimeError(f"could not open a session: {first}")
        await asyncio.sleep(2.0)


def _norm_words(text: str) -> list[str]:
    return re.sub(r"[^a-z0-9' ]", " ", (text or "").lower()).split()


def last_question(text: str) -> str:
    """The final question sentence of a reply (what the assistant would 'ask again')."""
    qs = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text or "") if s.strip().endswith("?")]
    return qs[-1] if qs else ""


def repeats(question: str, reply: str, threshold: float = 0.6) -> bool:
    """True if `reply` contains most of `question`'s words in a single sentence (the assistant asking again)."""
    q = set(_norm_words(question))
    if len(q) < 4:
        return False
    return any(len(q & set(_norm_words(s))) / len(q) >= threshold for s in re.split(r"(?<=[.!?])\s+", reply or ""))


def history_chain(ev: Events, since: float) -> dict:
    """Server-side history after an interruption: the user-side note (quoting what was heard) immediately before
    the user's interruption. `ordered` checks the link through the server's own previous_item_id."""
    items = [i for i in ev.items if i["t"] >= since]
    note = next((i for i in items if i["role"] == "user" and i["text"].startswith(NOTE_PREFIX)), None)
    after = [i for i in items if note and i["t"] > note["t"] and i["role"] == "user"]
    return {
        "items": [(i["role"], i["text"][:100], i["id"], i["previous"]) for i in items],
        "injected": note["text"] if note else None,
        "ordered": bool(note and after and after[0]["previous"] == note["id"]),
    }


def leaked_note(text: str | None) -> bool:
    """True if the assistant said the interruption note itself (it must never be spoken)."""
    t = (text or "").lower()
    return "guest interrupts" in t or "heard you say" in t or "cut you off" in t or "(the guest" in t


def silent(text: str | None) -> bool:
    return len(re.findall(r"[a-zA-Z]+", text or "")) < 2


async def run_session(url: str, name: str, items: list[dict], outdir: Path, interrupt_cycles: int = 0,
                      barge_after_s: float = 1.0, history_fix: bool = True, second_barge: dict | None = None,
                      ) -> list[dict]:
    records = []
    async with await connect(url) as ws:
        ev, mic = Events(ws, history_fix=history_fix), Mic(ws)
        recv = asyncio.create_task(ev.receive(ws))
        await ws.send(json.dumps(SESSION_UPDATE))
        await asyncio.sleep(0.5)
        send = asyncio.create_task(mic.run())

        async def guarded(aw):
            """Await `aw`, but fail at once if the connection's sender or receiver task stops."""
            task = asyncio.ensure_future(aw)
            finished, _ = await asyncio.wait({task, send, recv}, return_when=asyncio.FIRST_COMPLETED)
            if task in finished:
                return task.result()
            task.cancel()
            broken = send if send in finished else recv
            raise RuntimeError(f"{name}: connection lost ({broken.exception() or 'closed by server'})")

        await asyncio.sleep(1.0)  # some room tone first

        async def barge_in(r: Response, clip_item: dict, cycle: int,
                           then: dict | None = None) -> tuple[dict, list[Response]]:
            """Interrupt reply `r` `barge_after_s` into its playback with `clip_item`, then wait for the assistant's
            answer. With `then`, interrupt that answer too, `barge_after_s` into its playback (repeated barge-in)."""
            await asyncio.sleep(max(0.0, r.first_audio + barge_after_s - time.perf_counter()))
            barge, b_started, b_done = mic.play(load(DATA / clip_item["file"]))
            await guarded(b_started.wait())
            detected = await guarded(ev.wait_for(lambda: next((t for t in ev.speech_started if t > barge.started), None), 10))
            await guarded(ev.wait_for(lambda: r.done, 30))
            await guarded(b_done.wait())
            second = None
            if then is not None:
                r2 = await guarded(ev.wait_for(lambda: next((x for x in ev.after(barge.started) if x.first_audio), None), 60))
                if r2 is None:
                    follow = ev.after(barge.started)
                else:
                    second, follow2 = await barge_in(r2, then, cycle)
                    follow = [r2, *follow2]
            else:
                follow = await guarded(finish_listening(ev, barge))
            answer = next((x.text for x in follow if x.first_audio), None) or ""
            abandoned = last_question(r.text)
            extra = {"second": second} if then is not None else {}
            return extra | {
                "host_audio_playing_at_barge": r.first_audio + r.audio_s > barge.speech_onset,
                "barge_detect_s": round(detected - barge.speech_onset, 4) if detected else None,
                "interrupted_status": r.status,
                "cancel_s": round(r.done - barge.speech_onset, 4) if r.done and r.status == "cancelled" else None,
                "audio_after_barge_s": round(max(0.0, (r.last_audio or 0) - barge.speech_onset), 4),
                "interrupted_reply": r.text,
                "barge_asr": " ".join(txt for t, txt in ev.user_transcripts if t >= barge.started),
                "reply_to_barge": answer,
                "repeats_abandoned_question": repeats(abandoned, answer),
                "host_spoke_the_note": leaked_note(answer) or leaked_note(r.text),
                "empty_answer": silent(answer),
                "history": history_chain(ev, r.created),  # the write-back belonging to this interrupted reply
                "followup": turn_record("interrupt-followup", cycle, clip_item, barge, follow, ev),
            }, follow

        if interrupt_cycles:
            q = load(DATA / items[0]["file"])
            for c in range(interrupt_cycles):
                cycle_start = time.perf_counter()
                played, _, done = mic.play(q)
                await guarded(done.wait())
                r = await guarded(ev.wait_for(lambda: next((x for x in ev.after(played.started) if x.first_audio), None), 60))
                if r is None:
                    records.append({"kind": "interrupt", "cycle": c, "error": "no reply to question"})
                    continue
                first, follow = await barge_in(r, items[1], c, then=second_barge)
                record = {"kind": "interrupt", "cycle": c, "barge_after_s": barge_after_s, **first}
                spoken = [r, *follow]
                record["history_since_question"] = history_chain(ev, cycle_start)
                records.append(record)
                save_audio(spoken, outdir, f"{name}-c{c:02d}")
                print(f"  {name} {c:02d} status={first['interrupted_status']} detect={first['barge_detect_s']} "
                      f"ordered={first['history']['ordered']} repeats={first['repeats_abandoned_question']}", flush=True)
        else:
            for i, item in enumerate(items):
                played, _, done = mic.play(load(DATA / item["file"]))
                await guarded(done.wait())
                rs = await guarded(finish_listening(ev, played))
                records.append(turn_record(name, i, item, played, rs, ev))
                save_audio(rs, outdir, f"{name}-t{i:02d}")
                rec = records[-1]
                print(f"  {name} {i:02d} e2e={rec['client_e2e_s']} srv={rec['server_latency']} split={rec['split_turn']}", flush=True)
        mic.stop = True
        await asyncio.sleep(0.1)
        send.cancel()
        recv.cancel()
        if ev.errors:
            records.append({"kind": "errors", "errors": ev.errors})
    return records


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://127.0.0.1:8765/v1/realtime")
    parser.add_argument("--run", required=True, help="results/<run>/")
    parser.add_argument("--sessions", nargs="+", default=["interrupt"])
    parser.add_argument("--interrupt-cycles", type=int, default=10)
    parser.add_argument("--human-repeats", type=int, default=1, help="play the human set N times in one session")
    parser.add_argument("--server-pid", type=int)
    parser.add_argument("--no-history-fix", action="store_true", help="baseline: upstream behaviour on interruption")
    parser.add_argument("--barge-after", type=float, default=1.0,
                        help="seconds into the assistant's reply to interrupt")
    parser.add_argument("--second-barge", action="store_true",
                        help="interrupt the assistant's answer to the interruption too")
    args = parser.parse_args()

    manifest = json.loads((DATA / "manifest.json").read_text())
    out = RESULTS / args.run
    (out / "audio").mkdir(parents=True, exist_ok=True)
    pid = args.server_pid or int(subprocess.run(["pgrep", "-f", "(numa-voice|speech-to-speech) serve"], capture_output=True,
                                                 text=True).stdout.split()[0])
    sampler = Sampler(pid)
    sampler.start()
    marks = []
    for name in args.sessions:
        t0 = time.perf_counter()
        print(f"session {name}", flush=True)
        try:
            recs = run_named(name, args, manifest, out)
        except Exception as error:  # record and continue with the next session
            print(f"  session {name} FAILED: {error}", flush=True)
            recs = [{"kind": "errors", "errors": [repr(error)]}]
        marks.append({"session": name, "t_start": t0, "t_end": time.perf_counter()})
        with open(out / f"{name}.jsonl", "w") as f:
            for r in recs:
                f.write(json.dumps(r) + "\n")
    sampler.running = False
    sampler.join(timeout=3)
    (out / "resources.json").write_text(json.dumps({"pid": pid, "sessions": marks, "samples": sampler.samples}))
    print(f"done: {out}")


def run_named(name: str, args, manifest: dict, out: Path) -> list[dict]:
    audio = out / "audio"
    fix = not args.no_history_fix
    if name in ("warmup", "human") and not manifest.get("human"):
        raise RuntimeError("no human set in bench-data/manifest.json")
    if name == "warmup":
        items = manifest["human"][-2:]  # the two utterances not used in the human session's 38
        return asyncio.run(run_session(args.url, name, items, audio, history_fix=fix))
    if name == "human":
        return asyncio.run(run_session(args.url, name, manifest["human"][:38] * args.human_repeats, audio, history_fix=fix))
    if name == "interrupt":
        items = [manifest["interrupt"]["question"], manifest["interrupt"]["barge"]]
        second = manifest["interrupt"]["barge_short"] if args.second_barge else None
        return asyncio.run(run_session(args.url, name, items, audio, interrupt_cycles=args.interrupt_cycles,
                                       barge_after_s=args.barge_after, history_fix=not args.no_history_fix,
                                       second_barge=second))
    return asyncio.run(run_session(args.url, name, manifest[name], audio, history_fix=fix))


if __name__ == "__main__":
    main()
