import { cn } from "@/lib/utils";

/** The "numa." wordmark: Inter 700, white, tight tracking (-1.5 at 45px). */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-bold tracking-[-0.033em] text-numa-ink select-none",
        className,
      )}
    >
      numa<span className="text-numa-mint">.</span>
    </span>
  );
}
