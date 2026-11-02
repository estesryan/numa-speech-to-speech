/**
 * One spoken session with the local voice engine: streams the microphone up, plays the assistant's speech, keeps the
 * engine's history true on interruptions, and reports transcript and state changes. What the session is about
 * (the persona) comes entirely from its SessionConfig.
 */

import type { LevelSource } from "@/lib/audio/levels";
import type { MicrophoneSession } from "@/lib/audio/microphone";
import type { TranscriptEvent } from "@/lib/schemas/transcript";
import type { SessionConfig } from "@/lib/session/modes";
import {
  connectRealtime,
  type RealtimeConnection,
  type RealtimeError,
  voiceUrl,
} from "./client";
import {
  base64ToBytes,
  bytesToBase64,
  floatToPcm16,
  pcm16ToFloat,
  StreamingDownsampler,
} from "./codec";
import { InterruptionHistory, type ServerEvent } from "./interruption";
import { AudioPlayback, type Playback } from "./playback";
import { TranscriptAdapter } from "./transcript";

/** State changes the session reports; the studio maps them onto its conversation state machine. */
export type VoiceActivity =
  | "processing-started"
  | "processing-ended"
  | "speech-started"
  | "speech-ended";

export interface VoiceCallbacks {
  onActivity(activity: VoiceActivity): void;
  onTranscript(events: TranscriptEvent[]): void;
  /** The connection dropped mid-session. */
  onLost(error: RealtimeError): void;
  /** The voice the engine chose for this session, and why it used the fallback voice if it did. */
  onSessionInfo?(info: SessionInfo): void;
  /** The browser holds back the assistant's audio until the user interacts (see resumeAudio), or allows it again. */
  onAudioBlocked?(blocked: boolean): void;
}

export interface SessionInfo {
  voice: { id: string; name: string; method: string };
  fallback: string | null;
}

export interface VoiceSessionHandle {
  /** Assistant speech levels, for the waveform. */
  readonly output: LevelSource;
  /** Connect to the engine and start streaming the microphone. Rejects with a RealtimeError. */
  connect(microphone: MicrophoneSession): Promise<void>;
  /** Silence or restore the assistant's voice; the conversation continues either way. */
  setOutputMuted(muted: boolean): void;
  /** Let the browser play the assistant's audio; call it from a click when onAudioBlocked reported true. */
  resumeAudio(): Promise<void>;
  /** Cancels any reply in progress, closes the connection and stops playback. */
  stop(): void;
}

export type VoiceFactory = (
  config: SessionConfig,
  callbacks: VoiceCallbacks,
) => VoiceSessionHandle;

export interface VoiceSessionDeps {
  connect: (url: string) => Promise<RealtimeConnection>;
  /** Called synchronously from the Start click, so the browser lets the AudioContext play. */
  createPlayback: () => Playback;
  now: () => number;
  /** Send silence while the assistant is speaking (for speakers without working echo cancellation). */
  halfDuplex?: boolean;
}

export class VoiceSession implements VoiceSessionHandle {
  private readonly playback: Playback;
  private readonly history: InterruptionHistory;
  private readonly transcript: TranscriptAdapter;
  private connection: RealtimeConnection | null = null;
  private stopped = false;
  private activeResponse = false;
  private readonly startedAt: number;

  constructor(
    private readonly config: SessionConfig,
    private readonly callbacks: VoiceCallbacks,
    private readonly deps: VoiceSessionDeps,
  ) {
    this.startedAt = deps.now();
    this.playback = deps.createPlayback();
    this.transcript = new TranscriptAdapter(
      { host: config.hostName, guest: null },
      () => deps.now() - this.startedAt,
    );
    this.history = new InterruptionHistory({
      onInterrupted: (responseId, heard) =>
        this.callbacks.onTranscript(
          this.transcript.interrupted(responseId, heard),
        ),
    });
    this.playback.onActivity((playing) =>
      this.callbacks.onActivity(playing ? "speech-started" : "speech-ended"),
    );
    this.playback.onBlocked((blocked) =>
      this.callbacks.onAudioBlocked?.(blocked),
    );
  }

  get output(): LevelSource {
    return this.playback;
  }

  async connect(microphone: MicrophoneSession): Promise<void> {
    const connection = await this.deps.connect(voiceUrl(this.config));
    if (this.stopped) {
      connection.close();
      return;
    }
    this.connection = connection;
    connection.onEvent((event) => this.handle(event));
    connection.onLost((error) => {
      if (!this.stopped) {
        this.callbacks.onLost(error);
      }
    });
    let downsampler: StreamingDownsampler | null = null;
    await microphone.capture((samples, sampleRate) => {
      if (this.stopped) {
        return;
      }
      if (downsampler?.inputRate !== sampleRate) {
        downsampler = new StreamingDownsampler(sampleRate);
      }
      const pcm = downsampler.push(
        this.deps.halfDuplex && this.playback.playing
          ? new Float32Array(samples.length)
          : samples,
      );
      if (pcm.length) {
        connection.send({
          type: "input_audio_buffer.append",
          audio: bytesToBase64(floatToPcm16(pcm)),
        });
      }
    });
    if (this.playback.blocked) {
      this.callbacks.onAudioBlocked?.(true);
    }
  }

  setOutputMuted(muted: boolean): void {
    this.playback.setMuted(muted);
  }

  resumeAudio(): Promise<void> {
    return this.playback.resume();
  }

  private handle(event: ServerEvent): void {
    // the interruption history reads the playback position before this event changes playback
    for (const outgoing of this.history.observe(event, (rid) =>
      this.playback.playedSeconds(rid),
    )) {
      this.connection?.send(outgoing);
    }
    const transcript = this.transcript.handle(event);
    if (transcript.length) {
      this.callbacks.onTranscript(transcript);
    }
    switch (event.type) {
      case "response.created":
        this.activeResponse = true;
        break;
      case "numa.session": {
        const voice = event.voice as SessionInfo["voice"] | undefined;
        if (voice) {
          this.callbacks.onSessionInfo?.({
            voice,
            fallback:
              typeof event.voice_fallback === "string"
                ? event.voice_fallback
                : null,
          });
        }
        break;
      }
      case "response.output_audio.delta":
        if (event.response_id && event.delta) {
          this.playback.enqueue(
            event.response_id,
            pcm16ToFloat(base64ToBytes(event.delta)),
          );
        }
        break;
      case "input_audio_buffer.speech_started":
        this.playback.clear(); // barge-in: stop the assistant at once
        this.callbacks.onActivity("processing-ended");
        break;
      case "input_audio_buffer.speech_stopped":
        this.callbacks.onActivity("processing-started");
        break;
      case "response.done":
        this.activeResponse = false;
        if (event.response?.status === "cancelled") {
          this.playback.clear();
        }
        if (!this.playback.playing) {
          this.callbacks.onActivity("processing-ended");
        }
        break;
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.activeResponse) {
      this.connection?.send({ type: "response.cancel" }); // nothing more is generated for a user who has left
    }
    this.connection?.close();
    this.playback.close();
  }
}

function browserPlayback(): Playback {
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  const context = new Context();
  void context.resume().catch(() => undefined);
  return new AudioPlayback(context);
}

/** The real thing: the browser's audio and WebSocket. `?halfDuplex` in the page URL turns on half-duplex. */
export const browserVoice: VoiceFactory = (config, callbacks) =>
  new VoiceSession(config, callbacks, {
    connect: (url) => connectRealtime(url),
    createPlayback: browserPlayback,
    now: () => performance.now(),
    halfDuplex: new URLSearchParams(window.location.search).has("halfDuplex"),
  });
