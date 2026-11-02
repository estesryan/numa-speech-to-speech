import { describe, expect, it } from "vitest";
import {
  applyTranscriptEvent,
  parseTranscriptEvent,
  type TranscriptEntry,
  type TranscriptEvent,
} from "@/lib/schemas/transcript";

function parsed(input: unknown): TranscriptEvent {
  const result = parseTranscriptEvent(input);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.event;
}

describe("transcript event schemas", () => {
  it("accepts well-formed started, delta and completed events", () => {
    expect(
      parsed({
        type: "entry.started",
        entryId: "u1",
        speaker: "user",
        atMs: 0,
      }),
    ).toMatchObject({
      type: "entry.started",
    });
    expect(
      parsed({
        type: "entry.started",
        entryId: "h1",
        speaker: "host",
        speakerName: "Taylor",
        atMs: 1200,
      }),
    ).toMatchObject({ speakerName: "Taylor" });
    expect(
      parsed({ type: "entry.delta", entryId: "u1", text: "Hello", atMs: 300 }),
    ).toMatchObject({ text: "Hello" });
    expect(
      parsed({ type: "entry.completed", entryId: "u1", atMs: 900 }),
    ).toMatchObject({ type: "entry.completed" });
  });

  it.each([
    ["unknown event type", { type: "entry.deleted", entryId: "u1", atMs: 0 }],
    [
      "unknown speaker",
      { type: "entry.started", entryId: "u1", speaker: "narrator", atMs: 0 },
    ],
    ["missing entry id", { type: "entry.started", speaker: "user", atMs: 0 }],
    [
      "blank entry id",
      { type: "entry.delta", entryId: "  ", text: "x", atMs: 0 },
    ],
    [
      "negative time",
      { type: "entry.delta", entryId: "u1", text: "x", atMs: -5 },
    ],
    [
      "fractional time",
      { type: "entry.delta", entryId: "u1", text: "x", atMs: 1.5 },
    ],
    [
      "empty delta text",
      { type: "entry.delta", entryId: "u1", text: "", atMs: 0 },
    ],
    [
      "text as number",
      { type: "entry.delta", entryId: "u1", text: 42, atMs: 0 },
    ],
    ["not an object", "entry.started"],
    ["null", null],
  ])("rejects %s", (_name, input) => {
    const result = parseTranscriptEvent(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe("applying transcript events", () => {
  const events: unknown[] = [
    { type: "entry.started", entryId: "u1", speaker: "user", atMs: 0 },
    { type: "entry.delta", entryId: "u1", text: "Tell me ", atMs: 400 },
    { type: "entry.delta", entryId: "u1", text: "about Numa", atMs: 900 },
  ];

  function replay(
    list: unknown[],
    from: TranscriptEntry[] = [],
  ): TranscriptEntry[] {
    return list.map(parsed).reduce(applyTranscriptEvent, from);
  }

  it("streams text into an entry", () => {
    const entries = replay(events);
    expect(entries).toEqual([
      {
        id: "u1",
        speaker: "user",
        speakerName: null,
        startedAtMs: 0,
        endedAtMs: null,
        text: "Tell me about Numa",
        status: "streaming",
      },
    ]);
  });

  it("finalizes an entry, optionally replacing its text with the recognizer's revision", () => {
    const final = replay(
      [
        {
          type: "entry.completed",
          entryId: "u1",
          text: "Tell me about Numa.",
          atMs: 1100,
        },
      ],
      replay(events),
    );
    expect(final[0]).toMatchObject({
      status: "final",
      text: "Tell me about Numa.",
      endedAtMs: 1100,
    });
    const kept = replay(
      [{ type: "entry.completed", entryId: "u1", atMs: 1100 }],
      replay(events),
    );
    expect(kept[0]?.text).toBe("Tell me about Numa");
  });

  it("ignores deltas for unknown or finished entries instead of inventing text", () => {
    const base = replay([
      ...events,
      { type: "entry.completed", entryId: "u1", atMs: 1000 },
    ]);
    const after = replay(
      [
        { type: "entry.delta", entryId: "u1", text: " extra", atMs: 1200 },
        { type: "entry.delta", entryId: "ghost", text: "hello", atMs: 1200 },
        { type: "entry.completed", entryId: "ghost", atMs: 1300 },
      ],
      base,
    );
    expect(after).toEqual(base);
  });

  it("ignores a duplicate start and keeps entries in arrival order", () => {
    const entries = replay([
      ...events,
      { type: "entry.started", entryId: "u1", speaker: "host", atMs: 50 },
      {
        type: "entry.started",
        entryId: "h1",
        speaker: "host",
        speakerName: "Host",
        atMs: 1500,
      },
    ]);
    expect(entries.map((e) => [e.id, e.speaker])).toEqual([
      ["u1", "user"],
      ["h1", "host"],
    ]);
  });
});
