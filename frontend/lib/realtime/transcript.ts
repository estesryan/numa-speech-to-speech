/**
 * Turns the voice engine's Realtime events into transcript events (lib/schemas/transcript.ts).
 *
 * User entries start at their first recognized words and are timed from `speech_started`; they stream cumulative
 * snapshots and finish with the final recognition. Assistant entries appear once a reply's audio arrives (speculative
 * drafts the engine abandons unvoiced never show), stream its text, and finish when the response is done or the
 * next one begins; if the user cuts the assistant off, the entry keeps only the words that were heard.
 */

import type { TranscriptEvent } from "@/lib/schemas/transcript";
import type { ServerEvent } from "./interruption";

export interface Speakers {
  host: string;
  guest: string | null;
}

export class TranscriptAdapter {
  private readonly speechStart = new Map<string, number>();
  private readonly started = new Set<string>();
  private readonly openHost = new Set<string>();
  private readonly pendingText = new Map<string, string>();

  constructor(
    private readonly speakers: Speakers,
    private readonly now: () => number,
  ) {}

  private start(
    entryId: string,
    speaker: "user" | "host",
    atMs: number,
  ): TranscriptEvent[] {
    if (this.started.has(entryId)) {
      return [];
    }
    this.started.add(entryId);
    const speakerName =
      speaker === "host"
        ? this.speakers.host
        : (this.speakers.guest ?? undefined);
    return [{ type: "entry.started", entryId, speaker, speakerName, atMs }];
  }

  handle(event: ServerEvent): TranscriptEvent[] {
    const atMs = Math.max(0, Math.round(this.now()));
    const itemId = typeof event.item_id === "string" ? event.item_id : null;
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        if (itemId) {
          this.speechStart.set(itemId, atMs);
        }
        return [];
      case "speech_to_speech.input_audio_transcription.snapshot":
      case "conversation.item.input_audio_transcription.delta": {
        const text = String(
          event.type.endsWith("snapshot")
            ? (event.transcript ?? "")
            : (event.delta ?? ""),
        );
        if (!itemId || !text.trim()) {
          return [];
        }
        const entryId = `user:${itemId}`;
        const update: TranscriptEvent = event.type.endsWith("snapshot")
          ? { type: "entry.snapshot", entryId, text: text.trim(), atMs }
          : { type: "entry.delta", entryId, text, atMs };
        return [
          ...this.start(entryId, "user", this.speechStart.get(itemId) ?? atMs),
          update,
        ];
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(event.transcript ?? "").trim();
        if (!itemId || (!text && !this.started.has(`user:${itemId}`))) {
          return [];
        }
        const entryId = `user:${itemId}`;
        return [
          ...this.start(entryId, "user", this.speechStart.get(itemId) ?? atMs),
          { type: "entry.completed", entryId, text: text || undefined, atMs },
        ];
      }
      case "response.created": {
        const out: TranscriptEvent[] = [...this.openHost].map((entryId) => ({
          type: "entry.completed" as const,
          entryId,
          atMs,
        }));
        this.openHost.clear();
        return out;
      }
      case "response.output_audio_transcript.delta": {
        const rid = event.response_id;
        if (!rid || !event.delta) {
          return [];
        }
        const entryId = `host:${rid}`;
        if (!this.started.has(entryId)) {
          this.pendingText.set(
            rid,
            (this.pendingText.get(rid) ?? "") + event.delta,
          );
          return [];
        }
        return [{ type: "entry.delta", entryId, text: event.delta, atMs }];
      }
      case "response.output_audio.delta": {
        const rid = event.response_id;
        const entryId = `host:${rid}`;
        if (!rid || this.started.has(entryId)) {
          return [];
        }
        this.openHost.add(entryId);
        const text = this.pendingText.get(rid);
        this.pendingText.delete(rid);
        return [
          ...this.start(entryId, "host", atMs),
          ...(text
            ? [{ type: "entry.delta" as const, entryId, text, atMs }]
            : []),
        ];
      }
      case "response.done": {
        const entryId = `host:${event.response?.id}`;
        this.pendingText.delete(String(event.response?.id));
        if (
          !this.openHost.has(entryId) ||
          event.response?.status === "cancelled"
        ) {
          return []; // a cancelled reply is finalized by interrupted()
        }
        this.openHost.delete(entryId);
        return [{ type: "entry.completed", entryId, atMs }];
      }
      default:
        return [];
    }
  }

  /** The user cut the assistant off: keep only the words they heard. */
  interrupted(responseId: string, heard: string): TranscriptEvent[] {
    const entryId = `host:${responseId}`;
    if (!this.started.has(entryId)) {
      return [];
    }
    this.openHost.delete(entryId);
    return [
      {
        type: "entry.truncated",
        entryId,
        text: heard,
        atMs: Math.max(0, Math.round(this.now())),
      },
    ];
  }
}
