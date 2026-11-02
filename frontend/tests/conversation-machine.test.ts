import { describe, expect, it } from "vitest";
import {
  CONVERSATION_STATUSES,
  type ConversationEvent,
  type ConversationEventType,
  type ConversationState,
  canTransition,
  conversationReducer,
  initialConversationState,
  isSessionActive,
  TRANSITIONS,
} from "@/lib/state/conversation-machine";

const error = { code: "permission-denied" as const, message: "blocked" };

function run(...events: ConversationEvent[]): ConversationState {
  return events.reduce(conversationReducer, initialConversationState);
}

const EVENTS: Record<ConversationEventType, ConversationEvent> = {
  START: { type: "START" },
  MICROPHONE_READY: { type: "MICROPHONE_READY", at: 1000 },
  MICROPHONE_FAILED: { type: "MICROPHONE_FAILED", error },
  MUTE: { type: "MUTE" },
  UNMUTE: { type: "UNMUTE" },
  PROCESSING_STARTED: { type: "PROCESSING_STARTED", source: "backend" },
  PROCESSING_ENDED: { type: "PROCESSING_ENDED", source: "backend" },
  SPEECH_STARTED: { type: "SPEECH_STARTED", source: "backend" },
  SPEECH_ENDED: { type: "SPEECH_ENDED", source: "backend" },
  FAILURE: {
    type: "FAILURE",
    error: { code: "device-lost", message: "gone" },
    at: 5000,
  },
  END: { type: "END", at: 9000 },
  RESET: { type: "RESET" },
};

/** A state value in the given status, reached through real transitions. */
const REACH: Record<
  (typeof CONVERSATION_STATUSES)[number],
  ConversationEvent[]
> = {
  idle: [],
  connecting: [EVENTS.START],
  listening: [EVENTS.START, EVENTS.MICROPHONE_READY],
  processing: [
    EVENTS.START,
    EVENTS.MICROPHONE_READY,
    EVENTS.PROCESSING_STARTED,
  ],
  speaking: [EVENTS.START, EVENTS.MICROPHONE_READY, EVENTS.SPEECH_STARTED],
  muted: [EVENTS.START, EVENTS.MICROPHONE_READY, EVENTS.MUTE],
  error: [EVENTS.START, EVENTS.MICROPHONE_FAILED],
  ended: [EVENTS.START, EVENTS.MICROPHONE_READY, EVENTS.END],
};

describe("conversation state machine", () => {
  it("starts idle", () => {
    expect(initialConversationState.status).toBe("idle");
    expect(initialConversationState.startedAt).toBeNull();
  });

  it("follows the happy path: start, microphone ready, end", () => {
    let s = run(EVENTS.START);
    expect(s.status).toBe("connecting");
    s = conversationReducer(s, EVENTS.MICROPHONE_READY);
    expect(s).toMatchObject({
      status: "listening",
      startedAt: 1000,
      error: null,
    });
    s = conversationReducer(s, EVENTS.END);
    expect(s).toMatchObject({
      status: "ended",
      startedAt: 1000,
      endedAt: 9000,
    });
  });

  it("records the microphone error when permission fails", () => {
    const s = run(EVENTS.START, EVENTS.MICROPHONE_FAILED);
    expect(s.status).toBe("error");
    expect(s.error).toEqual(error);
    expect(s.startedAt).toBeNull();
  });

  it("mutes and unmutes", () => {
    const muted = run(...REACH.muted);
    expect(muted.status).toBe("muted");
    expect(conversationReducer(muted, EVENTS.UNMUTE).status).toBe("listening");
  });

  it("only enters processing and speaking through explicit events, and records their source", () => {
    const listening = run(...REACH.listening);
    const sim = conversationReducer(listening, {
      type: "PROCESSING_STARTED",
      source: "simulation",
    });
    expect(sim).toMatchObject({ status: "processing", source: "simulation" });
    const speaking = conversationReducer(sim, {
      type: "SPEECH_STARTED",
      source: "simulation",
    });
    expect(speaking.status).toBe("speaking");
    const back = conversationReducer(speaking, {
      type: "SPEECH_ENDED",
      source: "simulation",
    });
    expect(back).toMatchObject({ status: "listening", source: null });
  });

  it("ending while the permission prompt is open ends without a session duration", () => {
    const s = run(EVENTS.START, EVENTS.END);
    expect(s).toMatchObject({
      status: "ended",
      startedAt: null,
      endedAt: null,
    });
  });

  it("a device failure mid-session keeps the session times", () => {
    const s = run(...REACH.listening, EVENTS.FAILURE);
    expect(s).toMatchObject({
      status: "error",
      startedAt: 1000,
      endedAt: 5000,
      error: { code: "device-lost" },
    });
  });

  it("a new start clears the previous session and error", () => {
    const s = run(...REACH.error, EVENTS.START);
    expect(s).toEqual({
      status: "connecting",
      startedAt: null,
      endedAt: null,
      error: null,
      source: null,
    });
  });

  it("reset returns to the initial state", () => {
    expect(run(...REACH.ended, EVENTS.RESET)).toEqual(initialConversationState);
  });

  // Every (status, event) pair: allowed pairs move to the table's target, all others are ignored unchanged.
  for (const status of CONVERSATION_STATUSES) {
    for (const type of Object.keys(EVENTS) as ConversationEventType[]) {
      const target = TRANSITIONS[status][type];
      it(`${status} + ${type} -> ${target ?? "ignored"}`, () => {
        const before = run(...REACH[status]);
        expect(before.status).toBe(status);
        const after = conversationReducer(before, EVENTS[type]);
        if (target === undefined) {
          expect(after).toBe(before);
          expect(canTransition(status, type)).toBe(false);
        } else {
          expect(after.status).toBe(target);
          expect(canTransition(status, type)).toBe(true);
        }
      });
    }
  }

  it("never reaches processing or speaking from idle or before the microphone is ready", () => {
    for (const status of ["idle", "connecting", "ended", "error"] as const) {
      expect(canTransition(status, "PROCESSING_STARTED")).toBe(false);
      expect(canTransition(status, "SPEECH_STARTED")).toBe(false);
    }
  });

  it("knows which states hold an open session", () => {
    expect(CONVERSATION_STATUSES.filter(isSessionActive)).toEqual([
      "connecting",
      "listening",
      "processing",
      "speaking",
      "muted",
    ]);
  });
});
