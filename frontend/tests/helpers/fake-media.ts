import { vi } from "vitest";
import type {
  MicrophoneEnvironment,
  MicrophoneSession,
} from "@/lib/audio/microphone";

export class FakeTrack extends EventTarget {
  kind = "audio";
  enabled = true;
  readyState: "live" | "ended" = "live";
  constructor(public label = "Studio Microphone") {
    super();
  }
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  /** Simulate the device disappearing (unplugged / revoked). */
  unplug() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

export function fakeStream(tracks: FakeTrack[] = [new FakeTrack()]) {
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  } as unknown as MediaStream & { tracks: FakeTrack[] };
}

export class FakeAudioContext {
  state: "suspended" | "running" | "closed" = "running";
  amplitude = 0;
  source = { connect: vi.fn(), disconnect: vi.fn() };
  analyser = {
    fftSize: 2048,
    smoothingTimeConstant: 0.8,
    disconnect: vi.fn(),
    getFloatTimeDomainData: (out: Float32Array) => {
      // a square wave of the configured amplitude: RMS == amplitude
      for (let i = 0; i < out.length; i++) {
        out[i] = i % 2 === 0 ? this.amplitude : -this.amplitude;
      }
    },
  };
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createMediaStreamSource = vi.fn(() => this.source);
  createAnalyser = vi.fn(() => this.analyser);
}

export interface FakeEnvironmentOptions {
  secure?: boolean;
  mediaDevices?: boolean;
  devices?: Array<{ kind: MediaDeviceKind }>;
  getUserMediaError?: unknown;
  audioContextError?: unknown;
  stream?: ReturnType<typeof fakeStream>;
}

export function fakeEnvironment(options: FakeEnvironmentOptions = {}) {
  const stream = options.stream ?? fakeStream();
  const context = new FakeAudioContext();
  const getUserMedia = vi.fn(async () => {
    if (options.getUserMediaError) {
      throw options.getUserMediaError;
    }
    return stream;
  });
  const enumerateDevices = vi.fn(
    async () =>
      (options.devices ?? [{ kind: "audioinput" }]) as MediaDeviceInfo[],
  );
  const env: MicrophoneEnvironment = {
    isSecureContext: options.secure ?? true,
    mediaDevices:
      options.mediaDevices === false
        ? undefined
        : ({
            getUserMedia,
            enumerateDevices,
          } as unknown as MicrophoneEnvironment["mediaDevices"]),
    createAudioContext: () => {
      if (options.audioContextError) {
        throw options.audioContextError;
      }
      return context as unknown as AudioContext;
    },
  };
  return { env, stream, context, getUserMedia, enumerateDevices };
}

export function domError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** A controllable fake session for hook and component tests. */
export function fakeSession(level = 0.5) {
  let lost: (() => void) | null = null;
  let onSamples: ((samples: Float32Array, rate: number) => void) | null = null;
  const session = {
    capture: vi.fn(
      async (listener: (samples: Float32Array, rate: number) => void) => {
        onSamples = listener;
      },
    ),
    /** Deliver captured microphone samples, as the AudioWorklet would. */
    emit: (samples: Float32Array, rate = 48000) => onSamples?.(samples, rate),
    deviceLabel: "Studio Microphone",
    muted: false,
    readLevel: vi.fn(() => (session.muted ? 0 : level)),
    setMuted: vi.fn((m: boolean) => {
      session.muted = m;
    }),
    onDeviceLost: vi.fn((listener: () => void) => {
      lost = listener;
    }),
    stop: vi.fn(),
    loseDevice: () => lost?.(),
  };
  return session as typeof session & MicrophoneSession;
}

/** A promise you can resolve or reject from outside. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
