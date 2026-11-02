import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

export function SessionTimer({
  elapsedMs,
  active,
}: {
  elapsedMs: number;
  active: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <time
        dateTime={`PT${Math.floor(elapsedMs / 1000)}S`}
        className={cn(
          "text-4xl font-light tracking-[-0.02em] tabular-nums transition-colors duration-300 sm:text-5xl",
          active ? "text-numa-ink" : "text-numa-slate/55",
        )}
      >
        {formatDuration(elapsedMs)}
      </time>
      <span className="text-xs tracking-[0.12em] text-numa-slate/60 uppercase">
        Session<span className="sr-only"> duration</span>
      </span>
    </div>
  );
}
