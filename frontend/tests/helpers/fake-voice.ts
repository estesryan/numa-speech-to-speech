import { vi } from "vitest";
import type { LevelSource } from "@/lib/audio/levels";
import type { MicrophoneSession } from "@/lib/audio/microphone";
import type { RealtimeError } from "@/lib/realtime/client";
import type {
  VoiceCallbacks,
  VoiceFactory,
  VoiceSessionHandle,
} from "@/lib/realtime/voice-session";
import type { SessionConfig } from "@/lib/session/modes";

/** A controllable voice-engine connection for component tests: records sessions and drives their callbacks. */
export function fakeVoice({ fail }: { fail?: RealtimeError } = {}) {
  const sessions: Array<{
    config: SessionConfig;
    callbacks: VoiceCallbacks;
    handle: VoiceSessionHandle & {
      connect: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      setOutputMuted: ReturnType<typeof vi.fn>;
      resumeAudio: ReturnType<typeof vi.fn>;
    };
    microphone: MicrophoneSession | null;
  }> = [];
  const output: LevelSource = { readLevel: () => 0.4 };
  const factory: VoiceFactory = (config, callbacks) => {
    const record = {
      config,
      callbacks,
      microphone: null as MicrophoneSession | null,
      handle: {
        output,
        connect: vi.fn(async (microphone: MicrophoneSession) => {
          record.microphone = microphone;
          if (fail) {
            throw fail;
          }
        }),
        stop: vi.fn(),
        setOutputMuted: vi.fn(),
        resumeAudio: vi.fn(async () => {
          record.callbacks.onAudioBlocked?.(false);
        }),
      },
    };
    sessions.push(record);
    return record.handle;
  };
  return { factory, sessions, last: () => sessions[sessions.length - 1] };
}
