"use client";

import {
  Check,
  LoaderCircle,
  Pencil,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  DEFAULT_SAMPLE_TEXT,
  type PlayAudio,
  useVoiceStudio,
} from "@/hooks/use-voice-studio";
import { cn } from "@/lib/utils";
import type { VoiceInfo, VoicesApi } from "@/lib/voices/api";
import type { RecorderEnvironment } from "@/lib/voices/recorder";
import { VoiceCreate } from "./voice-create";

export const chip =
  "inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-numa-slate transition-colors duration-200 hover:border-numa-slate/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";
export const primaryChip =
  "inline-flex items-center gap-1.5 rounded-full bg-numa-mint px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors duration-200 hover:bg-[#8fe4d2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40";
export const field =
  "w-full rounded-xl border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-numa-slate/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const METHOD_LABEL: Record<string, string> = {
  preset: "Built-in",
  recorded: "Recorded",
  uploaded: "Uploaded",
  designed: "Designed",
  unknown: "Unavailable",
};

export interface SessionVoice {
  id: string;
  name: string;
  fallback: string | null;
}

export interface VoicePanelProps {
  id: string;
  /** A conversation is running: generation and recording wait, and a new default applies next time. */
  sessionActive: boolean;
  /** The voice the running conversation speaks in (reported by the engine). */
  sessionVoice: SessionVoice | null;
  api?: VoicesApi;
  play?: PlayAudio;
  recorderEnvironment?: RecorderEnvironment;
  className?: string;
}

/** Voice Studio: choose, preview, create and manage the voice Numa speaks with in conversations. */
export function VoicePanel({
  id,
  sessionActive,
  sessionVoice,
  api,
  play,
  recorderEnvironment,
  className,
}: VoicePanelProps) {
  const studio = useVoiceStudio({ api, play });
  const [sample, setSample] = useState(DEFAULT_SAMPLE_TEXT);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const { state, refresh, stopPreview } = studio;

  // The engine refuses generation during a conversation; keep its view of that current.
  useEffect(() => {
    if (sessionActive) {
      stopPreview();
    }
    void refresh();
  }, [sessionActive, refresh, stopPreview]);

  const current = state?.voices.find((v) => v.id === state.default) ?? null;
  const generationBlocked = sessionActive || Boolean(state?.busy);
  const text = sample.trim() || DEFAULT_SAMPLE_TEXT;

  function previewButton(voice: VoiceInfo, label = "Preview") {
    const key = voice.id;
    const loading = studio.pending === `preview:${key}`;
    const isPlaying = studio.playing === key;
    return (
      <button
        type="button"
        className={chip}
        disabled={
          generationBlocked ||
          !voice.available ||
          (studio.pending !== null && !loading)
        }
        aria-label={isPlaying ? `Stop ${voice.name}` : `${label} ${voice.name}`}
        onClick={() =>
          isPlaying
            ? stopPreview()
            : void studio.preview({ voiceId: voice.id }, text, key)
        }
      >
        {loading ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-3.5 animate-spin motion-reduce:animate-none"
          />
        ) : isPlaying ? (
          <Square aria-hidden="true" className="size-3 fill-current" />
        ) : (
          <Play aria-hidden="true" className="size-3.5" />
        )}
        {loading ? "Generating" : isPlaying ? "Stop" : label}
      </button>
    );
  }

  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn("flex min-h-0 flex-col", className)}
    >
      <header className="flex items-baseline justify-between px-6 pt-6 pb-4">
        <h2
          id={`${id}-title`}
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          Voice
        </h2>
        <span className="text-xs text-numa-slate/60">Conversation</span>
      </header>

      <div className="flex flex-1 flex-col gap-7 overflow-y-auto px-6 pb-8">
        {studio.error && (
          <p
            role="alert"
            className="rounded-xl border border-numa-coral/30 bg-numa-coral/[0.07] px-3 py-2 text-xs text-foreground"
          >
            {studio.error}
          </p>
        )}
        {studio.notice && (
          <output className="text-xs text-numa-mint">{studio.notice}</output>
        )}

        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-[0.08em] text-numa-slate uppercase">
            Current voice
          </h3>
          {current ? (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[15px] text-foreground">
                  {current.name}
                </p>
                <p className="text-xs text-numa-slate/70">
                  {METHOD_LABEL[current.method]}
                </p>
              </div>
              {previewButton(current)}
            </div>
          ) : (
            <p className="text-sm text-numa-slate/75">
              {studio.loading ? "Loading voices…" : "Voices unavailable."}
            </p>
          )}
          {state?.default_problem && (
            <p className="text-xs text-numa-coral">
              Using {current?.name}: {state.default_problem}.
            </p>
          )}
          {sessionActive && sessionVoice && (
            <p className="text-xs leading-relaxed text-numa-slate/75">
              This conversation speaks as {sessionVoice.name}
              {sessionVoice.fallback ? ` (${sessionVoice.fallback})` : ""}.
              {current && current.id !== sessionVoice.id
                ? ` ${current.name} takes effect in your next conversation.`
                : ""}
            </p>
          )}
          {generationBlocked && (
            <p className="text-xs text-numa-slate/60">
              End the conversation to preview or create voices.
            </p>
          )}
        </div>

        <label className="flex flex-col gap-2">
          <span className="text-xs font-medium tracking-[0.08em] text-numa-slate uppercase">
            Preview text
          </span>
          <textarea
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            maxLength={300}
            rows={2}
            className={cn(field, "resize-none")}
          />
        </label>

        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-medium tracking-[0.08em] text-numa-slate uppercase">
            Saved voices
          </h3>
          <ul className="flex flex-col gap-3">
            {state?.voices.map((voice) => {
              const isDefault = voice.id === state.default;
              return (
                <li
                  key={voice.id}
                  className="flex flex-col gap-2 border-b border-border/60 pb-3 last:border-b-0"
                >
                  {renaming === voice.id ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void studio
                          .rename(voice.id, draftName)
                          .then(() => setRenaming(null));
                      }}
                    >
                      <input
                        aria-label={`New name for ${voice.name}`}
                        value={draftName}
                        maxLength={40}
                        onChange={(e) => setDraftName(e.target.value)}
                        className={field}
                      />
                      <button type="submit" className={chip}>
                        Save
                      </button>
                      <button
                        type="button"
                        className={chip}
                        onClick={() => setRenaming(null)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={cn(
                          "truncate text-sm",
                          voice.available
                            ? "text-foreground"
                            : "text-numa-slate/60",
                        )}
                      >
                        {voice.name}
                      </span>
                      <span className="shrink-0 text-xs text-numa-slate/60">
                        {METHOD_LABEL[voice.method]}
                      </span>
                    </div>
                  )}
                  {voice.description && (
                    <p className="text-xs text-numa-slate/70">
                      {voice.description}
                    </p>
                  )}
                  {voice.problem && (
                    <p className="text-xs text-numa-coral">{voice.problem}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {previewButton(voice)}
                    {isDefault ? (
                      <span className="inline-flex items-center gap-1.5 px-1 py-1.5 text-xs text-numa-mint">
                        <Check aria-hidden="true" className="size-3.5" />
                        Numa default
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={chip}
                        disabled={!voice.available || studio.pending !== null}
                        onClick={() => void studio.setDefault(voice.id)}
                      >
                        Set as Numa default
                      </button>
                    )}
                    {!voice.builtin && (
                      <>
                        {voice.available && renaming !== voice.id && (
                          <button
                            type="button"
                            className={chip}
                            aria-label={`Rename ${voice.name}`}
                            onClick={() => {
                              setRenaming(voice.id);
                              setDraftName(voice.name);
                            }}
                          >
                            <Pencil aria-hidden="true" className="size-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          className={cn(
                            chip,
                            "hover:border-numa-coral/60 hover:text-numa-coral",
                          )}
                          aria-label={`Delete ${voice.name}`}
                          disabled={studio.pending !== null}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete “${voice.name}” and its recording? This cannot be undone.`,
                              )
                            ) {
                              void studio.remove(voice.id);
                            }
                          }}
                        >
                          <Trash2 aria-hidden="true" className="size-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <VoiceCreate
          studio={studio}
          blocked={generationBlocked}
          previewText={text}
          recorderEnvironment={recorderEnvironment}
        />
      </div>
    </section>
  );
}
