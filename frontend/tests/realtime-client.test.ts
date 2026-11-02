import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectRealtime,
  RealtimeError,
  voiceUrl,
} from "@/lib/realtime/client";
import { MODES, sessionConfig } from "@/lib/session/modes";

class FakeSocket {
  static last: FakeSocket;
  readyState = 1;
  sent: string[] = [];
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  serverSends(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const socket = (url: string, protocols: string[]) =>
  new FakeSocket(url, protocols) as unknown as WebSocket;
vi.stubGlobal("WebSocket", { OPEN: 1 });
afterEach(() => vi.useRealTimers());

describe("voiceUrl", () => {
  it("asks for the mode's persona by id, never for prompt text", () => {
    const url = new URL(
      voiceUrl(
        sessionConfig(MODES.conversation),
        "ws://127.0.0.1:8765/v1/realtime",
      ),
    );
    expect(url.searchParams.get("persona")).toBe("numa-assistant");
    expect([...url.searchParams.keys()]).toEqual(["persona"]);
  });
});

describe("connectRealtime", () => {
  it("opens with the realtime subprotocol and configures the session after session.created", async () => {
    const pending = connectRealtime(
      "ws://x/v1/realtime?persona=numa-assistant",
      { socket },
    );
    const ws = FakeSocket.last;
    expect(ws.protocols).toEqual(["realtime"]);
    ws.serverSends({ type: "session.created" });
    const connection = await pending;
    const update = JSON.parse(ws.sent[0] ?? "{}");
    expect(update.type).toBe("session.update");
    expect(update.session).not.toHaveProperty("instructions");
    expect(update.session.audio.input.turn_detection).toEqual({
      type: "server_vad",
      interrupt_response: true,
    });

    const events: object[] = [];
    connection.onEvent((e) => events.push(e));
    ws.serverSends({ type: "response.created" });
    expect(events).toEqual([{ type: "response.created" }]);
  });

  it("reports a busy engine", async () => {
    const pending = connectRealtime("ws://x", { socket });
    FakeSocket.last.serverSends({
      type: "error",
      error: { type: "session_limit_reached" },
    });
    await expect(pending).rejects.toMatchObject({ code: "session-busy" });
  });

  it("passes on why the engine refused the session (e.g. the persona's voice is unavailable)", async () => {
    const pending = connectRealtime("ws://x", { socket });
    const message =
      "The Ren voice for this session is unavailable (preset-aiden: missing). No other voice is used instead.";
    FakeSocket.last.serverSends({
      type: "error",
      error: { type: "host_voice_unavailable", message },
    });
    FakeSocket.last.drop(); // the engine closes after reporting it
    await expect(pending).rejects.toMatchObject({
      code: "backend-error",
      message,
    });
  });

  it("reports an engine that is not running (or refused this origin)", async () => {
    const pending = connectRealtime(
      "ws://127.0.0.1:8765/v1/realtime?persona=x",
      { socket },
    );
    FakeSocket.last.drop();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RealtimeError);
    expect(error).toMatchObject({ code: "backend-unavailable" });
    const message = (error as Error).message;
    expect(message).toContain("ws://127.0.0.1:8765/v1/realtime.");
    expect(message).toContain("uv run numa-voice serve"); // not running
    expect(message).toContain(window.location.origin); // or this page's origin is not allowed
    expect(message).toContain("NUMA_VOICE_ALLOWED_ORIGINS");
  });

  it("times out if the engine never answers", async () => {
    vi.useFakeTimers();
    const pending = connectRealtime("ws://x", { socket, timeoutMs: 1000 });
    vi.advanceTimersByTime(1001);
    await expect(pending).rejects.toMatchObject({
      code: "backend-unavailable",
    });
  });

  it("reports a dropped connection once, but not one it closed itself", async () => {
    const pending = connectRealtime("ws://x", { socket });
    FakeSocket.last.serverSends({ type: "session.created" });
    const connection = await pending;
    const lost = vi.fn();
    connection.onLost(lost);
    FakeSocket.last.drop();
    expect(lost).toHaveBeenCalledWith(
      expect.objectContaining({ code: "connection-lost" }),
    );

    const again = connectRealtime("ws://x", { socket });
    FakeSocket.last.serverSends({ type: "session.created" });
    const second = await again;
    const lost2 = vi.fn();
    second.onLost(lost2);
    second.close();
    expect(lost2).not.toHaveBeenCalled();
  });
});
