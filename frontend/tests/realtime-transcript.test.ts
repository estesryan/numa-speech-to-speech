import { describe, expect, it } from "vitest";
import { TranscriptAdapter } from "@/lib/realtime/transcript";
import {
  applyTranscriptEvent,
  type TranscriptEntry,
} from "@/lib/schemas/transcript";

function run(
  events: object[],
  interruptions: Array<[number, string, string]> = [],
  guest: string | null = "Alex",
) {
  let t = 0;
  const adapter = new TranscriptAdapter({ host: "Numa", guest }, () => t);
  let entries: TranscriptEntry[] = [];
  events.forEach((event, i) => {
    t = i * 100;
    for (const e of adapter.handle(event as never)) {
      entries = applyTranscriptEvent(entries, e);
    }
    for (const [at, rid, heard] of interruptions) {
      if (at === i) {
        for (const e of adapter.interrupted(rid, heard)) {
          entries = applyTranscriptEvent(entries, e);
        }
      }
    }
  });
  return entries;
}

const audio = (rid: string) => ({
  type: "response.output_audio.delta",
  response_id: rid,
  delta: "AAAA",
});

describe("TranscriptAdapter", () => {
  it("labels both speakers in order, with partial and final text", () => {
    const entries = run([
      { type: "input_audio_buffer.speech_started", item_id: "u1" },
      {
        type: "speech_to_speech.input_audio_transcription.snapshot",
        item_id: "u1",
        transcript: "Hello ther",
      },
      {
        type: "speech_to_speech.input_audio_transcription.snapshot",
        item_id: "u1",
        transcript: "Hello there",
      },
      {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u1",
        transcript: "Hello there.",
      },
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_audio_transcript.delta",
        response_id: "r1",
        delta: "Hi Alex!",
      },
      audio("r1"),
      {
        type: "response.output_audio_transcript.delta",
        response_id: "r1",
        delta: " How are you?",
      },
      { type: "response.done", response: { id: "r1", status: "completed" } },
    ]);
    expect(
      entries.map((e) => [e.speaker, e.speakerName, e.text, e.status]),
    ).toEqual([
      ["user", "Alex", "Hello there.", "final"],
      ["host", "Numa", "Hi Alex! How are you?", "final"],
    ]);
    expect(entries[0]?.startedAtMs).toBe(0); // timed from speech start, not from the first words
  });

  it("shows partial user text while they speak", () => {
    const entries = run([
      { type: "input_audio_buffer.speech_started", item_id: "u1" },
      {
        type: "speech_to_speech.input_audio_transcription.snapshot",
        item_id: "u1",
        transcript: "So I was",
      },
    ]);
    expect(entries).toMatchObject([{ text: "So I was", status: "streaming" }]);
  });

  it("never shows a draft reply the engine abandoned before speaking it", () => {
    const entries = run([
      { type: "response.created", response: { id: "draft" } },
      {
        type: "response.output_audio_transcript.delta",
        response_id: "draft",
        delta: "Unspoken draft",
      },
      { type: "response.created", response: { id: "r2" } },
      {
        type: "response.output_audio_transcript.delta",
        response_id: "r2",
        delta: "Spoken.",
      },
      audio("r2"),
    ]);
    expect(entries.map((e) => e.text)).toEqual(["Spoken."]);
  });

  it("keeps only the words heard when Numa is interrupted", () => {
    const entries = run(
      [
        { type: "response.created", response: { id: "r1" } },
        {
          type: "response.output_audio_transcript.delta",
          response_id: "r1",
          delta: "That is fascinating. Why do you",
        },
        audio("r1"),
        { type: "response.done", response: { id: "r1", status: "cancelled" } },
      ],
      [[3, "r1", "That is fascinating."]],
    );
    expect(entries).toMatchObject([
      { text: "That is fascinating.", status: "final", interrupted: true },
    ]);
  });

  it("names the user 'You' when no name was given", () => {
    const entries = run(
      [
        {
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "u1",
          transcript: "Hi.",
        },
      ],
      [],
      null,
    );
    expect(entries[0]?.speakerName).toBeNull();
  });

  it("ignores speech with no recognized words", () => {
    expect(
      run([
        { type: "input_audio_buffer.speech_started", item_id: "u1" },
        {
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "u1",
          transcript: "",
        },
      ]),
    ).toEqual([]);
  });
});

describe("transcript reducer: truncation", () => {
  it("only ever shortens to a prefix of what was shown", () => {
    let entries: TranscriptEntry[] = [];
    entries = applyTranscriptEvent(entries, {
      type: "entry.started",
      entryId: "h",
      speaker: "host",
      atMs: 0,
    });
    entries = applyTranscriptEvent(entries, {
      type: "entry.delta",
      entryId: "h",
      text: "One two three",
      atMs: 1,
    });
    const invented = applyTranscriptEvent(entries, {
      type: "entry.truncated",
      entryId: "h",
      text: "Something new",
      atMs: 2,
    });
    expect(invented[0]?.text).toBe("One two three");
    const cut = applyTranscriptEvent(entries, {
      type: "entry.truncated",
      entryId: "h",
      text: "One two",
      atMs: 2,
    });
    expect(cut[0]).toMatchObject({
      text: "One two",
      interrupted: true,
      status: "final",
    });
  });
});
