import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity } from "react";
import { describe, expect, it } from "vitest";
import { Studio } from "@/components/studio/studio";
import { RealtimeError } from "@/lib/realtime/client";
import { fakeSession } from "./helpers/fake-media";
import { fakeVoice } from "./helpers/fake-voice";

async function startConversation(
  user: ReturnType<typeof userEvent.setup>,
  name = /start conversation/i,
) {
  await user.click(screen.getByRole("button", { name }));
  await screen.findByText("Listening");
}

describe("Conversation", () => {
  it("keeps the studio and starts a session with the general Numa assistant", async () => {
    const user = userEvent.setup();
    const voice = fakeVoice();
    render(
      <Studio
        openMicrophone={() => Promise.resolve(fakeSession())}
        voice={voice.factory}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "numa.",
    );
    expect(
      screen.getByRole("button", { name: "Transcript" }),
    ).toBeInTheDocument();
    await startConversation(user);
    expect(voice.last()?.config).toEqual({
      mode: "conversation",
      persona: "numa-assistant",
      hostName: "Numa",
    });
    expect(
      screen.getAllByLabelText("Local model: Connected").length,
    ).toBeGreaterThan(0);
  });

  it("follows the engine: processing, Numa speaking, back to listening", async () => {
    const user = userEvent.setup();
    const voice = fakeVoice();
    render(
      <Studio
        openMicrophone={() => Promise.resolve(fakeSession())}
        voice={voice.factory}
      />,
    );
    await startConversation(user);
    const { callbacks } = voice.last() ?? {};
    act(() => callbacks?.onActivity("processing-started"));
    expect(screen.getByText("Processing")).toBeInTheDocument();
    act(() => callbacks?.onActivity("speech-started"));
    expect(screen.getByText("Numa speaking")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Numa speech level" }),
    ).toBeInTheDocument();
    act(() => callbacks?.onActivity("speech-ended"));
    expect(screen.getByText("Listening")).toBeInTheDocument();
  });

  it("shows both speakers in the transcript, behind the existing toggle", async () => {
    const user = userEvent.setup();
    const voice = fakeVoice();
    render(
      <Studio
        openMicrophone={() => Promise.resolve(fakeSession())}
        voice={voice.factory}
      />,
    );
    await startConversation(user);
    await user.click(screen.getByRole("button", { name: "Transcript" }));
    expect(
      screen.getByText(/will appear here as they are spoken/),
    ).toBeInTheDocument();
    act(() =>
      voice.last()?.callbacks.onTranscript([
        { type: "entry.started", entryId: "user:u1", speaker: "user", atMs: 0 },
        {
          type: "entry.completed",
          entryId: "user:u1",
          text: "What's new?",
          atMs: 900,
        },
        {
          type: "entry.started",
          entryId: "host:r1",
          speaker: "host",
          speakerName: "Numa",
          atMs: 1500,
        },
        {
          type: "entry.delta",
          entryId: "host:r1",
          text: "Quite a lot",
          atMs: 1600,
        },
        {
          type: "entry.truncated",
          entryId: "host:r1",
          text: "Quite a lot",
          atMs: 2000,
        },
      ]),
    );
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^You.*What's new\?$/),
      expect.stringMatching(/^Numa.*Quite a lot — \(interrupted\)$/),
    ]);
  });

  it("explains an engine that is not running", async () => {
    const user = userEvent.setup();
    const mic = fakeSession();
    const voice = fakeVoice({
      fail: new RealtimeError(
        "backend-unavailable",
        "Couldn't reach the voice engine.",
      ),
    });
    render(
      <Studio
        openMicrophone={() => Promise.resolve(mic)}
        voice={voice.factory}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /start conversation/i }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't reach the voice engine.",
    );
    expect(screen.getByText("Voice engine unavailable")).toBeInTheDocument();
    expect(mic.stop).toHaveBeenCalled();
    expect(voice.last()?.handle.stop).toHaveBeenCalled();
  });
});

describe("session cleanup", () => {
  it("ends the session when the route is hidden, and shows it ended on return", async () => {
    const user = userEvent.setup();
    const mic = fakeSession();
    const voice = fakeVoice();
    const view = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <Studio
          openMicrophone={() => Promise.resolve(mic)}
          voice={voice.factory}
        />
      </Activity>
    );
    const { rerender } = render(view("visible"));
    await startConversation(user);
    rerender(view("hidden")); // what Next.js does to the previous route on navigation
    expect(mic.stop).toHaveBeenCalled();
    expect(voice.last()?.handle.stop).toHaveBeenCalled();
    rerender(view("visible"));
    expect(screen.getByText("Session ended")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start again/i }),
    ).toBeInTheDocument();
  });

  it("releases everything when the studio unmounts mid-session", async () => {
    const user = userEvent.setup();
    const mic = fakeSession();
    const voice = fakeVoice();
    const { unmount } = render(
      <Studio
        openMicrophone={() => Promise.resolve(mic)}
        voice={voice.factory}
      />,
    );
    await startConversation(user);
    unmount();
    expect(mic.stop).toHaveBeenCalled();
    expect(voice.last()?.handle.stop).toHaveBeenCalled();
  });
});

describe("Audio the browser holds back", () => {
  it("offers to resume it, and the offer goes once audio plays", async () => {
    const user = userEvent.setup();
    const voice = fakeVoice();
    render(
      <Studio
        openMicrophone={() => Promise.resolve(fakeSession())}
        voice={voice.factory}
      />,
    );
    await startConversation(user);
    expect(
      screen.queryByRole("button", { name: "Resume audio" }),
    ).not.toBeInTheDocument();
    act(() => voice.last()?.callbacks.onAudioBlocked?.(true));
    await user.click(screen.getByRole("button", { name: "Resume audio" }));
    expect(voice.last()?.handle.resumeAudio).toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Resume audio" }),
    ).not.toBeInTheDocument();
  });
});
