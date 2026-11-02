import type { ReactNode } from "react";
import type { ModelConnectionStatus } from "@/lib/backend/model-status";
import type { ModeConfig } from "@/lib/session/modes";
import { ModelStatus } from "./model-status";
import { Wordmark } from "./wordmark";

/** Numa's header: wordmark, connection status, page actions. */
export function AppHeader({
  mode,
  connection,
  children,
}: {
  mode: ModeConfig;
  connection: ModelConnectionStatus;
  /** Page actions at the right (the studio's Voice and Transcript buttons). */
  children?: ReactNode;
}) {
  return (
    <>
      <header className="flex items-center justify-between gap-4 px-6 pt-6 sm:px-10 sm:pt-8 lg:px-14">
        <h1>
          <Wordmark className="text-[28px] sm:text-[32px]" />
          <span className="sr-only"> {mode.label}</span>
        </h1>
        <div className="flex items-center gap-5 sm:gap-7">
          <span className="hidden sm:flex">
            <ModelStatus status={connection} />
          </span>
          {children}
        </div>
      </header>

      <div className="flex flex-col items-center gap-2 px-6 pt-4 sm:hidden">
        <ModelStatus status={connection} />
      </div>
    </>
  );
}
