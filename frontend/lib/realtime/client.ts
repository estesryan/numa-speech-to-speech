/**
 * The browser end of the voice engine's Realtime WebSocket (backend/voice-engine; OpenAI Realtime protocol).
 *
 * The session's persona is chosen by a query parameter (`persona`); the engine composes the prompt itself
 * and ignores any instructions a client sends. Audio is 16 kHz PCM16 both ways, the engine's default, so no
 * format is sent (the OpenAI schema only describes 24 kHz).
 */

import type { SessionConfig } from "@/lib/session/modes";
import type { ServerEvent } from "./interruption";

export const DEFAULT_VOICE_URL =
  process.env.NEXT_PUBLIC_NUMA_VOICE_URL ?? "ws://127.0.0.1:8765/v1/realtime";

export type RealtimeErrorCode =
  | "backend-unavailable"
  | "session-busy"
  | "connection-lost"
  | "backend-error";

export class RealtimeError extends Error {
  constructor(
    readonly code: RealtimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RealtimeError";
  }
}

export const SESSION_UPDATE = {
  type: "session.update",
  session: {
    type: "realtime",
    extensions: ["speech_to_speech.input_audio_transcription.snapshot"],
    audio: {
      input: {
        turn_detection: { type: "server_vad", interrupt_response: true },
      },
      output: {},
    },
  },
} as const;

export function voiceUrl(
  config: SessionConfig,
  base = DEFAULT_VOICE_URL,
): string {
  const url = new URL(base);
  url.searchParams.set("persona", config.persona);
  return url.toString();
}

export interface RealtimeConnection {
  send(event: object): void;
  onEvent(listener: (event: ServerEvent) => void): void;
  /** Called once if the connection drops; not after close(). */
  onLost(listener: (error: RealtimeError) => void): void;
  close(): void;
}

export type SocketFactory = (url: string, protocols: string[]) => WebSocket;

const browserSocket: SocketFactory = (url, protocols) =>
  new WebSocket(url, protocols);

/** Open a session: resolves after `session.created` and the session update, rejects with a RealtimeError. */
export function connectRealtime(
  url: string,
  {
    socket = browserSocket,
    timeoutMs = 15000,
  }: { socket?: SocketFactory; timeoutMs?: number } = {},
): Promise<RealtimeConnection> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = socket(url, ["realtime"]);
    } catch {
      reject(unavailable(url));
      return;
    }
    let ready = false;
    let closedByUs = false;
    let listener: ((event: ServerEvent) => void) | null = null;
    let lostListener: ((error: RealtimeError) => void) | null = null;
    const timer = setTimeout(() => fail(unavailable(url)), timeoutMs);

    function fail(error: RealtimeError) {
      clearTimeout(timer);
      closedByUs = true;
      ws.close();
      reject(error);
    }

    ws.onmessage = (message: MessageEvent) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(message.data)) as ServerEvent;
      } catch {
        return;
      }
      if (ready) {
        listener?.(event);
        return;
      }
      if (event.type === "session.created") {
        ready = true;
        clearTimeout(timer);
        ws.send(JSON.stringify(SESSION_UPDATE));
        resolve({
          send: (e) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(e));
            }
          },
          onEvent: (l) => {
            listener = l;
          },
          onLost: (l) => {
            lostListener = l;
          },
          close: () => {
            closedByUs = true;
            ws.close();
          },
        });
      } else if (event.type === "error") {
        const detail = event.error as
          | { type?: string; message?: string }
          | undefined;
        fail(
          detail?.type === "session_limit_reached"
            ? new RealtimeError(
                "session-busy",
                "The voice engine is already in a conversation (one at a time). End it, then try again.",
              )
            : new RealtimeError(
                "backend-error",
                detail?.message ?? "The voice engine refused the session.",
              ),
        );
      }
    };
    ws.onclose = () => {
      if (!ready) {
        if (!closedByUs) {
          clearTimeout(timer);
          reject(unavailable(url));
        }
        return;
      }
      if (!closedByUs) {
        closedByUs = true;
        lostListener?.(
          new RealtimeError(
            "connection-lost",
            "The connection to the voice engine was lost.",
          ),
        );
      }
    };
  });
}

/**
 * Why the engine could not be reached. A refused handshake (origin not allowed) and a stopped engine look the same
 * to the browser, so the message names both causes.
 */
export function unreachableMessage(where: string): string {
  const page =
    typeof window === "undefined" ? "this page" : window.location.origin;
  return (
    `Couldn't connect to the voice engine at ${where}. Start it with \`uv run numa-voice serve\` in ` +
    `backend/voice-engine, or, if it is running, allow ${page} in NUMA_VOICE_ALLOWED_ORIGINS and restart it.`
  );
}

function unavailable(url: string): RealtimeError {
  return new RealtimeError(
    "backend-unavailable",
    unreachableMessage(url.split("?")[0]),
  );
}
