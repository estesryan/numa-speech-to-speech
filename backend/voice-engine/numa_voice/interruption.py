"""Keep the conversation history true to what the user actually heard when they interrupt the assistant.

The note text and the prompts call the user "the guest" and the assistant "the host".

Upstream speech-to-speech 1.1.0 cancels the assistant's reply as soon as the user starts talking (fast, and kept as
is), but then rolls the whole reply out of its chat history and ignores `conversation.item.truncate`. The model
therefore never learns it was interrupted: it sees its own earlier question, immediately followed by the user's
interruption merged into the previous user message, and simply asks the question again.

Only the client knows how much of a reply was played, so this fix lives on the client side and uses only the
public Realtime protocol. When the assistant is interrupted, a short note goes into the history on the user's side,
quoting the complete sentences the user heard, or saying they were cut off before finishing one:

    (The guest interrupts you. They heard you say: "That's a fascinating tension." Then they cut you off.)

Items are applied in arrival order and the user's speech is committed only after they finish talking, so the
note lands immediately before the interruption; upstream merges consecutive user messages when it renders the
prompt. The unheard reply itself never stays in the history: upstream has already removed it if it was still being
generated, and this module deletes it if it had been finalized.

Why a quoted note in the user's turn, rather than the heard words as a truncated assistant turn: Qwen3.5 imitates
the form of its own earlier turns. With truncated assistant turns ("That's a fascinating…") or a marker inside them
in the history, later replies came out truncated, spoke the marker aloud, or were only "…". A quoted half-sentence
("That's a fascinating") is also completed: the assistant finished it and asked its abandoned question again. So
only whole sentences are quoted (each of these was observed in live testing).

`InterruptionHistory` is transport-agnostic: feed it every server event (as a dict) plus a callback giving how
many seconds of a reply have been played, and send whatever events it returns.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

NOTE_PREFIX = "(The guest interrupts you."
NOTE_HEARD = NOTE_PREFIX + ' They heard you say: "{heard}" Then they cut you off.)'
NOTE_FEW_WORDS = NOTE_PREFIX + " They cut you off before you finished your first sentence.)"
NOTE_NOTHING_HEARD = NOTE_PREFIX + " They had not heard your reply yet.)"

# Appended to every persona's prompt (numa_voice/personas.py): how the assistant must treat the notes above.
ENGINE_INSTRUCTIONS = (
    "A guest message may begin with a note in parentheses saying the guest interrupted you and what they had "
    "heard. Treat it as context only: never read it aloud, and do not repeat, finish or rephrase what you were "
    "saying. When interrupted, set your own question aside: reply only to what the guest says after the note, "
    "and if they want to say or ask something, simply invite them to."
)


@dataclass
class _Reply:
    id: str
    text: str = ""
    audio_bytes: int = 0
    audio_done: bool = False
    item_id: str | None = None
    status: str | None = None


def _b64_len(data: str) -> int:
    return len(data) * 3 // 4 - data[-2:].count("=") if data else 0


def heard_prefix(text: str, fraction: float) -> str:
    """The words of `text` spoken by the time `fraction` of it has been played (rounded down to whole words)."""
    if fraction >= 0.98:
        return text.strip()
    cut = int(len(text) * max(0.0, fraction))
    prefix = text[:cut]
    if cut < len(text) and not text[cut].isspace():
        prefix = prefix.rsplit(" ", 1)[0] if " " in prefix else ""
    return re.sub(r"[\s,;:]+$", "", prefix.strip())


def whole_sentences(text: str) -> str:
    """`text` up to its last complete sentence ("" if none is complete)."""
    ends = [m.end() for m in re.finditer(r"[.!?](?=\s|$)", text)]
    return text[:ends[-1]].strip() if ends else ""


def interruption_note(heard: str) -> dict:
    """The user-side note: a user message quoting the whole sentences the user heard."""
    sentences = whole_sentences(heard)
    if sentences:
        text = NOTE_HEARD.format(heard=sentences.replace('"', "'"))
    else:
        text = NOTE_FEW_WORDS if heard else NOTE_NOTHING_HEARD
    return {"type": "conversation.item.create",
            "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}}


class InterruptionHistory:
    """Two cases, because upstream streams a reply's audio faster than real time:

    - The user cuts in while the reply is still being generated: upstream cancels it (`response.done` with status
      "cancelled", sent before `speech_started`) and removes it from the history; the note is added then.
    - The user cuts in after generation finished but while the audio is still playing: upstream has already
      written the whole reply into the history, so it is deleted and the note added at `speech_started`.
    """

    def __init__(self, sample_rate: int = 16000, chars_per_second: float = 14.0, min_heard_s: float = 0.3) -> None:
        self.sample_rate = sample_rate
        self.chars_per_second = chars_per_second  # refined from completed replies in this session
        self.min_heard_s = min_heard_s
        self.replies: dict[str, _Reply] = {}
        self.last_spoken: str | None = None  # the most recent reply that produced audio
        self.heard_at_barge: dict[str, float] = {}
        self.handled: set[str] = set()

    def _audio_s(self, reply: _Reply) -> float:
        return reply.audio_bytes / 2 / self.sample_rate

    def heard_text(self, reply: _Reply, heard_s: float) -> str:
        if heard_s < self.min_heard_s:
            return ""
        if reply.audio_done and reply.audio_bytes:
            fraction = heard_s / self._audio_s(reply)
        else:  # audio not fully generated yet: estimate from this session's speaking rate
            fraction = heard_s * self.chars_per_second / max(1, len(reply.text))
        return heard_prefix(reply.text, min(1.0, fraction))

    def observe(self, event: dict, played_s: Callable[[str], float]) -> list[dict]:
        """Update state with one server event; return the events to send back (usually none)."""
        kind = event.get("type", "")
        rid = event.get("response_id") or (event.get("response") or {}).get("id")
        reply = self.replies.get(rid) if rid else None

        if kind == "response.created" and rid:
            self.replies[rid] = _Reply(rid)
        elif reply is None and kind.startswith("response."):
            return []
        elif kind == "response.output_item.added":
            reply.item_id = (event.get("item") or {}).get("id") or reply.item_id
        elif kind == "response.output_audio_transcript.delta":
            reply.text += event.get("delta", "")
        elif kind == "response.output_audio_transcript.done":
            reply.text = event.get("transcript") or reply.text
        elif kind == "response.output_audio.delta":
            reply.audio_bytes += _b64_len(event.get("delta", ""))
            self.last_spoken = rid
        elif kind == "response.output_audio.done":
            reply.audio_done = True
        elif kind == "input_audio_buffer.speech_started":
            # runs before the client clears its playback buffer, so playback position is still known
            target = self.replies.get(self.last_spoken or "")
            if target is None or target.id in self.handled or not target.audio_bytes:
                return []
            heard = played_s(target.id)
            if target.status is None:  # still generating: upstream will cancel it; finish on response.done
                self.heard_at_barge[target.id] = heard
            elif target.status == "completed" and target.audio_done and heard < self._audio_s(target) - 0.3:
                # finalized in full, but the user stopped listening part-way: remove it, quote what was heard
                self.handled.add(target.id)
                out = [{"type": "conversation.item.delete", "item_id": target.item_id}] if target.item_id else []
                return out + [interruption_note(self.heard_text(target, heard))]
        elif kind == "response.done":
            reply.status = (event.get("response") or {}).get("status")
            heard = self.heard_at_barge.pop(rid, None)
            if reply.status == "completed" and reply.audio_done and reply.audio_bytes and len(reply.text) > 20:
                # learn this voice's speaking rate (characters per second of audio) for in-flight estimates
                self.chars_per_second = 0.7 * self.chars_per_second + 0.3 * (len(reply.text) / self._audio_s(reply))
            if reply.status == "cancelled" and reply.audio_bytes and rid not in self.handled:
                # Upstream has already removed the reply. It sends this cancellation *before* `speech_started`, so
                # the playback position is taken now unless a barge-in already recorded it.
                self.handled.add(rid)
                return [interruption_note(self.heard_text(reply, played_s(rid) if heard is None else heard))]
        return []
