/**
 * Assistant speech playback, and the accounting the interruption fix needs: how much of each reply was actually played.
 */

import type { LevelSource } from "@/lib/audio/levels";
import { rms, rmsToLevel } from "@/lib/audio/levels";
import { ENGINE_SAMPLE_RATE } from "./codec";

/**
 * Sample accounting, the twin of TrackingPlaybackBuffer in numa_voice/patches/audio_client.py. Every appended
 * sample is eventually consumed: played, or dropped by clear(). A reply's played position is measured from its
 * first sample, so it stays right after earlier replies were cleared.
 */
export class PlaybackLedger {
  appended = 0;
  private base = 0; // consumed up to the last clear()
  private live = 0; // played since the last clear()
  private readonly starts = new Map<string, number>();
  private readonly lengths = new Map<string, number>();

  constructor(readonly sampleRate = ENGINE_SAMPLE_RATE) {}

  get consumed(): number {
    return this.base + this.live;
  }

  append(responseId: string, samples: number): void {
    if (!this.starts.has(responseId)) {
      this.starts.set(responseId, this.appended);
    }
    this.lengths.set(responseId, (this.lengths.get(responseId) ?? 0) + samples);
    this.appended += samples;
  }

  /** Samples played since the last clear(); never more than were queued (silence after the queue runs dry). */
  setPlayed(samples: number): void {
    this.live = Math.max(0, Math.min(samples, this.appended - this.base));
  }

  clear(): void {
    this.base = this.appended;
    this.live = 0;
  }

  playedSeconds(responseId: string): number {
    const start = this.starts.get(responseId);
    if (start === undefined) {
      return 0;
    }
    const played = this.consumed - start;
    return (
      Math.max(0, Math.min(played, this.lengths.get(responseId) ?? 0)) /
      this.sampleRate
    );
  }
}

/** What the voice session needs from playback; AudioPlayback in the browser, a fake in tests. */
export interface Playback extends LevelSource {
  /** Queue PCM samples (engine rate) for a reply. */
  enqueue(responseId: string, samples: Float32Array): void;
  /** Stop and drop everything queued (barge-in). */
  clear(): void;
  playedSeconds(responseId: string): number;
  /** True while queued audio is still playing. */
  readonly playing: boolean;
  /** Called when playback starts after silence, and when the queue runs dry. */
  onActivity(listener: (playing: boolean) => void): void;
  /** Silence the assistant without stopping playback, so the conversation (and its accounting) carries on. */
  setMuted(muted: boolean): void;
  /** True while the browser keeps audio output suspended until the user interacts with the page. */
  readonly blocked: boolean;
  /** Called when output becomes blocked or unblocked. */
  onBlocked(listener: (blocked: boolean) => void): void;
  /** Ask the browser to allow audio output; call it from a click. */
  resume(): Promise<void>;
  close(): void;
}

interface Scheduled {
  node: AudioBufferSourceNode;
  start: number; // context time
  samples: number;
}

const START_LEAD_S = 0.05; // schedule slightly ahead so the first chunk is not clipped

export class AudioPlayback implements Playback {
  readonly ledger = new PlaybackLedger();
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly levelSamples: Float32Array<ArrayBuffer>;
  private scheduled: Scheduled[] = [];
  private finished = 0; // samples of chunks fully played since the last clear()
  private cursor = 0;
  private listener: ((playing: boolean) => void) | null = null;
  private wasPlaying = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private blockedListener: ((blocked: boolean) => void) | null = null;

  constructor(private readonly context: AudioContext) {
    this.gain = context.createGain();
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.levelSamples = new Float32Array(this.analyser.fftSize);
    this.gain.connect(this.analyser);
    this.analyser.connect(context.destination);
    this.timer = setInterval(() => this.tick(), 50);
    context.onstatechange = () => this.blockedListener?.(this.blocked);
  }

  setMuted(muted: boolean): void {
    this.gain.gain.value = muted ? 0 : 1;
  }

  get blocked(): boolean {
    return this.context.state === "suspended";
  }

  onBlocked(listener: (blocked: boolean) => void): void {
    this.blockedListener = listener;
  }

  async resume(): Promise<void> {
    await this.context.resume();
  }

  enqueue(responseId: string, samples: Float32Array): void {
    if (samples.length === 0) {
      return;
    }
    const buffer = this.context.createBuffer(
      1,
      samples.length,
      ENGINE_SAMPLE_RATE,
    );
    buffer.getChannelData(0).set(samples);
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    node.onended = () => node.disconnect();
    const start = Math.max(
      this.cursor,
      this.context.currentTime + START_LEAD_S,
    );
    node.start(start);
    this.cursor = start + buffer.duration;
    this.scheduled.push({ node, start, samples: samples.length });
    this.ledger.append(responseId, samples.length);
    this.tick();
  }

  private syncLedger(): void {
    const now = this.context.currentTime;
    let partial = 0;
    const pending: Scheduled[] = [];
    for (const s of this.scheduled) {
      const played = Math.max(
        0,
        Math.floor((now - s.start) * ENGINE_SAMPLE_RATE),
      );
      if (played >= s.samples) {
        this.finished += s.samples;
      } else {
        partial += played;
        pending.push(s);
      }
    }
    this.scheduled = pending;
    this.ledger.setPlayed(this.finished + partial);
  }

  get playing(): boolean {
    return this.context.currentTime < this.cursor;
  }

  private tick(): void {
    this.syncLedger();
    const playing = this.playing;
    if (playing !== this.wasPlaying) {
      this.wasPlaying = playing;
      this.listener?.(playing);
    }
  }

  clear(): void {
    for (const s of this.scheduled) {
      try {
        s.node.stop();
      } catch {
        // already stopped
      }
      s.node.disconnect();
    }
    this.scheduled = [];
    this.finished = 0;
    this.cursor = 0;
    this.ledger.clear();
    this.tick();
  }

  playedSeconds(responseId: string): number {
    this.syncLedger();
    return this.ledger.playedSeconds(responseId);
  }

  readLevel(): number {
    this.analyser.getFloatTimeDomainData(this.levelSamples);
    return rmsToLevel(rms(this.levelSamples));
  }

  onActivity(listener: (playing: boolean) => void): void {
    this.listener = listener;
  }

  close(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clear();
    this.listener = null;
    this.blockedListener = null;
    if (this.context.state !== "closed") {
      void this.context.close().catch(() => undefined);
    }
  }
}
