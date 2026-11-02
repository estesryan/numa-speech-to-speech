/**
 * Pure audio-level helpers. Levels are normalized to [0, 1] on a decibel scale so quiet speech is still visible.
 */

/** A source of real audio levels, read once per animation frame: the microphone or the engine's speech output. */
export interface LevelSource {
  /** Current level in [0, 1]. Must reflect real audio; never synthesized. */
  readLevel(): number;
}

export const FLOOR_DB = -60;
export const CEILING_DB = -12;

/** Root-mean-square amplitude of time-domain samples in [-1, 1]. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/** Map an RMS amplitude to [0, 1] between FLOOR_DB (silence) and CEILING_DB (loud speech). */
export function rmsToLevel(
  value: number,
  floorDb = FLOOR_DB,
  ceilingDb = CEILING_DB,
): number {
  if (!(value > 0)) {
    return 0;
  }
  const db = 20 * Math.log10(value);
  return clamp01((db - floorDb) / (ceilingDb - floorDb));
}

/** Asymmetric smoothing: rise quickly to new peaks, fall back more slowly. */
export function smoothLevel(
  previous: number,
  next: number,
  attack = 0.6,
  release = 0.15,
): number {
  const k = next > previous ? attack : release;
  return previous + (next - previous) * k;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Fixed-length history of levels, oldest first. */
export class LevelHistory {
  private readonly buffer: Float32Array;
  private start = 0;

  constructor(readonly size: number) {
    this.buffer = new Float32Array(size);
  }

  push(level: number): void {
    this.buffer[this.start] = clamp01(level);
    this.start = (this.start + 1) % this.size;
  }

  clear(): void {
    this.buffer.fill(0);
    this.start = 0;
  }

  /** Levels from oldest to newest. */
  values(): number[] {
    const out = new Array<number>(this.size);
    for (let i = 0; i < this.size; i++) {
      out[i] = this.buffer[(this.start + i) % this.size] ?? 0;
    }
    return out;
  }
}
