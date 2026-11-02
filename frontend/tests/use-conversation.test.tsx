import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConversation } from "@/hooks/use-conversation";
import { microphoneError } from "@/lib/audio/microphone";
import { deferred, fakeSession } from "./helpers/fake-media";

function setup(
  open: () => Promise<ReturnType<typeof fakeSession>>,
  enableSimulation = false,
) {
  let t = 1_000;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const hook = renderHook(() =>
    useConversation({ open, now, enableSimulation }),
  );
  return { ...hook, advance };
}

describe("useConversation", () => {
  it("starts a local preview session: connecting, then listening with live input levels", async () => {
    const session = fakeSession(0.4);
    const pending = deferred<typeof session>();
    const { result } = setup(() => pending.promise);

    let started!: Promise<void>;
    act(() => {
      started = result.current.start();
    });
    expect(result.current.state.status).toBe("connecting");
    expect(result.current.inputLevels).toBeNull();

    await act(async () => {
      pending.resolve(session);
      await started;
    });
    expect(result.current.state).toMatchObject({
      status: "listening",
      startedAt: 1000,
    });
    expect(result.current.inputLevels?.readLevel()).toBe(0.4);
    expect(result.current.deviceLabel).toBe("Studio Microphone");
    // no backend: nothing produces assistant audio
    expect(result.current.outputLevels).toBeNull();
  });

  it("reports a denied permission as an error state", async () => {
    const { result } = setup(() =>
      Promise.reject(microphoneError("permission-denied")),
    );
    await act(() => result.current.start());
    expect(result.current.state.status).toBe("error");
    expect(result.current.state.error?.code).toBe("permission-denied");
    expect(result.current.inputLevels).toBeNull();
  });

  it("classifies raw browser errors", async () => {
    const raw = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const { result } = setup(() => Promise.reject(raw));
    await act(() => result.current.start());
    expect(result.current.state.error?.code).toBe("permission-denied");
  });

  it("mutes and unmutes the microphone", async () => {
    const session = fakeSession();
    const { result } = setup(() => Promise.resolve(session));
    await act(() => result.current.start());

    act(() => result.current.toggleMute());
    expect(result.current.state.status).toBe("muted");
    expect(session.setMuted).toHaveBeenLastCalledWith(true);
    expect(result.current.inputLevels?.readLevel()).toBe(0);

    act(() => result.current.toggleMute());
    expect(result.current.state.status).toBe("listening");
    expect(session.setMuted).toHaveBeenLastCalledWith(false);
  });

  it("ignores mute when no session is open", () => {
    const open = vi.fn();
    const { result } = setup(open);
    act(() => result.current.toggleMute());
    expect(result.current.state.status).toBe("idle");
  });

  it("end releases the microphone and records the duration", async () => {
    const session = fakeSession();
    const { result, advance } = setup(() => Promise.resolve(session));
    await act(() => result.current.start());
    advance(65_000);
    act(() => result.current.end());
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({
      status: "ended",
      startedAt: 1000,
      endedAt: 66_000,
    });
    expect(result.current.inputLevels).toBeNull();
  });

  it("ending while the permission prompt is open releases the stream when it arrives", async () => {
    const session = fakeSession();
    const pending = deferred<typeof session>();
    const { result } = setup(() => pending.promise);
    let started!: Promise<void>;
    act(() => {
      started = result.current.start();
    });
    act(() => result.current.end());
    expect(result.current.state.status).toBe("ended");

    await act(async () => {
      pending.resolve(session);
      await started;
    });
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe("ended");
    expect(result.current.inputLevels).toBeNull();
  });

  it("releases the microphone when the studio unmounts", async () => {
    const session = fakeSession();
    const { result, unmount } = setup(() => Promise.resolve(session));
    await act(() => result.current.start());
    unmount();
    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  it("a disconnected device stops the session with an error", async () => {
    const session = fakeSession();
    const { result } = setup(() => Promise.resolve(session));
    await act(() => result.current.start());
    act(() => session.loseDevice());
    expect(result.current.state.status).toBe("error");
    expect(result.current.state.error?.code).toBe("device-lost");
    expect(session.stop).toHaveBeenCalled();
  });

  it("never enters processing or speaking on its own", async () => {
    const { result } = setup(() => Promise.resolve(fakeSession()), false);
    await act(() => result.current.start());
    expect(result.current.simulate).toBeUndefined();
    expect(result.current.state.status).toBe("listening");
  });

  it("the development simulation is explicit and labelled as such", async () => {
    const { result } = setup(() => Promise.resolve(fakeSession()), true);
    await act(() => result.current.start());
    act(() => result.current.simulate?.("processing"));
    expect(result.current.state).toMatchObject({
      status: "processing",
      source: "simulation",
    });
    act(() => result.current.simulate?.("speaking"));
    expect(result.current.state.status).toBe("speaking");
    act(() => result.current.simulate?.("done"));
    expect(result.current.state.status).toBe("listening");
  });
});
