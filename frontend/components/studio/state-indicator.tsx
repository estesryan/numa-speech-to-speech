import type { ConversationState } from "@/lib/state/conversation-machine";
import { cn } from "@/lib/utils";

export interface StateCopy {
  label: string;
  detail: string;
}

/** How a session is described: `host` is null for the microphone-only preview (no voice engine). */
export interface StateContext {
  host: string | null;
  idle?: string;
}

const PREVIEW: StateContext = { host: null };

const CONNECTION_LABEL: Partial<Record<string, string>> = {
  "backend-unavailable": "Voice engine unavailable",
  "backend-error": "Voice engine unavailable",
  "session-busy": "Voice engine busy",
  "connection-lost": "Connection lost",
};

export function describeState(
  state: ConversationState,
  context: StateContext = PREVIEW,
): StateCopy {
  const simulated = state.source === "simulation" ? " (simulated)" : "";
  const { host } = context;
  switch (state.status) {
    case "idle":
      return {
        label: "Ready",
        detail:
          context.idle ?? "Start a local preview to check your microphone.",
      };
    case "connecting":
      return host
        ? {
            label: "Connecting",
            detail:
              "Allow microphone access; connecting to the local voice engine.",
          }
        : {
            label: "Requesting microphone",
            detail: "Allow microphone access in your browser.",
          };
    case "listening":
      return host
        ? {
            label: "Listening",
            detail: "Speak naturally. You can interrupt at any time.",
          }
        : {
            label: "Listening · Preview",
            detail: "Your microphone is live in this browser only.",
          };
    case "processing":
      return {
        label: `Processing${simulated}`,
        detail: host
          ? `Waiting for ${host} to respond.`
          : "Waiting for Numa to respond.",
      };
    case "speaking":
      return host
        ? {
            label: `${host} speaking`,
            detail: "Just start talking to interrupt.",
          }
        : {
            label: `Numa speaking${simulated}`,
            detail:
              state.source === "simulation"
                ? "No speech audio exists yet."
                : "Numa's audio is playing.",
          };
    case "muted":
      return {
        label: "Muted",
        detail: "Your microphone is silenced. The device stays open.",
      };
    case "error":
      return {
        label:
          CONNECTION_LABEL[state.error?.code ?? ""] ?? "Microphone unavailable",
        detail: state.error?.message ?? "Something went wrong.",
      };
    case "ended":
      return {
        label: "Session ended",
        detail: host
          ? "The microphone and the voice engine connection have been released."
          : "The microphone has been released.",
      };
  }
}

const DOT: Record<ConversationState["status"], string> = {
  idle: "bg-numa-slate/50",
  connecting: "bg-numa-slate motion-safe:animate-pulse",
  listening: "bg-numa-mint",
  processing: "bg-numa-slate motion-safe:animate-pulse",
  speaking: "bg-[#ecf1f5]",
  muted: "border border-numa-slate/70",
  error: "bg-numa-coral",
  ended: "bg-numa-slate/50",
};

export function StateIndicator({
  state,
  context,
}: {
  state: ConversationState;
  context?: StateContext;
}) {
  const { label } = describeState(state, context);
  return (
    <div className="flex items-center gap-2.5" data-status={state.status}>
      <span
        aria-hidden="true"
        className={cn(
          "size-2 rounded-full transition-colors duration-300",
          DOT[state.status],
        )}
      />
      <span className="text-[13px] font-medium tracking-[0.08em] text-numa-slate uppercase">
        {label}
      </span>
    </div>
  );
}
