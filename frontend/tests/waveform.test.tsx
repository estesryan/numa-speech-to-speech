import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SIGNATURE,
  Waveform,
  type WaveformState,
} from "@/components/studio/waveform";
import { formatDuration } from "@/lib/format";

describe("Waveform", () => {
  it.each<[WaveformState, string]>([
    ["idle", "Waveform at rest"],
    ["listening", "Live microphone level"],
    ["processing", "Processing indicator (not audio)"],
    ["speaking", "Numa speech level"],
    ["muted", "Microphone muted"],
    ["error", "Waveform unavailable"],
  ])("describes the %s state accessibly", (state, label) => {
    render(<Waveform state={state} />);
    const img = screen.getByRole("img", { name: label });
    expect(img).toHaveAttribute("data-state", state);
  });

  it("honours an explicit reduced-motion preference", () => {
    render(<Waveform state="processing" reducedMotion />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "data-reduced-motion",
      "true",
    );
  });

  it("follows the system reduced-motion preference by default", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...original(query),
      matches: query.includes("prefers-reduced-motion"),
    })) as typeof window.matchMedia;
    render(<Waveform state="idle" />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "data-reduced-motion",
      "true",
    );
    window.matchMedia = original;
  });

  it("uses the 52-bar signature from the Numa panel asset", () => {
    expect(SIGNATURE).toHaveLength(52);
    expect(Math.max(...SIGNATURE)).toBe(1);
    expect(SIGNATURE[0]).toBeCloseTo(29 / 200);
  });
});

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(7_900)).toBe("0:07");
    expect(formatDuration(754_000)).toBe("12:34");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
    expect(formatDuration(-5)).toBe("0:00");
  });
});
