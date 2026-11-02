import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Studio } from "@/components/studio/studio";
import { CONSENT_LABEL } from "@/components/studio/voice-create";
import { checkReference, encodeWav } from "@/lib/voices/wav";
import { fakeSession } from "./helpers/fake-media";
import { fakeVoice } from "./helpers/fake-voice";
import { fakeRecorderEnvironment, fakeVoicesApi } from "./helpers/fake-voices";

afterEach(() => vi.unstubAllGlobals());

function setup({ clone = true, design = true } = {}) {
  const voices = fakeVoicesApi({ clone, design });
  const recorder = fakeRecorderEnvironment();
  const play = vi.fn(async () => undefined);
  const voice = fakeVoice();
  const user = userEvent.setup();
  render(
    <Studio
      openMicrophone={() => Promise.resolve(fakeSession())}
      voice={voice.factory}
      voiceStudio={{ api: voices.api, play, recorderEnvironment: recorder.env }}
    />,
  );
  return { ...voices, recorder, play, voice, user };
}

async function openVoice(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Voice" }));
  return screen.findByRole("region", { name: "Voice" });
}

describe("Voice Studio panel", () => {
  it("opens from the Voice button, beside the transcript, one panel at a time", async () => {
    const { user } = setup();
    const panel = await openVoice(user);
    expect(within(panel).getByText("Current voice")).toBeInTheDocument();
    expect(
      await within(panel).findByText("Serena", { selector: "p" }),
    ).toBeInTheDocument(); // factory default
    await user.click(screen.getByRole("button", { name: "Transcript" }));
    expect(
      screen.queryByRole("region", { name: "Voice" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Transcript" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("previews a voice with the engine and the chosen text", async () => {
    const { user, api, play } = setup();
    const panel = await openVoice(user);
    const text = within(panel).getByRole("textbox", { name: "Preview text" });
    await user.clear(text);
    await user.type(text, "Testing one two.");
    await user.click(
      await within(panel).findByRole("button", { name: "Preview Aiden" }),
    );
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(api.preview).toHaveBeenCalledWith(
      { voiceId: "preset-aiden" },
      "Testing one two.",
      expect.anything(),
    );
  });

  it("sets the Conversation default", async () => {
    const { user, api } = setup();
    const panel = await openVoice(user);
    const aiden = (await within(panel).findAllByRole("listitem")).find((li) =>
      li.textContent?.startsWith("Aiden"),
    );
    await user.click(
      within(aiden as HTMLElement).getByRole("button", {
        name: "Set as Numa default",
      }),
    );
    expect(api.setDefault).toHaveBeenCalledWith("preset-aiden");
    expect(
      await within(panel).findByText("Aiden", { selector: "p" }),
    ).toBeInTheDocument();
  });

  it("says a new default applies to the next conversation, and refuses generation during one", async () => {
    const { user, voice } = setup();
    await user.click(
      screen.getByRole("button", { name: /start conversation/i }),
    );
    await screen.findByText("Listening");
    act(() =>
      voice.last()?.callbacks.onSessionInfo?.({
        voice: { id: "preset-serena", name: "Serena", method: "preset" },
        fallback: null,
      }),
    );
    const panel = await openVoice(user);
    const aiden = (await within(panel).findAllByRole("listitem")).find((li) =>
      li.textContent?.startsWith("Aiden"),
    );
    await user.click(
      within(aiden as HTMLElement).getByRole("button", {
        name: "Set as Numa default",
      }),
    );
    expect(
      await within(panel).findByText(
        /This conversation speaks as Serena\. Aiden takes effect in your next conversation/,
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        /End the conversation to preview or create voices/,
      ),
    ).toBeInTheDocument();
    for (const button of within(panel).getAllByRole("button", {
      name: "Preview Aiden",
    })) {
      expect(button).toBeDisabled();
    }
    expect(
      within(panel).getByRole("button", { name: "Record" }),
    ).toBeDisabled();
  });

  it("renames and deletes user voices, only after confirmation", async () => {
    const { user, api, add } = setup();
    add("Morning", "recorded");
    const panel = await openVoice(user);
    await user.click(
      await within(panel).findByRole("button", { name: "Rename Morning" }),
    );
    const input = within(panel).getByRole("textbox", {
      name: "New name for Morning",
    });
    await user.clear(input);
    await user.type(input, "Evening{enter}");
    expect(api.rename).toHaveBeenCalledWith("voice-000000000001", "Evening");
    expect(
      within(panel).queryByRole("button", { name: "Delete Aiden" }),
    ).not.toBeInTheDocument(); // built-in

    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    await user.click(
      await within(panel).findByRole("button", { name: "Delete Evening" }),
    );
    expect(api.remove).not.toHaveBeenCalled();
    await user.click(
      within(panel).getByRole("button", { name: "Delete Evening" }),
    );
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(api.remove).toHaveBeenCalledWith("voice-000000000001");
    await waitFor(() =>
      expect(within(panel).queryByText("Evening")).not.toBeInTheDocument(),
    );
  });
});

describe("creating voices", () => {
  it("records, plays back, requires consent and a name, then creates the voice", async () => {
    const { user, api, recorder } = setup();
    const panel = await openVoice(user);
    expect(
      within(panel).getByText(/I'm recording a short sample of my voice/),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Record" }));
    await within(panel).findByRole("button", { name: "Stop" });
    expect(recorder.env.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        echoCancellation: false,
        noiseSuppression: false,
      }),
      video: false,
    });
    act(() => recorder.speak(8));
    await user.click(within(panel).getByRole("button", { name: "Stop" }));
    expect(recorder.track.stop).toHaveBeenCalled(); // microphone released as soon as recording stops
    expect(
      within(panel).getByLabelText("Reference recording"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/8\.0 s of speech, good level/),
    ).toBeInTheDocument();

    const create = within(panel).getByRole("button", { name: "Create voice" });
    expect(create).toBeDisabled();
    await user.type(
      within(panel).getByRole("textbox", { name: "Name" }),
      "My voice",
    );
    expect(create).toBeDisabled(); // consent still missing
    await user.click(
      within(panel).getByRole("checkbox", { name: CONSENT_LABEL }),
    );
    await user.click(create);
    expect(api.create).toHaveBeenCalledWith(
      "My voice",
      "recorded",
      expect.any(Blob),
    );
    expect(
      await within(panel).findByText("“My voice” saved."),
    ).toBeInTheDocument();
  });

  it("refuses a recording that is too short, and cancelling releases the microphone", async () => {
    const { user, recorder } = setup();
    const panel = await openVoice(user);
    await user.click(within(panel).getByRole("button", { name: "Record" }));
    await within(panel).findByRole("button", { name: "Stop" });
    act(() => recorder.speak(1.5));
    await user.click(within(panel).getByRole("button", { name: "Stop" }));
    expect(
      within(panel).getByText(/Only 1\.5 s of speech/),
    ).toBeInTheDocument();
    await user.click(
      within(panel).getByRole("button", { name: "Record again" }),
    );
    await within(panel).findByRole("button", { name: "Cancel" });
    await user.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(recorder.track.stop).toHaveBeenCalledTimes(2);
    expect(recorder.context.close).toHaveBeenCalled();
  });

  it("validates uploads before sending them", async () => {
    const { user, api } = setup();
    const panel = await openVoice(user);
    await user.click(within(panel).getByRole("tab", { name: "Upload" }));
    const input = within(panel).getByLabelText("Voice recording file");
    const big = new File([new Uint8Array(16 * 1024 * 1024)], "big.wav", {
      type: "audio/wav",
    });
    await user.upload(input, big);
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "larger than 15 MB",
    );
    await user.upload(
      input,
      new File(["not audio"], "x.mp3", { type: "audio/mpeg" }),
    );
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "could not be decoded",
    );
    expect(api.create).not.toHaveBeenCalled();
  });

  it("accepts a decodable upload and previews it before creating", async () => {
    const { user, api } = setup();
    const tone = new Float32Array(48000 * 6).map(
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 200 * i) / 48000),
    );
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData = async () => ({
          length: tone.length,
          numberOfChannels: 1,
          sampleRate: 48000,
          getChannelData: () => tone,
        });
      },
    );
    const panel = await openVoice(user);
    await user.click(within(panel).getByRole("tab", { name: "Upload" }));
    await user.upload(
      within(panel).getByLabelText("Voice recording file"),
      new File(["x"], "me.m4a", { type: "audio/mp4" }),
    );
    expect(
      await within(panel).findByLabelText("Reference recording"),
    ).toBeInTheDocument();
    await user.type(
      within(panel).getByRole("textbox", { name: "Name" }),
      "Uploaded me",
    );
    await user.click(
      within(panel).getByRole("checkbox", { name: CONSENT_LABEL }),
    );
    await user.click(
      within(panel).getByRole("button", { name: "Create voice" }),
    );
    expect(api.create).toHaveBeenCalledWith(
      "Uploaded me",
      "uploaded",
      expect.any(Blob),
    );
  });

  it("designs three candidates, previews one and saves it", async () => {
    const { user, api, play } = setup();
    const panel = await openVoice(user);
    await user.click(within(panel).getByRole("tab", { name: "Describe" }));
    await user.type(
      within(panel).getByRole("textbox", { name: "Describe the voice" }),
      "A soft, warm and calm voice",
    );
    await user.click(
      within(panel).getByRole("button", { name: "Generate three voices" }),
    );
    expect(
      await within(panel).findByRole("radio", { name: "Voice 3" }),
    ).toBeInTheDocument();
    await user.click(
      within(panel).getByRole("button", { name: "Play voice 2" }),
    );
    expect(play).toHaveBeenCalled();
    await user.click(
      within(panel).getByRole("button", {
        name: "Hear voice 2 say the preview text",
      }),
    );
    expect(api.preview).toHaveBeenCalledWith(
      { candidate: { token: "0123456789abcdef", index: 1 } },
      expect.any(String),
      expect.anything(),
    );
    await user.click(within(panel).getByRole("radio", { name: "Voice 2" }));
    await user.type(
      within(panel).getByRole("textbox", { name: "Name" }),
      "Soft",
    );
    await user.click(within(panel).getByRole("button", { name: "Save voice" }));
    expect(api.saveDesign).toHaveBeenCalledWith("0123456789abcdef", 1, "Soft");
  });

  it("explains methods whose models are not installed instead of faking them", async () => {
    const { user } = setup({ clone: false, design: false });
    const panel = await openVoice(user);
    expect(
      await within(panel).findByText(
        /Unavailable: needs tts\/qwen3-tts-1.7b-base-6bit/,
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: "Record" }),
    ).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("tab", { name: "Describe" }));
    expect(
      within(panel).getByText(
        /Unavailable: needs tts\/qwen3-tts-1.7b-voicedesign-6bit/,
      ),
    ).toBeInTheDocument();
  });
});

describe("reference checks", () => {
  const tone = (seconds: number, level: number) =>
    new Float32Array(Math.round(seconds * 16000)).map(
      (_, i) => level * Math.sin((2 * Math.PI * 200 * i) / 16000),
    );

  it("mirrors the engine's limits", () => {
    expect(checkReference(tone(6, 0.3), 16000).problem).toBeNull();
    expect(checkReference(tone(2, 0.3), 16000).problem).toMatch(/at least 3/);
    expect(checkReference(tone(31, 0.3), 16000).problem).toMatch(/at most 30/);
    expect(checkReference(tone(6, 0.003), 16000).problem).toMatch(/quiet/);
    expect(
      checkReference(
        tone(6, 1.5).map((s) => Math.max(-1, Math.min(1, s))),
        16000,
      ).problem,
    ).toMatch(/clipping/);
  });

  it("ignores leading and trailing silence", () => {
    const padded = new Float32Array(16000 * 8);
    padded.set(tone(5, 0.3), 16000 * 1.5);
    expect(checkReference(padded, 16000).durationS).toBeCloseTo(5, 1);
  });

  it("encodes 16-bit mono WAV", async () => {
    const blob = encodeWav(tone(1, 0.3), 16000);
    const view = new DataView(await blob.arrayBuffer());
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(blob.size).toBe(44 + 32000);
  });
});

describe("loading", () => {
  it("loads the voice list once when the panel opens, not on every render", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        voices: [],
        default: "preset-serena",
        default_problem: null,
        capabilities: {
          presets: { available: true, reason: null },
          clone: { available: true, reason: null },
          design: { available: true, reason: null },
        },
        busy: false,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(
      <Studio
        openMicrophone={() => Promise.resolve(fakeSession())}
        voice={fakeVoice().factory}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Voice" }));
    await new Promise((r) => setTimeout(r, 300));
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(2); // mount + the session-state refresh
  });
});
