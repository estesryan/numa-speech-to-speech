/** Reference audio for voice cloning: browser-side checks (mirroring the engine's) and WAV encoding. */

export const MIN_SECONDS = 3;
export const MAX_SECONDS = 30;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export interface ReferenceCheck {
  durationS: number;
  rmsDbfs: number;
  clipped: number;
  /** Why the engine would refuse it; null if it looks suitable. */
  problem: string | null;
}

/** Speech duration (leading/trailing silence below -45 dBFS ignored), loudness and clipping, as the engine checks. */
export function checkReference(
  samples: Float32Array,
  sampleRate: number,
): ReferenceCheck {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const threshold = 10 ** (-45 / 20);
  let first = -1;
  let last = -1;
  let sum = 0;
  let clippedCount = 0;
  for (let f = 0; f * frame < samples.length; f++) {
    let energy = 0;
    const end = Math.min(samples.length, (f + 1) * frame);
    for (let i = f * frame; i < end; i++) {
      const s = samples[i] ?? 0;
      energy += s * s;
      if (Math.abs(s) >= 0.999) {
        clippedCount++;
      }
    }
    sum += energy;
    if (Math.sqrt(energy / (end - f * frame)) > threshold) {
      if (first === -1) {
        first = f;
      }
      last = f;
    }
  }
  const durationS =
    first === -1 ? 0 : ((last - first + 1) * frame) / sampleRate;
  const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
  const rmsDbfs = rms > 0 ? 20 * Math.log10(rms) : -120;
  const clipped = samples.length ? clippedCount / samples.length : 0;
  let problem: string | null = null;
  if (first === -1 || rmsDbfs < -40) {
    problem = "Too quiet. Move closer to the microphone.";
  } else if (durationS < MIN_SECONDS) {
    problem = `Only ${durationS.toFixed(1)} s of speech; record at least ${MIN_SECONDS} s (10–20 s works best).`;
  } else if (durationS > MAX_SECONDS) {
    problem = `${Math.round(durationS)} s of speech; use at most ${MAX_SECONDS} s.`;
  } else if (clipped > 0.005) {
    problem = "Distorted (clipping). Move back from the microphone.";
  }
  return { durationS, rmsDbfs, clipped, problem };
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      data.setUint8(offset + i, s.charCodeAt(i));
    }
  };
  text(0, "RIFF");
  data.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, sampleRate, true);
  data.setUint32(28, sampleRate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, "data");
  data.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    data.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([data.buffer], { type: "audio/wav" });
}

/** Decode any format the browser can play (WAV, MP3, M4A, OGG, WebM...) to mono samples. */
export async function decodeToMono(
  data: ArrayBuffer,
  createContext: () => BaseAudioContext = () =>
    new OfflineAudioContext(1, 1, 48000),
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const context = createContext();
  const buffer = await context.decodeAudioData(data);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) {
      mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / buffer.numberOfChannels;
    }
  }
  return { samples: mono, sampleRate: buffer.sampleRate };
}
