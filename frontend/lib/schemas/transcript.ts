/**
 * Transcript events, produced from the voice engine's Realtime events by lib/realtime/transcript.ts.
 *
 * Times are milliseconds from the start of the session. The "host" speaker is the assistant (Numa).
 */

import { z } from "zod";

export const SpeakerSchema = z.enum(["user", "host"]);
export type Speaker = z.infer<typeof SpeakerSchema>;

const entryId = z.string().trim().min(1).max(128);
const sessionTimeMs = z.number().int().nonnegative();

export const EntryStartedSchema = z.object({
  type: z.literal("entry.started"),
  entryId,
  speaker: SpeakerSchema,
  /** Display name, e.g. the assistant's name. */
  speakerName: z.string().trim().min(1).max(80).optional(),
  atMs: sessionTimeMs,
});

export const EntryDeltaSchema = z.object({
  type: z.literal("entry.delta"),
  entryId,
  /** Text appended to the entry, as recognized so far. */
  text: z.string().min(1).max(4000),
  atMs: sessionTimeMs,
});

export const EntryCompletedSchema = z.object({
  type: z.literal("entry.completed"),
  entryId,
  /** Optional final text that replaces the streamed text (recognizers often revise their output). */
  text: z.string().max(20000).optional(),
  atMs: sessionTimeMs,
});

/** Replaces a streaming entry's text (recognizers send cumulative, revisable hypotheses). */
export const EntrySnapshotSchema = z.object({
  type: z.literal("entry.snapshot"),
  entryId,
  text: z.string().max(20000),
  atMs: sessionTimeMs,
});

/** The speaker was cut off: keep only the words actually heard (a prefix of the current text) and finalize. */
export const EntryTruncatedSchema = z.object({
  type: z.literal("entry.truncated"),
  entryId,
  text: z.string().max(20000),
  atMs: sessionTimeMs,
});

export const TranscriptEventSchema = z.discriminatedUnion("type", [
  EntryStartedSchema,
  EntryDeltaSchema,
  EntrySnapshotSchema,
  EntryCompletedSchema,
  EntryTruncatedSchema,
]);
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;

export type ParseResult =
  | { ok: true; event: TranscriptEvent }
  | { ok: false; error: string };

/** Validate an untrusted event (e.g. a parsed WebSocket message). */
export function parseTranscriptEvent(input: unknown): ParseResult {
  const result = TranscriptEventSchema.safeParse(input);
  return result.success
    ? { ok: true, event: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}

export interface TranscriptEntry {
  id: string;
  speaker: Speaker;
  speakerName: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  text: string;
  status: "streaming" | "final";
  /** The speaker was interrupted; `text` holds only what was heard. */
  interrupted?: boolean;
}

/**
 * Apply one validated event. Unknown entries, duplicates, and deltas after completion are ignored rather than
 * invented, so a misbehaving backend can never create transcript text the user did not see streamed.
 */
export function applyTranscriptEvent(
  entries: readonly TranscriptEntry[],
  event: TranscriptEvent,
): TranscriptEntry[] {
  const index = entries.findIndex((e) => e.id === event.entryId);
  switch (event.type) {
    case "entry.started":
      if (index !== -1) {
        return [...entries];
      }
      return [
        ...entries,
        {
          id: event.entryId,
          speaker: event.speaker,
          speakerName: event.speakerName ?? null,
          startedAtMs: event.atMs,
          endedAtMs: null,
          text: "",
          status: "streaming",
        },
      ];
    case "entry.delta": {
      const entry = entries[index];
      if (!entry || entry.status === "final") {
        return [...entries];
      }
      return entries.map((e, i) =>
        i === index ? { ...e, text: e.text + event.text } : e,
      );
    }
    case "entry.snapshot": {
      const entry = entries[index];
      if (!entry || entry.status === "final") {
        return [...entries];
      }
      return entries.map((e, i) =>
        i === index ? { ...e, text: event.text } : e,
      );
    }
    case "entry.truncated": {
      const entry = entries[index];
      if (!entry || !entry.text.startsWith(event.text)) {
        return [...entries];
      }
      return entries.map((e, i) =>
        i === index
          ? {
              ...e,
              text: event.text,
              status: "final",
              interrupted: true,
              endedAtMs: e.endedAtMs ?? event.atMs,
            }
          : e,
      );
    }
    case "entry.completed": {
      const entry = entries[index];
      if (!entry || entry.status === "final") {
        return [...entries];
      }
      return entries.map((e, i) =>
        i === index
          ? {
              ...e,
              text: event.text ?? e.text,
              status: "final",
              endedAtMs: event.atMs,
            }
          : e,
      );
    }
  }
}
