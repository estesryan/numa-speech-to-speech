"use client";

import {
  Check,
  LoaderCircle,
  Mic,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";
import { type ChangeEvent, useEffect, useId, useRef, useState } from "react";
import type { VoiceStudio } from "@/hooks/use-voice-studio";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DesignCandidates } from "@/lib/voices/api";
import {
  type Recorder,
  type RecorderEnvironment,
  startRecording,
} from "@/lib/voices/recorder";
import {
  checkReference,
  decodeToMono,
  encodeWav,
  MAX_SECONDS,
  MAX_UPLOAD_BYTES,
  type ReferenceCheck,
} from "@/lib/voices/wav";
import { chip, field, primaryChip } from "./voice-panel";

export const READING_PASSAGE =
  "Hello! I'm recording a short sample of my voice. I like slow mornings, a good cup of coffee, and long " +
  "conversations about almost anything. Sometimes I talk quickly when I'm excited, and sometimes I take my time " +
  "to think. Either way, this is how I sound.";

export const CONSENT_LABEL =
  "This is my own voice, or its owner has given me permission to create a synthetic copy of it.";

type Tab = "record" | "upload" | "describe";

interface Reference {
  wav: Blob;
  url: string;
  check: ReferenceCheck;
}

function toReference(samples: Float32Array, sampleRate: number): Reference {
  const wav = encodeWav(samples, sampleRate);
  return {
    wav,
    url: URL.createObjectURL(wav),
    check: checkReference(samples, sampleRate),
  };
}

function base64Wav(audio: string): Blob {
  const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "audio/wav" });
}

export function VoiceCreate({
  studio,
  blocked,
  previewText,
  recorderEnvironment,
}: {
  studio: VoiceStudio;
  /** A conversation is running: the microphone and the model are in use. */
  blocked: boolean;
  previewText: string;
  recorderEnvironment?: RecorderEnvironment;
}) {
  const [tab, setTab] = useState<Tab>("record");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [reference, setReference] = useState<Reference | null>(null);
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [candidates, setCandidates] = useState<DesignCandidates | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const objectUrls = useRef(new Set<string>()); // revoked when the panel closes
  const ids = useId();
  const caps = studio.state?.capabilities;
  const cloneReason = caps && !caps.clone.available ? caps.clone.reason : null;
  const designReason =
    caps && !caps.design.available ? caps.design.reason : null;

  function discardReference() {
    setReference((r) => {
      if (r) {
        URL.revokeObjectURL(r.url);
      }
      return null;
    });
    setUploadUrl((u) => {
      if (u) {
        URL.revokeObjectURL(u);
      }
      return null;
    });
  }

  function cancelRecording() {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setRecorder(null);
  }

  function stopRecording() {
    const active = recorderRef.current;
    if (!active) {
      return;
    }
    recorderRef.current = null;
    setRecorder(null);
    const { samples, sampleRate } = active.stop();
    const recorded = toReference(samples, sampleRate);
    objectUrls.current.add(recorded.url);
    setReference(recorded);
  }

  async function record() {
    discardReference();
    setRecordError(null);
    try {
      const started = await startRecording(recorderEnvironment, () =>
        stopRecording(),
      );
      recorderRef.current = started;
      setRecorder(started);
    } catch {
      setRecordError(
        "The microphone could not be opened. Allow microphone access and try again.",
      );
    }
  }

  // live timer and level while recording
  useEffect(() => {
    if (!recorder) {
      return;
    }
    const timer = setInterval(() => {
      setElapsed(recorder.elapsed());
      setLevel(recorder.level());
    }, 100);
    return () => clearInterval(timer);
  }, [recorder]);

  // Never hold the microphone or object URLs past this panel, or while a conversation needs the microphone.
  useEffect(() => {
    if (blocked) {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setRecorder(null);
    }
  }, [blocked]);
  useEffect(
    () => () => {
      recorderRef.current?.cancel();
    },
    [],
  );
  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    discardReference();
    setRecordError(null);
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setRecordError(
        "This file is larger than 15 MB. Use a clip of up to 30 seconds.",
      );
      return;
    }
    try {
      const { samples, sampleRate } = await decodeToMono(
        await file.arrayBuffer(),
      );
      const decoded = toReference(samples, sampleRate);
      const fileUrl = URL.createObjectURL(file);
      objectUrls.current.add(decoded.url).add(fileUrl);
      setReference(decoded);
      setUploadUrl(fileUrl);
    } catch {
      setRecordError("This file could not be decoded as audio.");
    }
  }

  async function save(method: "recorded" | "uploaded") {
    if (!reference) {
      return;
    }
    if (await studio.create(name.trim(), method, reference.wav)) {
      discardReference();
      setName("");
      setConsent(false);
    }
  }

  async function design() {
    setCandidates(null);
    setChosen(null);
    setCandidates(await studio.design(description.trim()));
  }

  async function saveDesign() {
    if (
      candidates &&
      chosen !== null &&
      (await studio.saveDesign(candidates.token, chosen, name.trim()))
    ) {
      setCandidates(null);
      setChosen(null);
      setName("");
      setDescription("");
    }
  }

  const busy = studio.pending !== null;
  const canSaveClone =
    reference !== null &&
    reference.check.problem === null &&
    consent &&
    name.trim() !== "" &&
    !busy &&
    !blocked;
  const nameField = (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-numa-slate/80">Name</span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={40}
        className={field}
      />
    </label>
  );
  const consentField = (
    <label className="flex items-start gap-2 text-xs leading-relaxed text-numa-slate/85">
      <input
        type="checkbox"
        checked={consent}
        onChange={(e) => setConsent(e.target.checked)}
        className="mt-0.5 accent-[#7DDCC9]"
      />
      {CONSENT_LABEL}
    </label>
  );
  const referenceSummary = reference && (
    <div className="flex flex-col gap-2">
      {/* biome-ignore lint/a11y/useMediaCaption: the user's own reference recording; there is nothing to caption */}
      <audio
        controls
        src={uploadUrl ?? reference.url}
        className="h-9 w-full"
        aria-label="Reference recording"
      />
      <p
        className={cn(
          "text-xs",
          reference.check.problem ? "text-numa-coral" : "text-numa-slate/70",
        )}
      >
        {reference.check.problem ??
          `${reference.check.durationS.toFixed(1)} s of speech, good level.`}
      </p>
    </div>
  );
  const createButton = (method: "recorded" | "uploaded") => (
    <button
      type="button"
      className={primaryChip}
      disabled={!canSaveClone}
      onClick={() => void save(method)}
    >
      {studio.pending === "create" ? (
        <LoaderCircle
          aria-hidden="true"
          className="size-3.5 animate-spin motion-reduce:animate-none"
        />
      ) : (
        <Check aria-hidden="true" className="size-3.5" />
      )}
      {studio.pending === "create" ? "Creating voice…" : "Create voice"}
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-xs font-medium tracking-[0.08em] text-numa-slate uppercase">
        Create a voice
      </h3>
      <div
        role="tablist"
        aria-label="How to create a voice"
        className="flex gap-1"
      >
        {(
          [
            ["record", "Record", Mic],
            ["upload", "Upload", Upload],
            ["describe", "Describe", Sparkles],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${ids}-${id}-tab`}
            aria-selected={tab === id}
            aria-controls={`${ids}-${id}`}
            onClick={() => {
              cancelRecording();
              discardReference();
              setRecordError(null);
              setTab(id);
            }}
            className={cn(
              chip,
              tab === id && "border-numa-slate/40 text-foreground",
            )}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${ids}-${tab}`}
        aria-labelledby={`${ids}-${tab}-tab`}
        className="flex flex-col gap-4"
      >
        {(tab === "record" || tab === "upload") && cloneReason && (
          <p className="text-xs leading-relaxed text-numa-slate/75">
            Unavailable: {cloneReason}
          </p>
        )}
        {tab === "describe" && designReason && (
          <p className="text-xs leading-relaxed text-numa-slate/75">
            Unavailable: {designReason}
          </p>
        )}

        {tab === "record" && !cloneReason && (
          <>
            <p className="text-xs leading-relaxed text-numa-slate/80">
              Read this aloud in a quiet room, 20–30 cm from the microphone, in
              your normal speaking voice. 10–20 seconds works best (up to{" "}
              {MAX_SECONDS}).
            </p>
            <blockquote className="border-l-2 border-numa-mint/50 pl-3 text-sm leading-relaxed text-foreground/90">
              {READING_PASSAGE}
            </blockquote>
            {recorder ? (
              <div className="flex items-center gap-3">
                <button type="button" className={chip} onClick={stopRecording}>
                  <Square aria-hidden="true" className="size-3 fill-current" />
                  Stop
                </button>
                <button
                  type="button"
                  className={chip}
                  onClick={cancelRecording}
                >
                  <X aria-hidden="true" className="size-3.5" />
                  Cancel
                </button>
                <span
                  className="text-xs tabular-nums text-numa-slate"
                  aria-live="off"
                >
                  {formatDuration(elapsed * 1000)} /{" "}
                  {formatDuration(MAX_SECONDS * 1000)}
                </span>
                <span
                  aria-hidden="true"
                  className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]"
                >
                  <span
                    className="block h-full bg-numa-mint"
                    style={{ width: `${Math.round(level * 100)}%` }}
                  />
                </span>
                <span className="sr-only">Recording</span>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  className={chip}
                  disabled={blocked || busy}
                  onClick={() => void record()}
                >
                  {reference ? (
                    <RotateCcw aria-hidden="true" className="size-3.5" />
                  ) : (
                    <Mic aria-hidden="true" className="size-3.5" />
                  )}
                  {reference ? "Record again" : "Record"}
                </button>
                {reference && (
                  <button
                    type="button"
                    className={chip}
                    onClick={discardReference}
                  >
                    <X aria-hidden="true" className="size-3.5" />
                    Discard
                  </button>
                )}
              </div>
            )}
            {referenceSummary}
            {reference && (
              <>
                {nameField}
                {consentField}
                {createButton("recorded")}
              </>
            )}
          </>
        )}

        {tab === "upload" && !cloneReason && (
          <>
            <p className="text-xs leading-relaxed text-numa-slate/80">
              A clear recording of one speaker, 3–{MAX_SECONDS} s, without music
              (WAV, MP3, M4A, OGG or WebM; up to 15 MB). Only use a voice you
              own or have permission to use.
            </p>
            <input
              type="file"
              accept="audio/*"
              aria-label="Voice recording file"
              disabled={blocked || busy}
              onChange={(e) => void onFile(e)}
              className="text-xs text-numa-slate file:mr-3 file:rounded-full file:border file:border-border file:bg-transparent file:px-3 file:py-1.5 file:text-xs file:text-numa-slate"
            />
            {referenceSummary}
            {reference && (
              <>
                {nameField}
                {consentField}
                {createButton("uploaded")}
              </>
            )}
          </>
        )}

        {tab === "describe" && !designReason && (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-numa-slate/80">
                Describe the voice
              </span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={300}
                rows={3}
                placeholder="A soft, warm and calm female voice, unhurried and gentle."
                className={cn(field, "resize-none")}
              />
            </label>
            <button
              type="button"
              className={chip}
              disabled={blocked || busy || description.trim().length < 10}
              onClick={() => void design()}
            >
              {studio.pending === "design" ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                />
              ) : (
                <Sparkles aria-hidden="true" className="size-3.5" />
              )}
              {studio.pending === "design"
                ? "Generating three voices…"
                : "Generate three voices"}
            </button>
            {candidates && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-xs text-numa-slate/80">
                  Choose one
                </legend>
                {candidates.candidates.map((c) => {
                  const key = `candidate:${c.index}`;
                  return (
                    <div
                      key={c.index}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <label className="flex items-center gap-2 text-sm text-foreground">
                        <input
                          type="radio"
                          name={`${ids}-candidate`}
                          checked={chosen === c.index}
                          onChange={() => setChosen(c.index)}
                          className="accent-[#7DDCC9]"
                        />
                        Voice {c.index + 1}
                      </label>
                      <button
                        type="button"
                        className={chip}
                        aria-label={`Play voice ${c.index + 1}`}
                        onClick={() =>
                          studio.playing === key
                            ? studio.stopPreview()
                            : void studio.playClip(base64Wav(c.audio), key)
                        }
                      >
                        {studio.playing === key ? (
                          <Square
                            aria-hidden="true"
                            className="size-3 fill-current"
                          />
                        ) : (
                          <Play aria-hidden="true" className="size-3.5" />
                        )}
                        {studio.playing === key ? "Stop" : "Play"}
                      </button>
                      <button
                        type="button"
                        className={chip}
                        disabled={blocked || busy}
                        aria-label={`Hear voice ${c.index + 1} say the preview text`}
                        onClick={() =>
                          void studio.preview(
                            {
                              candidate: {
                                token: candidates.token,
                                index: c.index,
                              },
                            },
                            previewText,
                            `try:${c.index}`,
                          )
                        }
                      >
                        {studio.pending === `preview:try:${c.index}`
                          ? "Generating"
                          : "Try preview text"}
                      </button>
                    </div>
                  );
                })}
                {chosen !== null && (
                  <>
                    {nameField}
                    <button
                      type="button"
                      className={primaryChip}
                      disabled={name.trim() === "" || busy}
                      onClick={() => void saveDesign()}
                    >
                      <Check aria-hidden="true" className="size-3.5" />
                      {studio.pending === "save-design"
                        ? "Saving…"
                        : "Save voice"}
                    </button>
                  </>
                )}
              </fieldset>
            )}
          </>
        )}

        {recordError && (
          <p role="alert" className="text-xs text-numa-coral">
            {recordError}
          </p>
        )}
      </div>
    </div>
  );
}
