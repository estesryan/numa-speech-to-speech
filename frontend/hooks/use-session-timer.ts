"use client";

import { useEffect, useState } from "react";

/**
 * Elapsed milliseconds of a session. Ticks while `running`; when stopped it shows endedAt - startedAt.
 * Time is read only in effects, never during render.
 */
export function useSessionTimer(
  startedAt: number | null,
  endedAt: number | null,
  running: boolean,
): number {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!running || startedAt === null) {
      return;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [running, startedAt]);

  if (startedAt === null) {
    return 0;
  }
  if (!running) {
    return endedAt === null ? 0 : endedAt - startedAt;
  }
  return now === null ? 0 : Math.max(0, now - startedAt);
}
