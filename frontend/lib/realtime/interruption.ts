/**
 * Keep the voice engine's history true to what the user heard when they interrupt the assistant.
 *
 * A port of backend/voice-engine/numa_voice/interruption.py (read its docstring for the why). Upstream cancels an
 * interrupted reply but drops it from its history, and only the client knows how much audio was played. So when
 * the assistant is cut off, the unheard reply is deleted (if it was already finalized) and a note quoting the complete
 * sentences the user heard is added on the user's side. Both implementations replay the same event traces
 * (backend/voice-engine/tests/fixtures/traces/); keep them in step.
 */

export const NOTE_PREFIX = "(The guest interrupts you.";
const NOTE_FEW_WORDS = `${NOTE_PREFIX} They cut you off before you finished your first sentence.)`;
const NOTE_NOTHING_HEARD = `${NOTE_PREFIX} They had not heard your reply yet.)`;

/** A Realtime server event, loosely typed: only the fields used here are read. */
export interface ServerEvent {
  type: string;
  response_id?: string;
  response?: { id?: string; status?: string };
  item?: { id?: string };
  delta?: string;
  transcript?: string;
  [key: string]: unknown;
}

export type ClientEvent =
  | { type: "conversation.item.delete"; item_id: string }
  | {
      type: "conversation.item.create";
      item: {
        type: "message";
        role: "user";
        content: { type: "input_text"; text: string }[];
      };
    };

interface Reply {
  id: string;
  text: string;
  audioBytes: number;
  audioDone: boolean;
  itemId: string | null;
  status: string | null;
}

function base64Length(data: string): number {
  if (!data) {
    return 0;
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** The words of `text` spoken by the time `fraction` of it has been played (rounded down to whole words). */
export function heardPrefix(text: string, fraction: number): string {
  if (fraction >= 0.98) {
    return text.trim();
  }
  const cut = Math.floor(text.length * Math.max(0, fraction));
  let prefix = text.slice(0, cut);
  if (cut < text.length && !isSpace(text[cut])) {
    const space = prefix.lastIndexOf(" ");
    prefix = space === -1 ? "" : prefix.slice(0, space);
  }
  return prefix.trim().replace(/[\s,;:]+$/, "");
}

/** `text` up to its last complete sentence ("" if none is complete). */
export function wholeSentences(text: string): string {
  let end = -1;
  for (const match of text.matchAll(/[.!?](?=\s|$)/g)) {
    end = (match.index ?? 0) + 1;
  }
  return end === -1 ? "" : text.slice(0, end).trim();
}

export function interruptionNote(heard: string): ClientEvent {
  const sentences = wholeSentences(heard);
  const text = sentences
    ? `${NOTE_PREFIX} They heard you say: "${sentences.replaceAll('"', "'")}" Then they cut you off.)`
    : heard
      ? NOTE_FEW_WORDS
      : NOTE_NOTHING_HEARD;
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };
}

export interface InterruptionHistoryOptions {
  sampleRate?: number;
  charsPerSecond?: number;
  minHeardS?: number;
  /** Called once per interrupted reply with the words the user heard (for the transcript). */
  onInterrupted?: (responseId: string, heard: string) => void;
}

export class InterruptionHistory {
  readonly sampleRate: number;
  charsPerSecond: number;
  readonly minHeardS: number;
  private readonly replies = new Map<string, Reply>();
  private lastSpoken: string | null = null;
  private readonly heardAtBarge = new Map<string, number>();
  private readonly handled = new Set<string>();
  private readonly onInterrupted?: (responseId: string, heard: string) => void;

  constructor({
    sampleRate = 16000,
    charsPerSecond = 14,
    minHeardS = 0.3,
    onInterrupted,
  }: InterruptionHistoryOptions = {}) {
    this.sampleRate = sampleRate;
    this.charsPerSecond = charsPerSecond;
    this.minHeardS = minHeardS;
    this.onInterrupted = onInterrupted;
  }

  private audioS(reply: Reply): number {
    return reply.audioBytes / 2 / this.sampleRate;
  }

  private heardWords(reply: Reply, heardS: number): string {
    if (heardS < this.minHeardS) {
      return "";
    }
    const fraction =
      reply.audioDone && reply.audioBytes
        ? heardS / this.audioS(reply)
        : // audio not fully generated yet: estimate from this session's speaking rate
          (heardS * this.charsPerSecond) / Math.max(1, reply.text.length);
    return heardPrefix(reply.text, Math.min(1, fraction));
  }

  private interrupt(reply: Reply, heardS: number): ClientEvent {
    this.handled.add(reply.id);
    const heard = this.heardWords(reply, heardS);
    this.onInterrupted?.(reply.id, heard);
    return interruptionNote(heard);
  }

  /** Update state with one server event; return the events to send back (usually none). */
  observe(
    event: ServerEvent,
    playedS: (responseId: string) => number,
  ): ClientEvent[] {
    const kind = event.type;
    const rid = event.response_id ?? event.response?.id;
    const reply = rid ? this.replies.get(rid) : undefined;

    if (kind === "response.created" && rid) {
      this.replies.set(rid, {
        id: rid,
        text: "",
        audioBytes: 0,
        audioDone: false,
        itemId: null,
        status: null,
      });
    } else if (reply === undefined && kind.startsWith("response.")) {
      return [];
    } else if (reply && kind === "response.output_item.added") {
      reply.itemId = event.item?.id ?? reply.itemId;
    } else if (reply && kind === "response.output_audio_transcript.delta") {
      reply.text += event.delta ?? "";
    } else if (reply && kind === "response.output_audio_transcript.done") {
      reply.text = event.transcript || reply.text;
    } else if (reply && kind === "response.output_audio.delta") {
      reply.audioBytes += base64Length(event.delta ?? "");
      this.lastSpoken = reply.id;
    } else if (reply && kind === "response.output_audio.done") {
      reply.audioDone = true;
    } else if (kind === "input_audio_buffer.speech_started") {
      // runs before the client clears its playback, so the playback position is still known
      const target = this.lastSpoken
        ? this.replies.get(this.lastSpoken)
        : undefined;
      if (!target || this.handled.has(target.id) || !target.audioBytes) {
        return [];
      }
      const heard = playedS(target.id);
      if (target.status === null) {
        // still generating: upstream will cancel it; finish on response.done
        this.heardAtBarge.set(target.id, heard);
      } else if (
        target.status === "completed" &&
        target.audioDone &&
        heard < this.audioS(target) - 0.3
      ) {
        // finalized in full, but the user stopped listening part-way: remove it, quote what was heard
        const remove: ClientEvent[] = target.itemId
          ? [{ type: "conversation.item.delete", item_id: target.itemId }]
          : [];
        return [...remove, this.interrupt(target, heard)];
      }
    } else if (reply && kind === "response.done") {
      reply.status = event.response?.status ?? null;
      const heard = this.heardAtBarge.get(reply.id);
      this.heardAtBarge.delete(reply.id);
      if (
        reply.status === "completed" &&
        reply.audioDone &&
        reply.audioBytes &&
        reply.text.length > 20
      ) {
        // learn this voice's speaking rate (characters per second of audio) for in-flight estimates
        this.charsPerSecond =
          0.7 * this.charsPerSecond +
          0.3 * (reply.text.length / this.audioS(reply));
      }
      if (
        reply.status === "cancelled" &&
        reply.audioBytes &&
        !this.handled.has(reply.id)
      ) {
        // upstream already removed the reply and sends this before speech_started: take the position now
        return [this.interrupt(reply, heard ?? playedS(reply.id))];
      }
    }
    return [];
  }
}
