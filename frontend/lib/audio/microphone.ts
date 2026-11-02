/**
 * Browser microphone session: permission, device checks, live level measurement, raw capture, mute, and cleanup.
 *
 * The stream feeds an AnalyserNode for the waveform. capture() additionally hands raw samples to the caller (the
 * voice session, which streams them to the local voice engine). Nothing is recorded, stored or played back.
 */

import type {
  ConversationError,
  MicrophoneErrorCode,
} from "@/lib/state/conversation-machine";
import { type LevelSource, rms, rmsToLevel } from "./levels";

export class MicrophoneError extends Error implements ConversationError {
  constructor(
    readonly code: MicrophoneErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MicrophoneError";
  }
}

const MESSAGES: Record<MicrophoneErrorCode, string> = {
  unsupported: "This browser cannot capture microphone audio.",
  "insecure-context":
    "Microphone access needs a secure connection (https or localhost).",
  "permission-denied":
    "Microphone access was blocked. Allow it in your browser's site settings, then try again.",
  "no-device": "No microphone was found. Connect one and try again.",
  "device-busy":
    "The microphone is in use by another application or could not be started.",
  "device-lost": "The microphone was disconnected.",
  unknown: "The microphone could not be started.",
};

export function microphoneError(
  code: MicrophoneErrorCode,
  detail?: string,
): MicrophoneError {
  return new MicrophoneError(
    code,
    detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code],
  );
}

/** Translate a getUserMedia / AudioContext failure into a typed error. */
export function classifyMicrophoneError(error: unknown): MicrophoneError {
  if (error instanceof MicrophoneError) {
    return error;
  }
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return microphoneError("permission-denied");
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return microphoneError("no-device");
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return microphoneError("device-busy");
    default:
      return microphoneError(
        "unknown",
        error instanceof Error ? error.message : undefined,
      );
  }
}

export interface MicrophoneSession extends LevelSource {
  readonly deviceLabel: string;
  readonly muted: boolean;
  setMuted(muted: boolean): void;
  /** Called once if the device stops delivering audio (unplugged, revoked). Not called after stop(). */
  onDeviceLost(listener: () => void): void;
  /** Stream raw samples (at `sampleRate`, ~40 ms blocks) until stop(). Resolves once streaming has started. */
  capture(
    onSamples: (samples: Float32Array, sampleRate: number) => void,
  ): Promise<void>;
  /** Stop every track, disconnect the graph and close the AudioContext. Safe to call more than once. */
  stop(): void;
}

/** The browser objects the session needs, injectable for tests. */
export interface MicrophoneEnvironment {
  isSecureContext: boolean;
  mediaDevices:
    | Pick<MediaDevices, "getUserMedia" | "enumerateDevices">
    | undefined;
  createAudioContext: () => AudioContext;
}

export function browserEnvironment(): MicrophoneEnvironment {
  const AudioContextCtor: typeof AudioContext | undefined =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext);
  return {
    isSecureContext: typeof window !== "undefined" && window.isSecureContext,
    mediaDevices:
      typeof navigator === "undefined" ? undefined : navigator.mediaDevices,
    createAudioContext: () => {
      if (!AudioContextCtor) {
        throw microphoneError("unsupported");
      }
      return new AudioContextCtor();
    },
  };
}

/** Served from public/: posts the microphone's samples to the main thread in ~40 ms blocks. */
export const CAPTURE_WORKLET_URL = "/worklets/pcm-capture.js";

export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export async function openMicrophone(
  env: MicrophoneEnvironment = browserEnvironment(),
): Promise<MicrophoneSession> {
  if (!env.isSecureContext) {
    throw microphoneError("insecure-context");
  }
  const devices = env.mediaDevices;
  if (!devices?.getUserMedia || !devices.enumerateDevices) {
    throw microphoneError("unsupported");
  }

  // Before permission is granted browsers still list input devices (without labels), so an empty list means none.
  let inputs: MediaDeviceInfo[];
  try {
    inputs = (await devices.enumerateDevices()).filter(
      (d) => d.kind === "audioinput",
    );
  } catch (error) {
    throw classifyMicrophoneError(error);
  }
  if (inputs.length === 0) {
    throw microphoneError("no-device");
  }

  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: false,
    });
  } catch (error) {
    throw classifyMicrophoneError(error);
  }

  const tracks = stream.getAudioTracks();
  const releaseStream = () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };
  if (tracks.length === 0) {
    releaseStream();
    throw microphoneError("no-device");
  }

  let context: AudioContext;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    context = env.createAudioContext();
    if (context.state === "suspended") {
      await context.resume();
    }
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    // Analysis only: the analyser is never connected to context.destination, so nothing is played back.
    source.connect(analyser);
  } catch (error) {
    releaseStream();
    throw classifyMicrophoneError(error);
  }

  return createSession(stream, tracks, context, source, analyser);
}

function createSession(
  stream: MediaStream,
  tracks: MediaStreamTrack[],
  context: AudioContext,
  source: MediaStreamAudioSourceNode,
  analyser: AnalyserNode,
): MicrophoneSession {
  const samples = new Float32Array(analyser.fftSize);
  let muted = false;
  let stopped = false;
  let deviceLostListener: (() => void) | null = null;
  let capturer: AudioWorkletNode | null = null;
  let sink: GainNode | null = null;

  const handleEnded = () => {
    if (!stopped) {
      deviceLostListener?.();
    }
  };
  for (const track of tracks) {
    track.addEventListener("ended", handleEnded);
  }

  return {
    deviceLabel: tracks[0]?.label || "Microphone",
    get muted() {
      return muted;
    },
    readLevel() {
      if (stopped || muted) {
        return 0;
      }
      analyser.getFloatTimeDomainData(samples);
      return rmsToLevel(rms(samples));
    },
    setMuted(next) {
      muted = next;
      // Disabling the track makes the stream deliver silence; the device stays open so unmuting is instant.
      for (const track of tracks) {
        track.enabled = !next;
      }
    },
    onDeviceLost(listener) {
      deviceLostListener = listener;
    },
    async capture(onSamples) {
      if (stopped || capturer) {
        return;
      }
      await context.audioWorklet.addModule(CAPTURE_WORKLET_URL);
      if (stopped) {
        return;
      }
      capturer = new AudioWorkletNode(context, "pcm-capture");
      capturer.port.onmessage = (event: MessageEvent<Float32Array>) =>
        onSamples(event.data, context.sampleRate);
      // A worklet only runs while connected to the output; a silent gain keeps it running without playback.
      sink = context.createGain();
      sink.gain.value = 0;
      source.connect(capturer);
      capturer.connect(sink);
      sink.connect(context.destination);
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const track of tracks) {
        track.removeEventListener("ended", handleEnded);
      }
      for (const track of stream.getTracks()) {
        track.stop();
      }
      if (capturer) {
        capturer.port.onmessage = null;
        capturer.disconnect();
      }
      sink?.disconnect();
      source.disconnect();
      analyser.disconnect();
      if (context.state !== "closed") {
        void context.close().catch(() => undefined);
      }
    },
  };
}

/**
 * Whether the page may open the microphone without a prompt. "prompt" also when the browser cannot say (some
 * browsers do not support querying it), so callers then ask through an explicit click.
 */
export async function microphonePermission(): Promise<PermissionState> {
  try {
    const status = await navigator.permissions?.query({
      name: "microphone" as PermissionName,
    });
    return status?.state ?? "prompt";
  } catch {
    return "prompt";
  }
}
