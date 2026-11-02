import {
  MODEL_STATUS_LABEL,
  type ModelConnectionStatus,
} from "@/lib/backend/model-status";
import { cn } from "@/lib/utils";

/** "● Local model", Numa's status cluster, reporting the real backend connection. */
export function ModelStatus({ status }: { status: ModelConnectionStatus }) {
  const label = MODEL_STATUS_LABEL[status];
  return (
    <output
      className="flex items-center gap-2.5 text-sm text-numa-slate"
      aria-label={`Local model: ${label}`}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2.5 rounded-full",
          status === "connected" && "bg-numa-mint",
          status === "connecting" &&
            "bg-numa-mint/60 motion-safe:animate-pulse",
          status === "not-connected" && "border border-numa-slate/60",
          status === "error" && "bg-numa-coral",
        )}
      />
      <span>Local model</span>
      <span className="text-numa-slate/60">·</span>
      <span className="text-numa-slate/80">{label}</span>
    </output>
  );
}
