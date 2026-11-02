"use client";

import {
  type ConversationStatus,
  canTransition,
} from "@/lib/state/conversation-machine";

/**
 * Development-only controls that drive the processing / speaking states without a backend, so their visuals can be
 * reviewed. They produce no audio and no transcript. Not rendered in production builds.
 */
export function DevSimulation({
  status,
  onSimulate,
}: {
  status: ConversationStatus;
  onSimulate: (event: "processing" | "speaking" | "done") => void;
}) {
  const button =
    "rounded-full border border-border px-3 py-1.5 text-xs text-numa-slate transition-colors duration-200 hover:border-numa-slate/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <aside
      aria-label="Development simulation"
      className="flex flex-wrap items-center gap-2 rounded-2xl border border-dashed border-numa-slate/25 px-4 py-3"
    >
      <span className="mr-1 text-[11px] font-medium tracking-[0.1em] text-numa-slate/70 uppercase">
        Dev simulation
      </span>
      <button
        type="button"
        className={button}
        disabled={!canTransition(status, "PROCESSING_STARTED")}
        onClick={() => onSimulate("processing")}
      >
        Processing
      </button>
      <button
        type="button"
        className={button}
        disabled={!canTransition(status, "SPEECH_STARTED")}
        onClick={() => onSimulate("speaking")}
      >
        Speaking
      </button>
      <button
        type="button"
        className={button}
        disabled={!canTransition(status, "SPEECH_ENDED")}
        onClick={() => onSimulate("done")}
      >
        Back to listening
      </button>
    </aside>
  );
}
