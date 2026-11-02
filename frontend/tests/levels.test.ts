import { describe, expect, it } from "vitest";
import {
  CEILING_DB,
  FLOOR_DB,
  LevelHistory,
  rms,
  rmsToLevel,
  smoothLevel,
} from "@/lib/audio/levels";

describe("audio levels", () => {
  it("computes RMS", () => {
    expect(rms([])).toBe(0);
    expect(rms([0, 0, 0])).toBe(0);
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
  });

  it("maps silence to 0, the floor to 0 and the ceiling to 1", () => {
    expect(rmsToLevel(0)).toBe(0);
    expect(rmsToLevel(Number.NaN)).toBe(0);
    expect(rmsToLevel(10 ** (FLOOR_DB / 20))).toBeCloseTo(0);
    expect(rmsToLevel(10 ** (CEILING_DB / 20))).toBeCloseTo(1);
    expect(rmsToLevel(1)).toBe(1);
    const mid = rmsToLevel(10 ** ((FLOOR_DB + CEILING_DB) / 2 / 20));
    expect(mid).toBeCloseTo(0.5);
  });

  it("rises faster than it falls", () => {
    const up = smoothLevel(0, 1);
    const down = 1 - smoothLevel(1, 0);
    expect(up).toBeGreaterThan(down);
  });

  it("keeps a fixed-length history, oldest first", () => {
    const h = new LevelHistory(3);
    expect(h.values()).toEqual([0, 0, 0]);
    h.push(0.25);
    h.push(0.5);
    h.push(0.75);
    h.push(2); // clamped
    expect(h.values()).toEqual([0.5, 0.75, 1]);
    h.clear();
    expect(h.values()).toEqual([0, 0, 0]);
  });
});
