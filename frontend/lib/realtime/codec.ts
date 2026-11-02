/**
 * PCM helpers for the Realtime protocol: the voice engine's pipeline runs at 16 kHz mono PCM16 in both
 * directions, so the browser converts its microphone rate down and plays the engine's audio at 16 kHz.
 */

export const ENGINE_SAMPLE_RATE = 16000;

/** Downsample by averaging each output sample's input window (a simple low-pass that avoids aliasing). */
export function downsample(
  input: Float32Array,
  inputRate: number,
  outputRate = ENGINE_SAMPLE_RATE,
): Float32Array {
  if (inputRate === outputRate) {
    return input.slice();
  }
  if (inputRate < outputRate) {
    throw new Error(`cannot upsample ${inputRate} Hz to ${outputRate} Hz`);
  }
  const ratio = inputRate / outputRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += input[j] ?? 0;
    }
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** A streaming downsampler: keeps the fractional remainder between chunks so no samples are lost or doubled. */
export class StreamingDownsampler {
  private pending = new Float32Array(0);

  constructor(
    readonly inputRate: number,
    readonly outputRate = ENGINE_SAMPLE_RATE,
  ) {}

  push(chunk: Float32Array): Float32Array {
    const joined = new Float32Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    const ratio = this.inputRate / this.outputRate;
    const usable = Math.floor(Math.floor(joined.length / ratio) * ratio);
    this.pending = joined.slice(usable);
    return downsample(
      joined.subarray(0, usable),
      this.inputRate,
      this.outputRate,
    );
  }
}

export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
