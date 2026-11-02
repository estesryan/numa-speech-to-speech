/**
 * The conversation state machine. Every allowed transition is listed in TRANSITIONS; any other event is ignored
 * (the reducer returns the same state object), so the UI can never reach a state by accident.
 *
 * `processing` and `speaking` are only entered through explicit events: from the voice engine (`source:
 * "backend"`), or from the development-only simulation (`source: "simulation"`) when no engine is used.
 */

export const CONVERSATION_STATUSES = [
  "idle",
  "connecting",
  "listening",
  "processing",
  "speaking",
  "muted",
  "error",
  "ended",
] as const;

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export type EventSource = "backend" | "simulation";

export type MicrophoneErrorCode =
  | "unsupported"
  | "insecure-context"
  | "permission-denied"
  | "no-device"
  | "device-busy"
  | "device-lost"
  | "unknown";

/** Voice-engine connection failures (lib/realtime/client.ts). */
export type ConnectionErrorCode =
  | "backend-unavailable"
  | "session-busy"
  | "connection-lost"
  | "backend-error";

export type ConversationErrorCode = MicrophoneErrorCode | ConnectionErrorCode;

export interface ConversationError {
  code: ConversationErrorCode;
  message: string;
}

export type ConversationEvent =
  | { type: "START" }
  | { type: "MICROPHONE_READY"; at: number }
  | { type: "MICROPHONE_FAILED"; error: ConversationError }
  | { type: "MUTE" }
  | { type: "UNMUTE" }
  | { type: "PROCESSING_STARTED"; source: EventSource }
  | { type: "PROCESSING_ENDED"; source: EventSource }
  | { type: "SPEECH_STARTED"; source: EventSource }
  | { type: "SPEECH_ENDED"; source: EventSource }
  | { type: "FAILURE"; error: ConversationError; at: number }
  | { type: "END"; at: number }
  | { type: "RESET" };

export type ConversationEventType = ConversationEvent["type"];

export interface ConversationState {
  status: ConversationStatus;
  /** Wall-clock start of the microphone session (ms since epoch), set when the microphone is ready. */
  startedAt: number | null;
  /** Wall-clock end of the last session, kept so the final duration can still be shown. */
  endedAt: number | null;
  error: ConversationError | null;
  /** Where the current processing / speaking state came from; null in every other state. */
  source: EventSource | null;
}

export const initialConversationState: ConversationState = {
  status: "idle",
  startedAt: null,
  endedAt: null,
  error: null,
  source: null,
};

/** Allowed transitions: status -> event type -> next status. */
export const TRANSITIONS: Readonly<
  Record<
    ConversationStatus,
    Partial<Record<ConversationEventType, ConversationStatus>>
  >
> = {
  idle: { START: "connecting" },
  connecting: {
    MICROPHONE_READY: "listening",
    MICROPHONE_FAILED: "error",
    FAILURE: "error",
    END: "ended",
  },
  listening: {
    MUTE: "muted",
    PROCESSING_STARTED: "processing",
    SPEECH_STARTED: "speaking",
    FAILURE: "error",
    END: "ended",
  },
  processing: {
    SPEECH_STARTED: "speaking",
    PROCESSING_ENDED: "listening",
    MUTE: "muted",
    FAILURE: "error",
    END: "ended",
  },
  speaking: {
    SPEECH_ENDED: "listening",
    MUTE: "muted",
    FAILURE: "error",
    END: "ended",
  },
  muted: { UNMUTE: "listening", FAILURE: "error", END: "ended" },
  error: { START: "connecting", RESET: "idle" },
  ended: { START: "connecting", RESET: "idle" },
};

export function canTransition(
  status: ConversationStatus,
  event: ConversationEventType,
): boolean {
  return TRANSITIONS[status][event] !== undefined;
}

/** States in which a microphone session is open (or being opened). */
export function isSessionActive(status: ConversationStatus): boolean {
  return (
    status === "connecting" ||
    status === "listening" ||
    status === "processing" ||
    status === "speaking" ||
    status === "muted"
  );
}

export function conversationReducer(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  const next = TRANSITIONS[state.status][event.type];
  if (next === undefined) {
    return state;
  }
  switch (event.type) {
    case "START":
      return {
        status: next,
        startedAt: null,
        endedAt: null,
        error: null,
        source: null,
      };
    case "MICROPHONE_READY":
      return {
        ...state,
        status: next,
        startedAt: event.at,
        error: null,
        source: null,
      };
    case "MICROPHONE_FAILED":
      return { ...state, status: next, error: event.error, source: null };
    case "FAILURE":
      return {
        ...state,
        status: next,
        error: event.error,
        source: null,
        endedAt: event.at,
      };
    case "PROCESSING_STARTED":
    case "SPEECH_STARTED":
      return { ...state, status: next, source: event.source };
    case "END":
      return {
        ...state,
        status: next,
        endedAt: state.startedAt === null ? null : event.at,
        source: null,
      };
    case "RESET":
      return initialConversationState;
    default:
      return { ...state, status: next, source: null };
  }
}
