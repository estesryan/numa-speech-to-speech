import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ClientEvent,
  heardPrefix,
  InterruptionHistory,
  NOTE_PREFIX,
  type ServerEvent,
  wholeSentences,
} from "@/lib/realtime/interruption";
import { PlaybackLedger } from "@/lib/realtime/playback";

// The same traces the Python implementation replays (backend/voice-engine/tests/test_audio_client.py).
const TRACES = join(
  __dirname,
  "../../backend/voice-engine/tests/fixtures/traces",
);

interface Trace {
  description: string;
  sample_rate: number;
  steps: Array<
    { event: ServerEvent & { seconds?: number } } | { play_s: number }
  >;
  expected: ClientEvent[];
}

/** Replays a trace: the ledger stands in for the browser's playback clock; clears mirror the studio's handling. */
function replay(trace: Trace): ClientEvent[] {
  const ledger = new PlaybackLedger(trace.sample_rate);
  const history = new InterruptionHistory({ sampleRate: trace.sample_rate });
  let played = 0;
  const sent: ClientEvent[] = [];
  for (const step of trace.steps) {
    if ("play_s" in step) {
      played += Math.round(step.play_s * trace.sample_rate);
      ledger.setPlayed(played);
      continue;
    }
    const { seconds, ...event } = step.event;
    if (event.type === "response.output_audio.delta") {
      const samples = Math.round((seconds ?? 0) * trace.sample_rate);
      event.delta = btoa("\0".repeat(samples * 2));
      sent.push(...history.observe(event, (rid) => ledger.playedSeconds(rid)));
      ledger.append(String(event.response_id), samples);
      continue;
    }
    sent.push(...history.observe(event, (rid) => ledger.playedSeconds(rid)));
    if (
      event.type === "input_audio_buffer.speech_started" ||
      (event.type === "response.done" && event.response?.status === "cancelled")
    ) {
      ledger.clear();
      played = 0;
    }
  }
  return sent;
}

describe("interruption traces shared with the voice engine", () => {
  const files = readdirSync(TRACES).filter((f) => f.endsWith(".json"));

  it("covers the required cases", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)("%s", (file) => {
    const trace = JSON.parse(readFileSync(join(TRACES, file), "utf8")) as Trace;
    expect(replay(trace), trace.description).toEqual(trace.expected);
  });
});

describe("heard text", () => {
  it.each([
    [1.0, "One two three, four five."],
    [0.0, ""],
    [0.5, "One two"],
    [0.56, "One two three"],
    [0.3, "One two"],
  ])("heardPrefix at %s", (fraction, expected) => {
    expect(heardPrefix("One two three, four five.", fraction)).toBe(expected);
  });

  it.each([
    ["That's a fascinating", ""],
    ["That's fascinating. Do you think", "That's fascinating."],
    ["Really? I had no idea. So", "Really? I had no idea."],
    ["It costs 3.5 dollars", ""],
  ])("wholeSentences(%j)", (text, expected) => {
    expect(wholeSentences(text)).toBe(expected);
  });
});

describe("InterruptionHistory", () => {
  const TEXT =
    "That is a fascinating tension to explore. Why do you think people crave longer conversations today?";

  function reply(h: InterruptionHistory, seconds = 6, audioDone = false) {
    const delta = btoa("\0".repeat(Math.round(seconds * 16000) * 2));
    for (const e of [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_item.added",
        response_id: "r1",
        item: { id: "a1" },
      },
      {
        type: "response.output_audio_transcript.done",
        response_id: "r1",
        transcript: TEXT,
      },
      { type: "response.output_audio.delta", response_id: "r1", delta },
      ...(audioDone
        ? [{ type: "response.output_audio.done", response_id: "r1" }]
        : []),
    ]) {
      h.observe(e, () => 0);
    }
  }

  it("reports the heard words for the transcript and never quotes the unheard question", () => {
    const heard: string[] = [];
    const h = new InterruptionHistory({
      onInterrupted: (_, words) => heard.push(words),
    });
    reply(h);
    const out = h.observe(
      { type: "response.done", response: { id: "r1", status: "cancelled" } },
      () => 3.5,
    );
    expect(heard).toEqual(["That is a fascinating tension to explore. Why do"]); // 3.5 s at 14 chars/s
    const note =
      out[0]?.type === "conversation.item.create"
        ? out[0].item.content[0]?.text
        : "";
    expect(note).toContain(NOTE_PREFIX);
    expect(note).not.toContain("?");
  });

  it("writes each interruption once", () => {
    const h = new InterruptionHistory();
    reply(h);
    expect(
      h.observe(
        { type: "response.done", response: { id: "r1", status: "cancelled" } },
        () => 2,
      ),
    ).toHaveLength(1);
    expect(
      h.observe({ type: "input_audio_buffer.speech_started" }, () => 2),
    ).toEqual([]);
  });

  it("leaves a fully heard reply alone", () => {
    const h = new InterruptionHistory();
    reply(h, 6, true);
    h.observe(
      { type: "response.done", response: { id: "r1", status: "completed" } },
      () => 0,
    );
    expect(
      h.observe({ type: "input_audio_buffer.speech_started" }, () => 5.9),
    ).toEqual([]);
  });
});

describe("PlaybackLedger", () => {
  it("counts dropped samples as consumed so the next reply starts clean", () => {
    const l = new PlaybackLedger(16000);
    l.append("r1", 48000);
    l.setPlayed(16000);
    expect(l.playedSeconds("r1")).toBe(1);
    l.clear();
    expect(l.consumed).toBe(l.appended);
    l.append("r2", 32000);
    l.setPlayed(8000);
    expect(l.playedSeconds("r2")).toBe(0.5);
    expect(l.playedSeconds("r1")).toBe(3); // capped at its own length
  });

  it("does not count silence played after the queue runs dry", () => {
    const l = new PlaybackLedger(16000);
    l.append("r1", 8000);
    l.setPlayed(32000);
    expect(l.consumed).toBe(8000);
  });
});
