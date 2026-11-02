import { vi } from "vitest";
import type { VoiceInfo, VoicesApi, VoicesState } from "@/lib/voices/api";
import type { RecorderEnvironment } from "@/lib/voices/recorder";
import { FakeTrack, fakeStream } from "./fake-media";

const preset = (id: string, name: string): VoiceInfo => ({
  id: `preset-${id}`,
  name,
  method: "preset",
  builtin: true,
  created_at: null,
  description: "Built-in voice",
  available: true,
  problem: null,
});

/** An in-memory Voice Studio API with the engine's behaviour (ids, default fallback, busy refusal). */
export function fakeVoicesApi({ clone = true, design = true } = {}) {
  let next = 1;
  const state: VoicesState = {
    voices: [preset("aiden", "Aiden"), preset("serena", "Serena")],
    default: "preset-serena",
    default_problem: null,
    capabilities: {
      presets: { available: true, reason: null },
      clone: {
        available: clone,
        reason: clone ? null : "needs tts/qwen3-tts-1.7b-base-6bit",
      },
      design: {
        available: design,
        reason: design ? null : "needs tts/qwen3-tts-1.7b-voicedesign-6bit",
      },
    },
    busy: false,
  };
  const snapshot = (): VoicesState => structuredClone(state);
  const add = (
    name: string,
    method: VoiceInfo["method"],
    description: string | null = null,
  ) => {
    const voice: VoiceInfo = {
      id: `voice-00000000000${next++}`,
      name,
      method,
      builtin: false,
      created_at: "2026-10-30T12:00:00+00:00",
      description,
      available: true,
      problem: null,
    };
    state.voices.push(voice);
    return voice;
  };
  const busyCheck = () => {
    if (state.busy) {
      throw new Error(
        "End the conversation first: voices are generated with the same model.",
      );
    }
  };
  const api = {
    list: vi.fn(async () => snapshot()),
    preview: vi.fn(async () => {
      busyCheck();
      return new Blob(["RIFF"], { type: "audio/wav" });
    }),
    create: vi.fn(
      async (name: string, method: "recorded" | "uploaded", _wav: Blob) => {
        busyCheck();
        return { voice: add(name, method), ...snapshot() };
      },
    ),
    designCandidates: vi.fn(async (_description: string) => {
      busyCheck();
      return {
        token: "0123456789abcdef",
        text: "Hello, it's lovely to meet you.",
        candidates: [0, 1, 2].map((index) => ({
          index,
          audio: btoa("RIFF"),
          duration_s: 5,
        })),
      };
    }),
    saveDesign: vi.fn(async (_token: string, _index: number, name: string) => ({
      voice: add(name, "designed", "A soft voice"),
      ...snapshot(),
    })),
    rename: vi.fn(async (id: string, name: string) => {
      const voice = state.voices.find((v) => v.id === id);
      if (voice) {
        voice.name = name;
      }
      return snapshot();
    }),
    remove: vi.fn(async (id: string) => {
      state.voices = state.voices.filter((v) => v.id !== id);
      if (state.default === id) {
        state.default = "preset-serena";
      }
      return snapshot();
    }),
    setDefault: vi.fn(async (id: string) => {
      state.default = id;
      return snapshot();
    }),
  };
  return { api: api as unknown as VoicesApi & typeof api, state, add };
}

/** A microphone for the recorder: getUserMedia, AudioContext and the capture worklet, driven by the test. */
export function fakeRecorderEnvironment() {
  const track = new FakeTrack();
  let port: { onmessage: ((e: { data: Float32Array }) => void) | null } | null =
    null;
  const context = {
    sampleRate: 48000,
    state: "running" as "running" | "closed",
    destination: {},
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() })),
    close: vi.fn(async () => {
      context.state = "closed";
    }),
  };
  class FakeWorkletNode {
    port = { onmessage: null as ((e: { data: Float32Array }) => void) | null };
    connect = vi.fn();
    constructor() {
      port = this.port;
    }
  }
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  const env: RecorderEnvironment = {
    getUserMedia: vi.fn(async () => fakeStream([track])),
    createAudioContext: () => context as unknown as AudioContext,
  };
  return {
    env,
    track,
    context,
    /** Deliver `seconds` of a 200 Hz tone at the given level, as the worklet would. */
    speak(seconds: number, level = 0.3) {
      const block = 1920;
      for (let done = 0; done < seconds * 48000; done += block) {
        const samples = new Float32Array(block);
        for (let i = 0; i < block; i++) {
          samples[i] =
            level * Math.sin((2 * Math.PI * 200 * (done + i)) / 48000);
        }
        port?.onmessage?.({ data: samples });
      }
    },
  };
}
