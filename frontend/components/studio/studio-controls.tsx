"use client";

import { AudioLines, LoaderCircle, Mic, MicOff, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConversationStatus } from "@/lib/state/conversation-machine";
import { isSessionActive } from "@/lib/state/conversation-machine";
import { cn } from "@/lib/utils";

export interface StudioControlsProps {
  status: ConversationStatus;
  onStart: () => void;
  onEnd: () => void;
  onToggleMute: () => void;
  startLabel?: string;
  endLabel?: string;
}

const MUTABLE: ConversationStatus[] = [
  "listening",
  "processing",
  "speaking",
  "muted",
];

export function StudioControls({
  status,
  onStart,
  onEnd,
  onToggleMute,
  startLabel = "Start conversation",
  endLabel = "End conversation",
}: StudioControlsProps) {
  const active = isSessionActive(status);
  const muted = status === "muted";
  const canMute = MUTABLE.includes(status);

  return (
    <div className="flex items-center justify-center gap-3 sm:gap-4">
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-pressed={muted}
        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
        disabled={!canMute}
        onClick={onToggleMute}
        className={cn(
          "size-14 rounded-full border-border bg-transparent text-foreground shadow-none transition-[background-color,border-color,transform] duration-200 ease-numa active:scale-[0.96] [&_svg:not([class*='size-'])]:size-5",
          "hover:border-numa-slate/40 hover:bg-white/[0.04]",
          muted && "border-numa-slate/50 bg-white/[0.06] text-numa-slate",
        )}
      >
        {muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
      </Button>

      {active ? (
        <Button
          type="button"
          variant="outline"
          onClick={onEnd}
          className="h-14 min-w-44 rounded-full px-6 sm:min-w-56 sm:px-8 border-border bg-transparent text-[15px] font-medium text-foreground shadow-none transition-[background-color,border-color,color,transform] duration-200 ease-numa hover:border-numa-coral/60 hover:bg-numa-coral/10 hover:text-numa-coral active:scale-[0.98] [&_svg:not([class*='size-'])]:size-4"
        >
          <Square aria-hidden="true" className="fill-current" />
          {endLabel}
        </Button>
      ) : (
        <Button
          type="button"
          onClick={onStart}
          className="h-14 min-w-44 rounded-full px-6 sm:min-w-56 sm:px-8 bg-numa-mint text-[15px] font-semibold text-primary-foreground shadow-[0_0_0_1px_rgba(125,220,201,0.2),0_8px_30px_-12px_rgba(125,220,201,0.45)] transition-[background-color,box-shadow,transform] duration-200 ease-numa hover:bg-[#8fe4d2] active:scale-[0.98] focus-visible:ring-offset-2 focus-visible:ring-offset-background [&_svg:not([class*='size-'])]:size-5"
        >
          <AudioLines aria-hidden="true" />
          {status === "ended" || status === "error"
            ? "Start again"
            : startLabel}
        </Button>
      )}

      <span
        className="flex size-14 items-center justify-center"
        aria-hidden="true"
      >
        {status === "connecting" && (
          <LoaderCircle className="size-5 animate-spin text-numa-slate motion-reduce:animate-none" />
        )}
      </span>
    </div>
  );
}
