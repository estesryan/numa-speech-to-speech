/**
 * Records a voice reference from the microphone, uncompressed, without the browser's echo cancellation or noise
 * suppression (they colour the voice the clone should learn). Uses the same capture worklet as conversations.
 */

import { rms, rmsToLevel } from "@/lib/audio/levels";
import { CAPTURE_WORKLET_URL } from "@/lib/audio/microphone";
import { MAX_SECONDS } from "./wav";

export const REFERENCE_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

export interface Recording {
  samples: Float32Array;
  sampleRate: number;
}

export interface Recorder {
  /** Seconds recorded so far. */
  elapsed(): number;
  /** Current input level, 0..1, for a meter. */
  level(): number;
  stop(): Recording;
  cancel(): void;
}

export interface RecorderEnvironment {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext: () => AudioContext;
}

export function browserRecorderEnvironment(): RecorderEnvironment {
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    createAudioContext: () => new AudioContext(),
  };
}

/** Starts recording; stops by itself after MAX_SECONDS (onLimit is then called). */
export async function startRecording(
  env: RecorderEnvironment = browserRecorderEnvironment(),
  onLimit?: () => void,
): Promise<Recorder> {
  const stream = await env.getUserMedia({
    audio: REFERENCE_CONSTRAINTS,
    video: false,
  });
  let context: AudioContext | null = null;
  const chunks: Float32Array[] = [];
  let collected = 0;
  let latest: Float32Array = new Float32Array(0);
  let finished = false;

  const release = () => {
    finished = true;
    for (const track of stream.getTracks()) {
      track.stop();
    }
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  };

  try {
    context = env.createAudioContext();
    await context.audioWorklet.addModule(CAPTURE_WORKLET_URL);
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "pcm-capture");
    const sink = context.createGain();
    sink.gain.value = 0;
    const rate = context.sampleRate;
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (finished) {
        return;
      }
      latest = event.data;
      chunks.push(event.data);
      collected += event.data.length;
      if (collected >= MAX_SECONDS * rate) {
        onLimit?.();
      }
    };
    source.connect(node);
    node.connect(sink);
    sink.connect(context.destination);
  } catch (error) {
    release();
    throw error;
  }
  const sampleRate = context.sampleRate;

  return {
    elapsed: () => collected / sampleRate,
    level: () => (finished ? 0 : rmsToLevel(rms(latest))),
    stop() {
      release();
      const samples = new Float32Array(collected);
      let offset = 0;
      for (const chunk of chunks) {
        samples.set(
          chunk.subarray(0, Math.min(chunk.length, collected - offset)),
          offset,
        );
        offset += chunk.length;
      }
      return {
        samples: samples.subarray(
          0,
          Math.min(collected, MAX_SECONDS * sampleRate),
        ),
        sampleRate,
      };
    },
    cancel: release,
  };
}
