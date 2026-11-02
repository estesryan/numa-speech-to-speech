"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { LevelSource } from "@/lib/audio/levels";
import {
  classifyMicrophoneError,
  type MicrophoneSession,
  openMicrophone,
} from "@/lib/audio/microphone";
import type { ModelConnectionStatus } from "@/lib/backend/model-status";
import { RealtimeError } from "@/lib/realtime/client";
import type {
  SessionInfo,
  VoiceActivity,
  VoiceFactory,
  VoiceSessionHandle,
} from "@/lib/realtime/voice-session";
import {
  applyTranscriptEvent,
  type TranscriptEntry,
  type TranscriptEvent,
} from "@/lib/schemas/transcript";
import type { SessionConfig } from "@/lib/session/modes";
import {
  type ConversationEvent,
  type ConversationState,
  conversationReducer,
  type EventSource,
  initialConversationState,
  isSessionActive,
} from "@/lib/state/conversation-machine";

export interface ConversationControls {
  state: ConversationState;
  /** Live microphone levels while a session is open; null otherwise. */
  inputLevels: LevelSource | null;
  /** Levels of the assistant's speech output while connected to the voice engine; null otherwise. */
  outputLevels: LevelSource | null;
  deviceLabel: string | null;
  /** Connection to the voice engine ("not-connected" in preview mode). */
  connection: ModelConnectionStatus;
  transcript: readonly TranscriptEntry[];
  /** What the engine reported for the running session (its voice); null otherwise. */
  sessionInfo: SessionInfo | null;
  /** The assistant's voice is silenced (the session carries on). */
  outputMuted: boolean;
  /** The browser holds back the assistant's audio until the user clicks something (see resumeAudio). */
  audioBlocked: boolean;
  start: () => Promise<void>;
  end: () => void;
  toggleMute: () => void;
  toggleOutputMute: () => void;
  /** Call from a click: lets the browser play the assistant's audio. */
  resumeAudio: () => void;
  reset: () => void;
  /** Empty the displayed transcript; the session and the engine's conversation history are untouched. */
  clearTranscript: () => void;
  /** Development-only: drive processing / speaking without a voice engine. Undefined otherwise. */
  simulate?: (event: "processing" | "speaking" | "done") => void;
}

export interface UseConversationOptions {
  open?: () => Promise<MicrophoneSession>;
  now?: () => number;
  /** The voice engine connection; null for a microphone-only local preview. */
  voice?: VoiceFactory | null;
  /** What to ask the voice engine for (the persona). Read when a session starts. */
  session?: SessionConfig | null;
  enableSimulation?: boolean;
}

const ACTIVITY: Record<VoiceActivity, ConversationEvent["type"]> = {
  "processing-started": "PROCESSING_STARTED",
  "processing-ended": "PROCESSING_ENDED",
  "speech-started": "SPEECH_STARTED",
  "speech-ended": "SPEECH_ENDED",
};

function transcriptReducer(
  entries: readonly TranscriptEntry[],
  action: { events: TranscriptEvent[] } | { reset: true },
): readonly TranscriptEntry[] {
  if ("reset" in action) {
    return [];
  }
  return action.events.reduce(
    applyTranscriptEvent,
    entries as TranscriptEntry[],
  );
}

export function useConversation({
  open = openMicrophone,
  now = Date.now,
  voice = null,
  session: sessionConfig = null,
  enableSimulation = process.env.NODE_ENV !== "production",
}: UseConversationOptions = {}): ConversationControls {
  const [state, dispatch] = useReducer(
    conversationReducer,
    initialConversationState,
  );
  const [transcript, dispatchTranscript] = useReducer(transcriptReducer, []);
  const [microphone, setMicrophone] = useState<MicrophoneSession | null>(null);
  const [voiceSession, setVoiceSession] = useState<VoiceSessionHandle | null>(
    null,
  );
  const [connection, setConnection] =
    useState<ModelConnectionStatus>("not-connected");
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [outputMuted, setOutputMuted] = useState(false);
  const outputMutedRef = useRef(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const microphoneRef = useRef<MicrophoneSession | null>(null);
  const voiceRef = useRef<VoiceSessionHandle | null>(null);
  const configRef = useRef(sessionConfig);
  configRef.current = sessionConfig;
  // Incremented whenever a pending start must be abandoned (End pressed, studio hidden or unmounted).
  const attemptRef = useRef(0);
  const statusRef = useRef(state.status);
  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  const release = useCallback(() => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    microphoneRef.current?.stop();
    microphoneRef.current = null;
    setVoiceSession(null);
    setMicrophone(null);
    setSessionInfo(null);
    setAudioBlocked(false);
  }, []);

  const start = useCallback(async () => {
    if (isSessionActive(statusRef.current)) {
      return;
    }
    const attempt = ++attemptRef.current;
    const current = () => attempt === attemptRef.current;
    dispatch({ type: "START" });
    dispatchTranscript({ reset: true });

    // Created synchronously, inside the click, so the browser allows its audio output.
    let pending: VoiceSessionHandle | null = null;
    if (voice && configRef.current) {
      setConnection("connecting");
      pending = voice(configRef.current, {
        onActivity: (activity) => {
          if (current()) {
            dispatch({
              type: ACTIVITY[activity],
              source: "backend",
            } as ConversationEvent);
          }
        },
        onTranscript: (events) => {
          if (current()) {
            dispatchTranscript({ events });
          }
        },
        onSessionInfo: (info) => {
          if (current()) {
            setSessionInfo(info);
          }
        },
        onAudioBlocked: (blocked) => {
          if (current()) {
            setAudioBlocked(blocked);
          }
        },
        onLost: (error) => {
          if (current()) {
            release();
            setConnection("error");
            dispatch({
              type: "FAILURE",
              error: { code: error.code, message: error.message },
              at: now(),
            });
          }
        },
      });
      pending.setOutputMuted(outputMutedRef.current);
    }

    let opened: MicrophoneSession;
    try {
      opened = await open();
    } catch (error) {
      pending?.stop();
      if (current()) {
        const err = classifyMicrophoneError(error);
        setConnection("not-connected");
        dispatch({
          type: "MICROPHONE_FAILED",
          error: { code: err.code, message: err.message },
        });
      }
      return;
    }
    if (!current()) {
      // The session was ended (or the studio hidden) while the permission prompt was open.
      pending?.stop();
      opened.stop();
      return;
    }

    if (pending) {
      try {
        await pending.connect(opened);
      } catch (error) {
        pending.stop();
        opened.stop();
        if (current()) {
          const failure =
            error instanceof RealtimeError
              ? { code: error.code, message: error.message }
              : {
                  code: "backend-error" as const,
                  message: "The voice engine connection failed.",
                };
          setConnection("error");
          dispatch({ type: "FAILURE", error: failure, at: now() });
        }
        return;
      }
      if (!current()) {
        pending.stop();
        opened.stop();
        return;
      }
      setConnection("connected");
    }

    opened.onDeviceLost(() => {
      if (microphoneRef.current !== opened) {
        return;
      }
      release();
      setConnection("not-connected");
      dispatch({
        type: "FAILURE",
        error: {
          code: "device-lost",
          message: "The microphone was disconnected.",
        },
        at: now(),
      });
    });
    microphoneRef.current = opened;
    voiceRef.current = pending;
    setMicrophone(opened);
    setVoiceSession(pending);
    dispatch({ type: "MICROPHONE_READY", at: now() });
  }, [open, now, voice, release]);

  const end = useCallback(() => {
    attemptRef.current++;
    release();
    setConnection("not-connected");
    dispatch({ type: "END", at: now() });
  }, [now, release]);

  const toggleMute = useCallback(() => {
    const current = microphoneRef.current;
    if (!current) {
      return;
    }
    if (statusRef.current === "muted") {
      current.setMuted(false);
      dispatch({ type: "UNMUTE" });
    } else if (
      statusRef.current === "listening" ||
      statusRef.current === "processing" ||
      statusRef.current === "speaking"
    ) {
      current.setMuted(true);
      dispatch({ type: "MUTE" });
    }
  }, []);

  const toggleOutputMute = useCallback(() => {
    outputMutedRef.current = !outputMutedRef.current;
    voiceRef.current?.setOutputMuted(outputMutedRef.current);
    setOutputMuted(outputMutedRef.current);
  }, []);

  const resumeAudio = useCallback(() => {
    void voiceRef.current?.resumeAudio().catch(() => undefined);
  }, []);

  const reset = useCallback(() => dispatch({ type: "RESET" }), []);
  const clearTranscript = useCallback(
    () => dispatchTranscript({ reset: true }),
    [],
  );

  const simulate = useCallback((event: "processing" | "speaking" | "done") => {
    const source: EventSource = "simulation";
    if (event === "processing") {
      dispatch({ type: "PROCESSING_STARTED", source });
    } else if (event === "speaking") {
      dispatch({ type: "SPEECH_STARTED", source });
    } else {
      dispatch({ type: "SPEECH_ENDED", source });
    }
  }, []);

  // End the session when the studio is unmounted, or hidden by a route change (Next.js keeps hidden routes'
  // state, so the session must also be marked ended, not just released).
  const endRef = useRef(end);
  endRef.current = end;
  useLayoutEffect(() => () => endRef.current(), []);

  return {
    state,
    inputLevels: microphone,
    outputLevels: voiceSession?.output ?? null,
    deviceLabel: microphone?.deviceLabel ?? null,
    connection,
    sessionInfo,
    transcript,
    outputMuted,
    audioBlocked,
    start,
    end,
    toggleMute,
    toggleOutputMute,
    resumeAudio,
    reset,
    clearTranscript,
    simulate: enableSimulation && !voice ? simulate : undefined,
  };
}
