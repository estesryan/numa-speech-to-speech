"""InterruptionHistory: the history matches what the user heard (pure logic, synthetic Realtime events)."""

import base64
import re

import pytest

from numa_voice.interruption import (ENGINE_INSTRUCTIONS, NOTE_FEW_WORDS, NOTE_NOTHING_HEARD, NOTE_PREFIX,
                                     InterruptionHistory, heard_prefix, whole_sentences)

RATE = 16000
TEXT = "That is a fascinating tension to explore. Why do you think people crave longer conversations today?"
FIRST = "That is a fascinating tension to explore."


def ev(kind, rid=None, **fields):
    e = {"type": kind, **fields}
    if rid and kind == "response.done":
        e["response"] = {"id": rid, "status": fields.pop("status", None)} | {"status": e.pop("status", None)}
    elif rid:
        e["response_id"] = rid
    return e


def audio(rid, seconds):
    pcm = b"\x00\x00" * int(RATE * seconds)
    return ev("response.output_audio.delta", rid, delta=base64.b64encode(pcm).decode())


def reply(h, rid, text=TEXT, seconds=6.0, item="item_1", done=None, played=lambda r: 0.0):
    out = []
    for e in (ev("response.created", rid, response={"id": rid}),
              ev("response.output_item.added", rid, item={"id": item}),
              ev("response.output_audio_transcript.done", rid, transcript=text),
              audio(rid, seconds), ev("response.output_audio.done", rid)):
        out += h.observe(e, played)
    if done:
        out += h.observe({"type": "response.done", "response": {"id": rid, "status": done}}, played)
    return out


def created_text(events):
    """The words the note quotes; also checks the note is a single user-side message and no assistant turn is added."""
    creates = [e for e in events if e["type"] == "conversation.item.create"]
    assert [c["item"]["role"] for c in creates] == ["user"]  # nothing truncated in the host's voice to imitate
    text = creates[0]["item"]["content"][0]["text"]
    assert text.startswith(NOTE_PREFIX)
    m = re.search(r'say: "(.*)" Then they cut you off\.\)$', text)
    if m is None:
        assert text in (NOTE_FEW_WORDS, NOTE_NOTHING_HEARD)
    return m.group(1) if m else ""


def test_interrupted_while_generating_quotes_only_the_heard_sentences():
    h = InterruptionHistory(RATE)
    assert reply(h, "r1") == []
    assert h.observe({"type": "input_audio_buffer.speech_started"}, lambda r: 3.5) == []  # wait for the cancel
    out = h.observe({"type": "response.done", "response": {"id": "r1", "status": "cancelled"}}, lambda r: 3.5)
    assert created_text(out) == FIRST  # 3.5 of 6 s heard: the first sentence, not the half-heard question


def test_cut_inside_the_first_sentence_quotes_nothing_to_complete():
    h = InterruptionHistory(RATE)
    reply(h, "r1")
    out = h.observe({"type": "response.done", "response": {"id": "r1", "status": "cancelled"}}, lambda r: 1.0)
    assert out[0]["item"]["content"][0]["text"] == NOTE_FEW_WORDS


def test_cancellation_arriving_before_speech_started_still_records_the_heard_part():
    # upstream 1.1.0's real order: response.done(cancelled) first, input_audio_buffer.speech_started right after
    h = InterruptionHistory(RATE)
    reply(h, "r1")
    out = h.observe({"type": "response.done", "response": {"id": "r1", "status": "cancelled"}}, lambda r: 3.0)
    assert created_text(out) == FIRST
    assert h.observe({"type": "input_audio_buffer.speech_started"}, lambda r: 1.0) == []  # not written twice


def test_cancelled_reply_that_was_never_voiced_adds_nothing():
    h = InterruptionHistory(RATE)
    h.observe({"type": "response.created", "response": {"id": "r1"}}, lambda r: 0.0)
    assert h.observe({"type": "response.done", "response": {"id": "r1", "status": "cancelled"}}, lambda r: 0.0) == []


def test_interrupted_before_anything_was_heard_says_so():
    h = InterruptionHistory(RATE)
    reply(h, "r1")
    h.observe({"type": "input_audio_buffer.speech_started"}, lambda r: 0.1)
    out = h.observe({"type": "response.done", "response": {"id": "r1", "status": "cancelled"}}, lambda r: 0.1)
    assert out[0]["item"]["content"][0]["text"] == NOTE_NOTHING_HEARD


def test_completed_reply_cut_short_while_playing_is_replaced():
    h = InterruptionHistory(RATE)
    reply(h, "r1", item="item_A", done="completed")
    out = h.observe({"type": "input_audio_buffer.speech_started"}, lambda r: 4.0)
    assert out[0] == {"type": "conversation.item.delete", "item_id": "item_A"}
    assert created_text(out[1:]) == FIRST


def test_fully_heard_reply_is_left_alone():
    h = InterruptionHistory(RATE)
    reply(h, "r1", seconds=6.0, done="completed")
    assert h.observe({"type": "input_audio_buffer.speech_started"}, lambda r: 5.9) == []


def test_reply_is_rewritten_at_most_once():
    h = InterruptionHistory(RATE)
    reply(h, "r1", done="completed")
    assert h.observe({"type": "input_audio_buffer.speech_started"}, lambda r: 2.0)
    assert h.observe({"type": "input_audio_buffer.speech_started"}, lambda r: 2.5) == []


def test_repeated_barge_ins_each_keep_their_own_heard_part():
    h = InterruptionHistory(RATE)
    reply(h, "r1", text=TEXT, item="a1")
    h.observe({"type": "input_audio_buffer.speech_started"}, lambda r: 3.5)
    first = created_text(h.observe({"type": "response.done", "response": {"id": "r1", "status": "cancelled"}}, lambda r: 3.5))
    second_text = "Of course, go ahead. What would you like to ask me instead of that question?"
    reply(h, "r2", text=second_text, item="a2")
    h.observe({"type": "input_audio_buffer.speech_started"}, lambda r: 2.0)
    second = created_text(h.observe({"type": "response.done", "response": {"id": "r2", "status": "cancelled"}}, lambda r: 2.0))
    assert (first, second) == (FIRST, "Of course, go ahead.")


def test_speaking_rate_is_learned_from_completed_replies():
    h = InterruptionHistory(RATE, chars_per_second=14.0)
    reply(h, "r1", text="x" * 200, seconds=10.0, done="completed")  # 20 chars per second
    assert 14.0 < h.chars_per_second < 20.0


def test_events_for_unknown_responses_are_ignored():
    h = InterruptionHistory(RATE)
    assert h.observe(audio("ghost", 1.0), lambda r: 0.0) == []
    assert h.observe({"type": "input_audio_buffer.speech_started"}, lambda r: 1.0) == []


@pytest.mark.parametrize(("fraction", "expected"), [
    (1.0, "One two three, four five."),
    (0.0, ""),
    (0.5, "One two"),        # cut inside "three": never claim a word that was not fully heard
    (0.56, "One two three"),  # cut after "three,": trailing comma trimmed
    (0.3, "One two"),
])
def test_heard_prefix_stops_at_whole_words(fraction, expected):
    assert heard_prefix("One two three, four five.", fraction) == expected


@pytest.mark.parametrize(("text", "expected"), [
    ("That's a fascinating", ""),
    ("That's fascinating. Do you think", "That's fascinating."),
    ("Really? I had no idea. So", "Really? I had no idea."),
    ("It costs 3.5 dollars", ""),  # a decimal point is not a sentence end
])
def test_whole_sentences(text, expected):
    assert whole_sentences(text) == expected


def test_engine_instructions_describe_the_note():
    assert NOTE_PREFIX.startswith("(") and "note in parentheses" in ENGINE_INSTRUCTIONS
    assert "never read it aloud" in ENGINE_INSTRUCTIONS


def test_quotes_inside_the_heard_text_cannot_break_the_note():
    h = InterruptionHistory(RATE)
    reply(h, "r1", text='He said "hello" to me. Then he left the room without a word.', seconds=4.0)
    out = h.observe({"type": "response.done", "response": {"id": "r1", "status": "cancelled"}}, lambda r: 3.0)
    assert out[0]["item"]["content"][0]["text"].count('"') == 2
