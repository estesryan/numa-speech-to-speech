import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_CONSTRAINTS,
  classifyMicrophoneError,
  openMicrophone,
} from "@/lib/audio/microphone";
import {
  domError,
  FakeTrack,
  fakeEnvironment,
  fakeStream,
} from "./helpers/fake-media";

describe("microphone permission and device errors", () => {
  it.each([
    ["NotAllowedError", "permission-denied"],
    ["SecurityError", "permission-denied"],
    ["NotFoundError", "no-device"],
    ["OverconstrainedError", "no-device"],
    ["NotReadableError", "device-busy"],
    ["AbortError", "device-busy"],
    ["SomethingElse", "unknown"],
  ])("maps %s to %s", async (name, code) => {
    const { env } = fakeEnvironment({ getUserMediaError: domError(name) });
    await expect(openMicrophone(env)).rejects.toMatchObject({ code });
  });

  it("explains a denied permission in plain language", () => {
    expect(
      classifyMicrophoneError(domError("NotAllowedError")).message,
    ).toMatch(/blocked/i);
  });

  it("refuses an insecure context before asking for permission", async () => {
    const { env, getUserMedia } = fakeEnvironment({ secure: false });
    await expect(openMicrophone(env)).rejects.toMatchObject({
      code: "insecure-context",
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("reports an unsupported browser", async () => {
    const { env } = fakeEnvironment({ mediaDevices: false });
    await expect(openMicrophone(env)).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("reports a missing microphone without prompting for permission", async () => {
    const { env, getUserMedia } = fakeEnvironment({
      devices: [{ kind: "videoinput" }, { kind: "audiooutput" }],
    });
    await expect(openMicrophone(env)).rejects.toMatchObject({
      code: "no-device",
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("asks for audio only, with echo cancellation and noise suppression", async () => {
    const { env, getUserMedia } = fakeEnvironment();
    (await openMicrophone(env)).stop();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: AUDIO_CONSTRAINTS,
      video: false,
    });
  });
});

describe("live microphone levels", () => {
  it("measures the real signal level from the analyser", async () => {
    const { env, context } = fakeEnvironment();
    const session = await openMicrophone(env);
    context.amplitude = 0;
    expect(session.readLevel()).toBe(0);
    context.amplitude = 0.05; // about -26 dBFS
    const quiet = session.readLevel();
    context.amplitude = 0.25; // about -12 dBFS
    const loud = session.readLevel();
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    expect(session.deviceLabel).toBe("Studio Microphone");
    session.stop();
  });

  it("never connects the microphone to the speakers", async () => {
    const { env, context } = fakeEnvironment();
    const session = await openMicrophone(env);
    expect(context.source.connect).toHaveBeenCalledTimes(1);
    expect(context.source.connect).toHaveBeenCalledWith(context.analyser);
    session.stop();
  });

  it("resumes a suspended audio context", async () => {
    const { env, context } = fakeEnvironment();
    context.state = "suspended";
    const session = await openMicrophone(env);
    expect(context.resume).toHaveBeenCalled();
    session.stop();
  });
});

describe("mute", () => {
  it("disables the track and reports silence while muted", async () => {
    const { env, stream, context } = fakeEnvironment();
    const session = await openMicrophone(env);
    context.amplitude = 0.2;
    expect(session.readLevel()).toBeGreaterThan(0);

    session.setMuted(true);
    expect(session.muted).toBe(true);
    expect(stream.tracks[0]?.enabled).toBe(false);
    expect(session.readLevel()).toBe(0);
    expect(stream.tracks[0]?.stop).not.toHaveBeenCalled(); // muting keeps the device open

    session.setMuted(false);
    expect(stream.tracks[0]?.enabled).toBe(true);
    expect(session.readLevel()).toBeGreaterThan(0);
    session.stop();
  });
});

describe("resource cleanup", () => {
  it("stop() stops every track, disconnects the graph and closes the context, once", async () => {
    const tracks = [new FakeTrack(), new FakeTrack("Second")];
    const { env, context } = fakeEnvironment({ stream: fakeStream(tracks) });
    const session = await openMicrophone(env);
    session.stop();
    session.stop();
    for (const track of tracks) {
      expect(track.stop).toHaveBeenCalledTimes(1);
    }
    expect(context.source.disconnect).toHaveBeenCalledTimes(1);
    expect(context.analyser.disconnect).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(session.readLevel()).toBe(0);
  });

  it("releases the stream if the audio context cannot be created", async () => {
    const { env, stream } = fakeEnvironment({
      audioContextError: new Error("no audio"),
    });
    await expect(openMicrophone(env)).rejects.toMatchObject({
      code: "unknown",
    });
    expect(stream.tracks[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("releases a stream that arrives without audio tracks", async () => {
    const empty = fakeStream([]);
    const extra = new FakeTrack();
    const stream = {
      ...empty,
      getTracks: () => [extra],
    } as unknown as typeof empty;
    const { env } = fakeEnvironment({ stream });
    await expect(openMicrophone(env)).rejects.toMatchObject({
      code: "no-device",
    });
    expect(extra.stop).toHaveBeenCalled();
  });

  it("reports a lost device once, and not after stop()", async () => {
    const { env, stream } = fakeEnvironment();
    const session = await openMicrophone(env);
    const lost = vi.fn();
    session.onDeviceLost(lost);
    stream.tracks[0]?.unplug();
    expect(lost).toHaveBeenCalledTimes(1);

    const second = fakeEnvironment();
    const other = await openMicrophone(second.env);
    const lostAfterStop = vi.fn();
    other.onDeviceLost(lostAfterStop);
    other.stop();
    second.stream.tracks[0]?.unplug();
    expect(lostAfterStop).not.toHaveBeenCalled();
    session.stop();
  });
});
