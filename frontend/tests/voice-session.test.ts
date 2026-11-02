import { describe, expect, it, vi } from "vitest";
import type { RealtimeConnection, RealtimeError } from "@/lib/realtime/client";
import {
  base64ToBytes,
  bytesToBase64,
  floatToPcm16,
} from "@/lib/realtime/codec";
import type { ServerEvent } from "@/lib/realtime/interruption";
import { type Playback, PlaybackLedger } from "@/lib/realtime/playback";
import { type VoiceActivity, VoiceSession } from "@/lib/realtime/voice-session";
import type { TranscriptEvent } from "@/lib/schemas/transcript";
import { MODES, sessionConfig } from "@/lib/session/modes";
import { fakeSession } from "./helpers/fake-media";

/** Playback whose clock the test advances. */
class FakePlayback implements Playback {
  ledger = new PlaybackLedger();
  played = 0;
  playing = false;
  listener: ((playing: boolean) => void) | null = null;
  enqueue = vi.fn((rid: string, samples: Float32Array) => {
    this.ledger.append(rid, samples.length);
    this.setPlaying(true);
  });
  clear = vi.fn(() => {
    this.ledger.clear();
    this.played = 0;
    this.setPlaying(false);
  });
  close = vi.fn();
  setMuted = vi.fn();
  blocked = false;
  blockedListener: ((blocked: boolean) => void) | null = null;
  onBlocked(l: (blocked: boolean) => void) {
    this.blockedListener = l;
  }
  resume = vi.fn(async () => {
    this.setBlocked(false);
  });
  setBlocked(b: boolean) {
    this.blocked = b;
    this.blockedListener?.(b);
  }
  play(seconds: number) {
    this.played += seconds * 16000;
    this.ledger.setPlayed(this.played);
  }
  setPlaying(p: boolean) {
    if (p !== this.playing) {
      this.playing = p;
      this.listener?.(p);
    }
  }
  playedSeconds(rid: string) {
    return this.ledger.playedSeconds(rid);
  }
  readLevel() {
    return 0;
  }
  onActivity(l: (playing: boolean) => void) {
    this.listener = l;
  }
}

function setup({ halfDuplex = false } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  let onEvent: (e: ServerEvent) => void = () => {};
  let onLost: (e: RealtimeError) => void = () => {};
  const connection: RealtimeConnection = {
    send: (e) => sent.push(e as Record<string, unknown>),
    onEvent: (l) => {
      onEvent = l;
    },
    onLost: (l) => {
      onLost = l;
    },
    close: vi.fn(),
  };
  const connect = vi.fn(async (_url: string) => connection);
  const playback = new FakePlayback();
  const activity: VoiceActivity[] = [];
  const transcript: TranscriptEvent[] = [];
  const lost = vi.fn();
  const session = new VoiceSession(
    sessionConfig(MODES.conversation),
    {
      onActivity: (a) => activity.push(a),
      onTranscript: (e) => transcript.push(...e),
      onLost: lost,
    },
    { connect, createPlayback: () => playback, now: () => 0, halfDuplex },
  );
  const mic = fakeSession();
  return {
    session,
    mic,
    playback,
    connect,
    connection,
    sent,
    activity,
    transcript,
    lost,
    server: (e: ServerEvent) => onEvent(e),
    drop: (e: RealtimeError) => onLost(e),
  };
}

const pcmDelta = (seconds: number) =>
  bytesToBase64(floatToPcm16(new Float32Array(seconds * 16000)));

describe("VoiceSession", () => {
  it("connects with the mode's persona and nothing else", async () => {
    const t = setup();
    await t.session.connect(t.mic);
    const url = new URL(t.connect.mock.calls[0]?.[0] ?? "");
    expect([...url.searchParams.keys()]).toEqual(["persona"]);
    expect(url.searchParams.get("persona")).toBe("numa-assistant");
  });

  it("streams the microphone as 16 kHz PCM16", async () => {
    const t = setup();
    await t.session.connect(t.mic);
    t.mic.emit(new Float32Array(1920).fill(0.25), 48000); // 40 ms
    const append = t.sent.find((e) => e.type === "input_audio_buffer.append");
    expect(base64ToBytes(String(append?.audio)).length).toBe(640 * 2);
  });

  it("plays Numa's audio and reports speaking", async () => {
    const t = setup();
    await t.session.connect(t.mic);
    t.server({ type: "response.created", response: { id: "r1" } });
    t.server({
      type: "response.output_audio.delta",
      response_id: "r1",
      delta: pcmDelta(1),
    });
    expect(t.playback.enqueue).toHaveBeenCalledWith(
      "r1",
      expect.any(Float32Array),
    );
    expect(t.activity).toContain("speech-started");
  });

  it("on barge-in stops playback at once and notes in the history what was heard", async () => {
    const t = setup();
    await t.session.connect(t.mic);
    t.server({ type: "response.created", response: { id: "r1" } });
    t.server({
      type: "response.output_item.added",
      response_id: "r1",
      item: { id: "a1" },
    });
    t.server({
      type: "response.output_audio_transcript.delta",
      response_id: "r1",
      delta:
        "That is a fascinating tension to explore. Why do you think people crave longer talks?",
    });
    t.server({
      type: "response.output_audio.delta",
      response_id: "r1",
      delta: pcmDelta(6),
    });
    t.playback.play(3.5);
    // upstream 1.1.0 order: the cancellation arrives before speech_started
    t.server({
      type: "response.done",
      response: { id: "r1", status: "cancelled" },
    });
    t.server({ type: "input_audio_buffer.speech_started", item_id: "u2" });

    expect(t.playback.clear).toHaveBeenCalled();
    expect(t.activity).toContain("speech-ended");
    const notes = t.sent.filter((e) => e.type === "conversation.item.create");
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).toContain(
      'They heard you say: \\"That is a fascinating tension to explore.\\"',
    );
    expect(t.transcript).toContainEqual(
      expect.objectContaining({
        type: "entry.truncated",
        entryId: "host:r1",
        text: "That is a fascinating tension to explore. Why do",
      }),
    );
  });

  it("reports processing between the user's turn and the reply", async () => {
    const t = setup();
    await t.session.connect(t.mic);
    t.server({ type: "input_audio_buffer.speech_stopped" });
    t.server({ type: "response.created", response: { id: "r1" } });
    t.server({
      type: "response.done",
      response: { id: "r1", status: "completed" },
    }); // no audio at all
    expect(t.activity).toEqual(["processing-started", "processing-ended"]);
  });

  it("can send silence while Numa speaks (half-duplex for speakers without echo cancellation)", async () => {
    const t = setup({ halfDuplex: true });
    await t.session.connect(t.mic);
    t.server({ type: "response.created", response: { id: "r1" } });
    t.server({
      type: "response.output_audio.delta",
      response_id: "r1",
      delta: pcmDelta(1),
    });
    t.mic.emit(new Float32Array(1920).fill(0.5), 48000);
    const append = t.sent.find((e) => e.type === "input_audio_buffer.append");
    expect(
      Array.from(base64ToBytes(String(append?.audio))).every((b) => b === 0),
    ).toBe(true);
  });

  it("stop closes the connection and playback, and later microphone audio is not sent", async () => {
    const t = setup();
    await t.session.connect(t.mic);
    t.session.stop();
    expect(t.connection.close).toHaveBeenCalled();
    expect(t.playback.close).toHaveBeenCalled();
    t.mic.emit(new Float32Array(1920), 48000);
    expect(
      t.sent.filter((e) => e.type === "input_audio_buffer.append"),
    ).toEqual([]);
  });

  it("reports a dropped connection", async () => {
    const t = setup();
    await t.session.connect(t.mic);
    t.drop({ code: "connection-lost", message: "lost" } as RealtimeError);
    expect(t.lost).toHaveBeenCalled();
  });
});

describe("audio the browser holds back", () => {
  it("is reported, and released by resumeAudio from a click", async () => {
    const t = setup();
    const blocked = vi.fn();
    t.playback.blocked = true;
    // the callbacks are fixed at construction; observe through a fresh session
    const session = new VoiceSession(
      sessionConfig(MODES.conversation),
      {
        onActivity: () => undefined,
        onTranscript: () => undefined,
        onLost: () => undefined,
        onAudioBlocked: blocked,
      },
      {
        connect: t.connect,
        createPlayback: () => t.playback,
        now: () => 0,
      },
    );
    await session.connect(t.mic);
    expect(blocked).toHaveBeenLastCalledWith(true);
    await session.resumeAudio();
    expect(blocked).toHaveBeenLastCalledWith(false);
  });
});

describe("studio controls", () => {
  it("mutes Numa's voice without ending anything", async () => {
    const t = setup();
    await t.session.connect(t.mic);
    t.session.setOutputMuted(true);
    expect(t.playback.setMuted).toHaveBeenLastCalledWith(true);
    t.session.setOutputMuted(false);
    expect(t.playback.setMuted).toHaveBeenLastCalledWith(false);
    expect(t.connection.close).not.toHaveBeenCalled();
  });

  it("stop cancels a reply still being generated, then closes", async () => {
    const t = setup();
    await t.session.connect(t.mic);
    t.server({ type: "response.created", response: { id: "r1" } });
    t.session.stop();
    expect(t.sent.at(-1)).toEqual({ type: "response.cancel" });
    expect(t.connection.close).toHaveBeenCalled();
    expect(t.playback.close).toHaveBeenCalled();
  });

  it("stop sends no cancel when nothing is being generated", async () => {
    const t = setup();
    await t.session.connect(t.mic);
    t.server({ type: "response.created", response: { id: "r1" } });
    t.server({
      type: "response.done",
      response: { id: "r1", status: "completed" },
    });
    t.session.stop();
    expect(t.sent.some((e) => e.type === "response.cancel")).toBe(false);
  });
});
