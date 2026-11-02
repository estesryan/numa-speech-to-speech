import { createConnection } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { fakeMicrophone, QUESTION_THEN_BARGE_WAV } from "./audio";

/**
 * Real browser, real voice engine: Chrome captures a scripted user from a fake microphone, the page streams it to
 * the engine, and the assistant's speech is played by Chrome (to its virtual output). This verifies the browser audio
 * path, transcripts and interruptions; it does not verify a physical microphone, speakers or echo cancellation.
 * Needs `uv run numa-voice serve` running in backend/voice-engine.
 */

test.use({ launchOptions: { args: fakeMicrophone(QUESTION_THEN_BARGE_WAV) } });

test.beforeEach(async () => {
  const running = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: 8765 }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
  test.skip(
    !running,
    "voice engine not running: start `uv run numa-voice serve` in backend/voice-engine",
  );
});

async function converse(page: Page, startLabel: RegExp, host: string) {
  await page.getByRole("button", { name: "Transcript" }).click();
  await page.getByRole("button", { name: startLabel }).click();
  await expect(page.getByText("Listening", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByLabel("Local model: Connected").first(),
  ).toBeAttached();

  const transcript = page.locator("#transcript");
  const entries = transcript.getByRole("listitem");
  // the engine recognized the user's question from the browser's microphone stream
  await expect(
    entries.filter({ hasText: /long form conversations/i }),
  ).toBeVisible({ timeout: 60_000 });
  // the assistant answered aloud: Chrome played the reply
  await expect(page.getByText(new RegExp(`^${host} speaking$`))).toBeVisible({
    timeout: 60_000,
  });
  // the barge-in stopped the assistant and its transcript kept only what was heard
  await expect(transcript.getByText("(interrupted)")).toBeAttached({
    timeout: 60_000,
  });
  await expect(entries.filter({ hasText: /jump in/i })).toBeVisible({
    timeout: 30_000,
  });
  // the assistant then answered the interruption
  await expect(async () => {
    const texts = await entries.allTextContents();
    const lastHost =
      texts.filter((t) => !t.includes("(interrupted)")).pop() ?? "";
    expect(texts.length).toBeGreaterThanOrEqual(4);
    expect(lastHost).not.toMatch(/^(You|Alex)/);
  }).toPass({ timeout: 60_000 });
  return entries.allTextContents();
}

test("Conversation: a spoken exchange with Numa, with an interruption", async ({
  page,
}) => {
  await page.goto("/");
  const texts = await converse(page, /start conversation/i, "Numa");
  expect(texts.some((t) => t.startsWith("Numa"))).toBe(true);
  await page.getByRole("button", { name: /end conversation/i }).click();
  await expect(page.getByText("Session ended", { exact: true })).toBeVisible();
});
