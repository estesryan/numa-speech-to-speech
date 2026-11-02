import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Studio } from "@/components/studio/studio";
import { TranscriptPanel } from "@/components/studio/transcript-panel";
import { microphoneError } from "@/lib/audio/microphone";
import { deferred, fakeSession } from "./helpers/fake-media";

describe("Studio", () => {
  it("renders the Numa brand, an honest model status and the start control", () => {
    render(
      <Studio
        voice={null}
        openMicrophone={() => Promise.resolve(fakeSession())}
        enableSimulation={false}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "numa.",
    );
    expect(
      screen.getAllByLabelText("Local model: Not connected").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /start conversation/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /mute microphone/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("img", { name: "Waveform at rest" }),
    ).toHaveAttribute("data-state", "idle");
    expect(
      screen.getByText(/never recorded, stored or sent/i),
    ).toBeInTheDocument();
  });

  it("start opens a clearly labelled local preview that follows the microphone", async () => {
    const user = userEvent.setup();
    const session = fakeSession();
    const pending = deferred<typeof session>();
    render(
      <Studio
        voice={null}
        openMicrophone={() => pending.promise}
        enableSimulation={false}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /start conversation/i }),
    );
    expect(screen.getByText("Requesting microphone")).toBeInTheDocument();

    pending.resolve(session);
    expect(await screen.findByText("Listening · Preview")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Live microphone level" }),
    ).toHaveAttribute("data-state", "listening");
    expect(screen.getByText("Studio Microphone")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /start conversation/i }),
    ).not.toBeInTheDocument();
  });

  it("mute toggles the microphone and the button state", async () => {
    const user = userEvent.setup();
    const session = fakeSession();
    render(
      <Studio
        voice={null}
        openMicrophone={() => Promise.resolve(session)}
        enableSimulation={false}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /start conversation/i }),
    );

    const mute = await screen.findByRole("button", { name: "Mute microphone" });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    await user.click(mute);
    const unmute = screen.getByRole("button", { name: "Unmute microphone" });
    expect(unmute).toHaveAttribute("aria-pressed", "true");
    expect(session.setMuted).toHaveBeenLastCalledWith(true);
    expect(
      screen.getByRole("img", { name: "Microphone muted" }),
    ).toBeInTheDocument();

    await user.click(unmute);
    expect(session.setMuted).toHaveBeenLastCalledWith(false);
    expect(
      screen.getByRole("button", { name: "Mute microphone" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("end releases the microphone and offers to start again", async () => {
    const user = userEvent.setup();
    const session = fakeSession();
    render(
      <Studio
        voice={null}
        openMicrophone={() => Promise.resolve(session)}
        enableSimulation={false}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /start conversation/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: /end conversation/i }),
    );

    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Session ended")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start again/i })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /mute microphone/i }),
    ).toBeDisabled();
  });

  it("shows a permission-denied message", async () => {
    const user = userEvent.setup();
    render(
      <Studio
        voice={null}
        openMicrophone={() =>
          Promise.reject(microphoneError("permission-denied"))
        }
        enableSimulation={false}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /start conversation/i }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/blocked/i);
    expect(screen.getByText("Microphone unavailable")).toBeInTheDocument();
  });

  it("can be driven entirely from the keyboard", async () => {
    const user = userEvent.setup();
    const session = fakeSession();
    render(
      <Studio
        voice={null}
        openMicrophone={() => Promise.resolve(session)}
        enableSimulation={false}
      />,
    );
    const start = screen.getByRole("button", { name: /start conversation/i });
    start.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByText("Listening · Preview")).toBeInTheDocument(),
    );
    const end = screen.getByRole("button", { name: /end conversation/i });
    end.focus();
    await user.keyboard(" ");
    expect(session.stop).toHaveBeenCalled();
  });

  it("the transcript panel expands and states that no recognizer is connected", async () => {
    const user = userEvent.setup();
    render(
      <Studio
        voice={null}
        openMicrophone={() => Promise.resolve(fakeSession())}
        enableSimulation={false}
      />,
    );
    const toggle = screen.getByRole("button", { name: /transcript/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", { name: "Transcript" });
    expect(panel).toBeVisible();
    expect(panel).toHaveTextContent(/no transcript yet/i);
    expect(panel).toHaveTextContent(/speech recognition isn.t connected/i);
  });

  it("shows the development simulation only when enabled, and labels simulated states", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <Studio
        voice={null}
        openMicrophone={() => Promise.resolve(fakeSession())}
        enableSimulation
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /start conversation/i }),
    );
    const sim = await screen.findByRole("complementary", {
      name: "Development simulation",
    });
    await user.click(screen.getByRole("button", { name: "Processing" }));
    expect(screen.getByText("Processing (simulated)")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Processing indicator (not audio)" }),
    ).toBeInTheDocument();
    expect(sim).toBeInTheDocument();
    unmount();

    render(
      <Studio
        voice={null}
        openMicrophone={() => Promise.resolve(fakeSession())}
        enableSimulation={false}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /start conversation/i }),
    );
    await screen.findByText("Listening · Preview");
    expect(
      screen.queryByRole("complementary", { name: "Development simulation" }),
    ).not.toBeInTheDocument();
  });
});

describe("TranscriptPanel", () => {
  it("renders streamed entries with speaker labels and timestamps", () => {
    render(
      <TranscriptPanel
        id="t"
        entries={[
          {
            id: "u1",
            speaker: "user",
            speakerName: null,
            startedAtMs: 4_000,
            endedAtMs: 6_000,
            text: "Hello there",
            status: "final",
          },
          {
            id: "h1",
            speaker: "host",
            speakerName: "Taylor",
            startedAtMs: 7_500,
            endedAtMs: null,
            text: "Welcome",
            status: "streaming",
          },
        ]}
      />,
    );
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Taylor")).toBeInTheDocument();
    expect(screen.getByText("0:04")).toBeInTheDocument();
    expect(screen.getByText("0:07")).toBeInTheDocument();
    expect(screen.getByText("(still speaking)")).toBeInTheDocument();
    expect(screen.queryByText(/no transcript yet/i)).not.toBeInTheDocument();
  });
});
