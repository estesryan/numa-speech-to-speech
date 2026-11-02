"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import {
  LevelHistory,
  type LevelSource,
  smoothLevel,
} from "@/lib/audio/levels";
import { cn } from "@/lib/utils";

export type WaveformState =
  | "idle"
  | "listening"
  | "processing"
  | "speaking"
  | "muted"
  | "error";

/** Bar heights of the Numa waveform signature (52 bars), the resting silhouette. */
export const SIGNATURE = [
  29, 37, 48, 55, 46, 47, 69, 79, 75, 54, 88, 111, 111, 69, 99, 139, 117, 80,
  120, 166, 180, 130, 93, 149, 200, 146, 95, 159, 196, 149, 90, 144, 172, 131,
  82, 129, 143, 113, 67, 101, 113, 88, 58, 61, 80, 77, 59, 45, 59, 51, 45, 39,
].map((h) => h / 200);

/** Spatial taper for live levels: a smoothed signature envelope, so live audio keeps the Numa silhouette. */
const TAPER = SIGNATURE.map((_, i) => {
  let sum = 0;
  let n = 0;
  for (
    let j = Math.max(0, i - 6);
    j <= Math.min(SIGNATURE.length - 1, i + 6);
    j++
  ) {
    sum += SIGNATURE[j] ?? 0;
    n++;
  }
  return sum / n;
}).map((v, _, all) => 0.32 + (0.68 * v) / Math.max(...all));

const BAR_RATIO = 0.53; // bar width / pitch of the Numa waveform
const SAMPLE_MS = 50; // one bar of live history per 50 ms: the waveform spans about 2.6 s
const SAMPLE_MS_REDUCED = 150;

const COLORS: Record<WaveformState, string> = {
  idle: "120, 221, 200", // #78DDC8
  listening: "120, 221, 200",
  speaking: "236, 241, 245",
  processing: "181, 193, 206", // #B5C1CE
  muted: "181, 193, 206",
  error: "232, 160, 145",
};

const LABELS: Record<WaveformState, string> = {
  idle: "Waveform at rest",
  listening: "Live microphone level",
  processing: "Processing indicator (not audio)",
  speaking: "Numa speech level",
  muted: "Microphone muted",
  error: "Waveform unavailable",
};

export interface WaveformProps {
  state: WaveformState;
  /** Real audio levels for listening (microphone) or speaking (Numa's output). Never synthesized. */
  levels?: LevelSource | null;
  /** Override the user's motion preference (tests, previews). */
  reducedMotion?: boolean;
  className?: string;
}

export function Waveform({
  state,
  levels = null,
  reducedMotion,
  className,
}: WaveformProps) {
  const prefersReduced = useReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef(new LevelHistory(SIGNATURE.length));
  const heightsRef = useRef<number[]>(SIGNATURE.map(() => 0));

  // Fresh history whenever the waveform starts following a different source or state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: both values are reset triggers, not read inside
  useEffect(() => {
    historyRef.current.clear();
  }, [state, levels]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;
    if (!canvas || !ctx) {
      return;
    }
    let frame = 0;
    let running = true;
    let lastSample = 0;
    let smoothed = 0;
    const live = state === "listening" || state === "speaking";
    const animated = live || (state === "processing" && !reduced);
    const sampleMs = reduced ? SAMPLE_MS_REDUCED : SAMPLE_MS;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const targets = (time: number): { heights: number[]; alphas: number[] } => {
      const n = SIGNATURE.length;
      if (live) {
        const values = historyRef.current.values();
        return {
          heights: values.map((v, i) => v * (TAPER[i] ?? 1)),
          alphas: values.map(() => 1),
        };
      }
      if (state === "processing") {
        // A deliberate sweep over a fixed silhouette: brightness moves, heights never change, so it cannot be
        // mistaken for audio input.
        const centre = reduced ? -100 : ((time / 1800) % 1) * (n + 16) - 8;
        return {
          heights: SIGNATURE.map((s) => s * 0.34),
          alphas: SIGNATURE.map(
            (_, i) => 0.32 + 0.6 * Math.exp(-((i - centre) ** 2) / 18),
          ),
        };
      }
      if (state === "muted") {
        return {
          heights: SIGNATURE.map(() => 0),
          alphas: SIGNATURE.map(() => 0.38),
        };
      }
      if (state === "error") {
        return {
          heights: SIGNATURE.map((s) => s * 0.22),
          alphas: SIGNATURE.map(() => 0.6),
        };
      }
      return {
        heights: SIGNATURE.map((s) => s * 0.46),
        alphas: SIGNATURE.map(() => 0.5),
      };
    };

    const draw = (time: number) => {
      if (!running) {
        return;
      }
      if (live && time - lastSample >= sampleMs) {
        const level = levels ? levels.readLevel() : 0;
        smoothed = reduced ? level : smoothLevel(smoothed, level);
        historyRef.current.push(smoothed);
        lastSample = time;
      }
      const { width, height } = canvas.getBoundingClientRect();
      const { heights, alphas } = targets(time);
      const n = SIGNATURE.length;
      const pitch = width / n;
      const barWidth = Math.max(2, pitch * BAR_RATIO);
      const minHeight = barWidth;
      const maxHeight = height * 0.92;
      const mid = height / 2;
      const color = COLORS[state];
      let settled = true;

      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < n; i++) {
        const target = heights[i] ?? 0;
        const current = heightsRef.current[i] ?? 0;
        const next = reduced
          ? target
          : current + (target - current) * (live ? 0.5 : 0.14);
        if (Math.abs(next - target) > 0.002) {
          settled = false;
        }
        heightsRef.current[i] = next;
        const h = minHeight + (maxHeight - minHeight) * next;
        const x = i * pitch + (pitch - barWidth) / 2;
        ctx.fillStyle = `rgba(${color}, ${alphas[i] ?? 1})`;
        ctx.beginPath();
        ctx.roundRect(x, mid - h / 2, barWidth, h, barWidth / 2);
        ctx.fill();
      }
      if (animated || !settled) {
        frame = requestAnimationFrame(draw);
      }
    };

    resize();
    const observer = new ResizeObserver(() => {
      resize();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    });
    observer.observe(canvas);
    frame = requestAnimationFrame(draw);
    return () => {
      running = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [state, levels, reduced]);

  return (
    <div
      role="img"
      aria-label={LABELS[state]}
      data-state={state}
      data-reduced-motion={reduced ? "true" : "false"}
      className={cn("relative w-full", className)}
    >
      {/* presentational: the role="img" wrapper carries the accessible name */}
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
