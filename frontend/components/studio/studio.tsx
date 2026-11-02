"use client";

import {
  AudioLines,
  PanelRightClose,
  PanelRightOpen,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useConversation } from "@/hooks/use-conversation";
import { useSessionTimer } from "@/hooks/use-session-timer";
import type { MicrophoneSession } from "@/lib/audio/microphone";
import { browserVoice, type VoiceFactory } from "@/lib/realtime/voice-session";
import { MODES, type ModeConfig, sessionConfig } from "@/lib/session/modes";
import {
  type ConversationStatus,
  isSessionActive,
} from "@/lib/state/conversation-machine";
import { cn } from "@/lib/utils";
import { AppHeader } from "./app-header";
import { DevSimulation } from "./dev-simulation";
import { SessionTimer } from "./session-timer";
import { describeState, StateIndicator } from "./state-indicator";
import { StudioControls } from "./studio-controls";
import { TranscriptPanel } from "./transcript-panel";
import { VoicePanel, type VoicePanelProps } from "./voice-panel";
import { Waveform, type WaveformState } from "./waveform";

const WAVEFORM_STATE: Record<ConversationStatus, WaveformState> = {
  idle: "idle",
  connecting: "idle",
  listening: "listening",
  processing: "processing",
  speaking: "speaking",
  muted: "muted",
  error: "error",
  ended: "idle",
};

/** `NEXT_PUBLIC_NUMA_VOICE=off` runs the studio without the voice engine: a microphone preview with simulation. */
const DEFAULT_VOICE: VoiceFactory | null =
  process.env.NEXT_PUBLIC_NUMA_VOICE === "off" ? null : browserVoice;

export interface StudioProps {
  mode?: ModeConfig;
  /** Injected in tests; the browser microphone otherwise. */
  openMicrophone?: () => Promise<MicrophoneSession>;
  /** Injected in tests; the local voice engine otherwise (null: microphone-only preview). */
  voice?: VoiceFactory | null;
  /** Injected in tests: Voice Studio's engine API, playback and recorder. */
  voiceStudio?: Pick<VoicePanelProps, "api" | "play" | "recorderEnvironment">;
  enableSimulation?: boolean;
}

type Panel = "transcript" | "voice" | null;

export function Studio({
  mode = MODES.conversation,
  openMicrophone,
  voice = DEFAULT_VOICE,
  voiceStudio,
  enableSimulation,
}: StudioProps) {
  const session = useMemo(() => sessionConfig(mode), [mode]);
  const conversation = useConversation({
    open: openMicrophone,
    voice,
    session,
    enableSimulation,
  });
  const { state } = conversation;
  const active = isSessionActive(state.status);
  const elapsed = useSessionTimer(
    state.startedAt,
    state.endedAt,
    active && state.startedAt !== null,
  );
  const [panel, setPanel] = useState<Panel>(null);
  const transcriptOpen = panel === "transcript";
  const voiceStudioEnabled = voice !== null;
  const toggle = (which: Exclude<Panel, null>) =>
    setPanel((open) => (open === which ? null : which));
  const context = voice
    ? { host: mode.speakerLabel, idle: mode.idleDetail }
    : undefined;
  const copy = describeState(state, context);
  const waveformState = WAVEFORM_STATE[state.status];
  const levels =
    waveformState === "listening"
      ? conversation.inputLevels
      : waveformState === "speaking"
        ? conversation.outputLevels
        : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader mode={mode} connection={conversation.connection}>
        {voiceStudioEnabled && (
          <button
            type="button"
            aria-expanded={panel === "voice"}
            aria-controls="voice-studio"
            onClick={() => toggle("voice")}
            className="flex items-center gap-2 rounded-full px-3 py-2 text-sm text-numa-slate transition-colors duration-200 hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AudioLines aria-hidden="true" className="size-4" />
            Voice
          </button>
        )}
        <button
          type="button"
          aria-expanded={transcriptOpen}
          aria-controls="transcript"
          onClick={() => toggle("transcript")}
          className="flex items-center gap-2 rounded-full px-3 py-2 text-sm text-numa-slate transition-colors duration-200 hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {transcriptOpen ? (
            <PanelRightClose aria-hidden="true" className="size-4" />
          ) : (
            <PanelRightOpen aria-hidden="true" className="size-4" />
          )}
          Transcript
        </button>
      </AppHeader>

      <div className="flex flex-1 flex-col lg:flex-row">
        <main className="flex flex-1 flex-col items-center justify-center gap-9 px-6 py-12 sm:gap-11 sm:px-10">
          <div className="flex flex-col items-center gap-3 text-center">
            <StateIndicator state={state} context={context} />
            <p className="max-w-[46ch] text-sm leading-relaxed text-numa-slate/80">
              {copy.detail}
            </p>
          </div>

          <Waveform
            state={waveformState}
            levels={levels}
            className="h-36 max-w-[1040px] sm:h-52 lg:h-60"
          />

          <div className="flex flex-col items-center gap-2">
            <SessionTimer
              elapsedMs={elapsed}
              active={active && state.startedAt !== null}
            />
            <p className="min-h-5 text-xs text-numa-slate/60">
              {conversation.deviceLabel ? conversation.deviceLabel : " "}
            </p>
          </div>

          <StudioControls
            status={state.status}
            onStart={() => void conversation.start()}
            onEnd={conversation.end}
            onToggleMute={conversation.toggleMute}
            startLabel={mode.startLabel}
            endLabel={mode.endLabel}
          />

          {active && conversation.audioBlocked ? (
            <output className="flex items-center gap-3 text-sm text-numa-slate">
              <span>The browser paused Numa's audio.</span>
              <button
                type="button"
                onClick={conversation.resumeAudio}
                className="rounded-full px-3 py-1.5 text-sm text-foreground transition-colors duration-200 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Resume audio
              </button>
            </output>
          ) : null}

          {state.status === "error" && state.error ? (
            <div
              role="alert"
              className="flex max-w-md items-start gap-3 rounded-xl border border-numa-coral/30 bg-numa-coral/[0.07] px-4 py-3 text-sm text-foreground"
            >
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-numa-coral"
              />
              <span>{state.error.message}</span>
            </div>
          ) : (
            <p className="max-w-[52ch] text-center text-xs leading-relaxed text-numa-slate/60">
              {voice
                ? "Microphone audio goes only to the Numa voice engine on this computer. Nothing is recorded or stored."
                : "Local preview. Microphone audio is analysed in this browser only. It is never recorded, stored or sent, and no AI model is connected."}
            </p>
          )}

          {conversation.simulate && active ? (
            <DevSimulation
              status={state.status}
              onSimulate={conversation.simulate}
            />
          ) : null}
        </main>

        <TranscriptPanel
          id="transcript"
          entries={conversation.transcript}
          available={conversation.connection === "connected"}
          onClear={conversation.clearTranscript}
          className={cn(
            "border-t border-border lg:w-[380px] lg:border-t-0 lg:border-l",
            transcriptOpen ? "flex" : "hidden",
          )}
        />
        {voiceStudioEnabled && panel === "voice" && (
          <VoicePanel
            id="voice-studio"
            sessionActive={active}
            sessionVoice={
              conversation.sessionInfo
                ? {
                    ...conversation.sessionInfo.voice,
                    fallback: conversation.sessionInfo.fallback,
                  }
                : null
            }
            {...voiceStudio}
            className="border-t border-border lg:w-[380px] lg:border-t-0 lg:border-l"
          />
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {`Conversation status: ${copy.label}`}
      </p>
    </div>
  );
}
