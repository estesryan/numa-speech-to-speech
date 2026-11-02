import { formatDuration } from "@/lib/format";
import type { TranscriptEntry } from "@/lib/schemas/transcript";
import { cn } from "@/lib/utils";

export interface TranscriptPanelProps {
  id: string;
  entries: readonly TranscriptEntry[];
  /** Whether speech recognition is connected (a session with the voice engine is running). */
  available?: boolean;
  /** Clears the displayed transcript only (after confirmation); the conversation itself carries on. */
  onClear?: () => void;
  confirm?: (message: string) => boolean;
  className?: string;
}

export const CLEAR_TRANSCRIPT_PROMPT =
  "Clear the transcript? This only clears what is shown here; the conversation continues.";

/**
 * Live transcript of both speakers, from the voice engine's recognition and Numa's reply text. Without a
 * connected engine the panel says so instead of showing anything derived from the microphone.
 */
export function TranscriptPanel({
  id,
  entries,
  available = false,
  onClear,
  confirm = (message) => window.confirm(message),
  className,
}: TranscriptPanelProps) {
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
          Transcript
        </h2>
        <div className="flex items-baseline gap-3">
          <span className="text-xs text-numa-slate/60">
            {entries.length > 0 ? `${entries.length} turns` : "Live"}
          </span>
          {onClear && entries.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (confirm(CLEAR_TRANSCRIPT_PROMPT)) {
                  onClear();
                }
              }}
              className="rounded-full text-xs text-numa-slate/60 transition-colors duration-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Clear
            </button>
          )}
        </div>
      </header>

      {entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-start gap-3 px-6 pb-8">
          <div className="flex gap-1" aria-hidden="true">
            {[10, 16, 12, 20, 14].map((h) => (
              <span
                key={h}
                className="w-1 rounded-full bg-numa-slate/25"
                style={{ height: h }}
              />
            ))}
          </div>
          <p className="text-sm text-foreground/90">No transcript yet.</p>
          <p className="max-w-[34ch] text-sm leading-relaxed text-numa-slate/75">
            {available
              ? "Both sides of the conversation will appear here as they are spoken."
              : "Speech recognition isn't connected. Start a session with the local voice engine running, and both sides of the conversation will appear here as they are spoken."}
          </p>
        </div>
      ) : (
        <ol
          className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 pb-8"
          aria-live="polite"
        >
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2 text-xs">
                <span
                  className={cn(
                    "font-semibold",
                    entry.speaker === "host"
                      ? "text-numa-mint"
                      : "text-foreground",
                  )}
                >
                  {entry.speakerName ??
                    (entry.speaker === "host" ? "Numa" : "You")}
                </span>
                <time className="tabular-nums text-numa-slate/60">
                  {formatDuration(entry.startedAtMs)}
                </time>
              </div>
              <p className="text-[15px] leading-relaxed text-foreground/90">
                {entry.text}
                {entry.interrupted && (
                  <>
                    <span aria-hidden="true" className="text-numa-slate/60">
                      {entry.text ? " —" : "—"}
                    </span>
                    <span className="sr-only"> (interrupted)</span>
                  </>
                )}
                {entry.status === "streaming" && (
                  <>
                    <span
                      aria-hidden="true"
                      className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-numa-mint motion-safe:animate-pulse"
                    />
                    <span className="sr-only"> (still speaking)</span>
                  </>
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
