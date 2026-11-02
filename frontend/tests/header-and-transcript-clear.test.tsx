import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Studio } from "@/components/studio/studio";
import {
  CLEAR_TRANSCRIPT_PROMPT,
  TranscriptPanel,
} from "@/components/studio/transcript-panel";
import { fakeSession } from "./helpers/fake-media";
import { fakeVoice } from "./helpers/fake-voice";
import { fakeVoicesApi } from "./helpers/fake-voices";

describe("header", () => {
  it("shows Voice before Transcript, with both labels unchanged", () => {
    render(
      <Studio
        openMicrophone={() => Promise.resolve(fakeSession())}
        voice={fakeVoice().factory}
        voiceStudio={{ api: fakeVoicesApi().api }}
      />,
    );
    const buttons = within(
      screen.getAllByRole("banner")[0] as HTMLElement,
    ).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Voice", "Transcript"]);
  });
});

describe("clearing the transcript", () => {
  const entries = [
    {
      type: "entry.started" as const,
      entryId: "user:u1",
      speaker: "user" as const,
      atMs: 0,
    },
    {
      type: "entry.completed" as const,
      entryId: "user:u1",
      text: "Hello there.",
      atMs: 900,
    },
  ];

  async function liveSessionWithTranscript(confirm: () => boolean) {
    vi.spyOn(window, "confirm").mockImplementation(confirm);
    const user = userEvent.setup();
    const mic = fakeSession();
    const voice = fakeVoice();
    render(
      <Studio
        openMicrophone={() => Promise.resolve(mic)}
        voice={voice.factory}
        voiceStudio={{ api: fakeVoicesApi().api }}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /start conversation/i }),
    );
    await screen.findByText("Listening");
    await user.click(screen.getByRole("button", { name: "Transcript" }));
    act(() => voice.last()?.callbacks.onTranscript(entries));
    return {
      user,
      mic,
      voice,
      panel: screen.getByRole("region", { name: "Transcript" }),
    };
  }

  it("is hidden while the transcript is empty", () => {
    render(<TranscriptPanel id="t" entries={[]} onClear={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "Clear" }),
    ).not.toBeInTheDocument();
  });

  it("asks first, and keeps the transcript if declined", async () => {
    const { user, panel } = await liveSessionWithTranscript(() => false);
    await user.click(within(panel).getByRole("button", { name: "Clear" }));
    expect(window.confirm).toHaveBeenCalledWith(CLEAR_TRANSCRIPT_PROMPT);
    expect(within(panel).getByText("Hello there.")).toBeInTheDocument();
  });

  it("clears only what is shown: the session keeps running and new turns still appear", async () => {
    const { user, panel, mic, voice } = await liveSessionWithTranscript(
      () => true,
    );
    await user.click(within(panel).getByRole("button", { name: "Clear" }));
    expect(within(panel).queryByText("Hello there.")).not.toBeInTheDocument();
    expect(within(panel).getByText("No transcript yet.")).toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: "Clear" }),
    ).not.toBeInTheDocument();
    // the conversation is untouched: still listening, microphone and engine connection open
    expect(screen.getByText("Listening")).toBeInTheDocument();
    expect(mic.stop).not.toHaveBeenCalled();
    expect(voice.last()?.handle.stop).not.toHaveBeenCalled();
    act(() =>
      voice.last()?.callbacks.onTranscript([
        {
          type: "entry.started",
          entryId: "host:r2",
          speaker: "host",
          speakerName: "Numa",
          atMs: 2000,
        },
        {
          type: "entry.completed",
          entryId: "host:r2",
          text: "Still here.",
          atMs: 2500,
        },
      ]),
    );
    expect(within(panel).getByText("Still here.")).toBeInTheDocument();
  });
});
