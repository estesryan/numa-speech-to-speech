import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  downsample,
  floatToPcm16,
  pcm16ToFloat,
  StreamingDownsampler,
} from "@/lib/realtime/codec";

describe("PCM codec", () => {
  it("downsamples 48 kHz to 16 kHz by averaging", () => {
    const input = Float32Array.from([0.3, 0.3, 0.3, -0.6, -0.6, -0.6]);
    expect(Array.from(downsample(input, 48000))).toEqual([
      expect.closeTo(0.3),
      expect.closeTo(-0.6),
    ]);
  });

  it("keeps the remainder between streamed chunks, so no samples are lost", () => {
    const d = new StreamingDownsampler(44100);
    let total = 0;
    for (let i = 0; i < 100; i++) {
      total += d.push(new Float32Array(441)).length; // 10 ms chunks
    }
    expect(total).toBeGreaterThanOrEqual(15999); // one second in, one second out
    expect(total).toBeLessThanOrEqual(16000);
  });

  it("round-trips PCM16 and base64", () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const bytes = floatToPcm16(samples);
    expect(bytes.length).toBe(10);
    const back = pcm16ToFloat(base64ToBytes(bytesToBase64(bytes)));
    back.forEach((v, i) => {
      expect(v).toBeCloseTo(samples[i] ?? 0, 3);
    });
  });

  it("clips out-of-range samples", () => {
    expect(
      Array.from(pcm16ToFloat(floatToPcm16(Float32Array.from([2, -2])))),
    ).toEqual([expect.closeTo(1, 3), -1]);
  });
});
