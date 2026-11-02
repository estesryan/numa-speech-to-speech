import { expect, test } from "@playwright/test";
import { clipPath, fakeMicrophone, QUESTION_THEN_BARGE_WAV } from "./audio";
import { engineRunning } from "./engine";

/**
 * Voice Studio in Chrome against the real engine: upload an authorized reference, create the voice, make it the
 * Conversation default, then hold a spoken conversation in it. The reference is the generated question line (global-setup.ts).
 * The test removes its voice and restores the previous default afterwards. Because it writes to the running
 * engine's voice store, it runs only with NUMA_E2E_TEMP_VOICES=1, confirming that engine was started with a
 * temporary store (NUMA_VOICES_DIR); it never touches a normal store by accident.
 */

const REFERENCE = clipPath("question");
const NAME = "E2E studio voice";
const API = "http://127.0.0.1:8765/v1/numa/voices";
const ORIGIN = { origin: "http://localhost:3000" };

test.use({ launchOptions: { args: fakeMicrophone(QUESTION_THEN_BARGE_WAV) } });
test.beforeEach(async () => {
  test.skip(
    process.env.NUMA_E2E_TEMP_VOICES !== "1",
    "writes voices: start the engine with NUMA_VOICES_DIR=$(mktemp -d), then set NUMA_E2E_TEMP_VOICES=1",
  );
  test.skip(
    !(await engineRunning()),
    "voice engine not running: start `uv run numa-voice serve`",
  );
});

test("create a voice, make it the default and converse in it", async ({
  page,
  request,
}) => {
  const before = await (await request.get(API, { headers: ORIGIN })).json();
  test.skip(
    !before.capabilities.clone.available,
    "needs the Qwen3-TTS Base model",
  );
  let created: string | null = null;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Voice" }).click();
    const panel = page.getByRole("region", { name: "Voice" });
    await panel.getByRole("tab", { name: "Upload" }).click();
    await panel.getByLabel("Voice recording file").setInputFiles(REFERENCE);
    await expect(panel.getByText(/s of speech, good level/)).toBeVisible();
    await panel.getByRole("textbox", { name: "Name" }).fill(NAME);
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "Create voice" }).click();
    await expect(panel.getByText(`“${NAME}” saved.`)).toBeVisible({
      timeout: 120_000,
    });

    const item = panel.getByRole("listitem").filter({ hasText: NAME });
    created = (
      await (await request.get(API, { headers: ORIGIN })).json()
    ).voices.find((v: { name: string }) => v.name === NAME).id;
    await item.getByRole("button", { name: "Set as Numa default" }).click();
    await expect(item.getByText("Numa default")).toBeVisible();
    await item.getByRole("button", { name: `Preview ${NAME}` }).click();
    await expect(
      item.getByRole("button", { name: `Stop ${NAME}` }),
    ).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: /start conversation/i }).click();
    await expect(page.getByText("Listening", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      panel.getByText(`This conversation speaks as ${NAME}.`),
    ).toBeVisible();
    await expect(page.getByText(/^Numa speaking$/)).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("button", { name: /end conversation/i }).click();
  } finally {
    if (created) {
      await request.delete(`${API}/${created}`, { headers: ORIGIN });
    }
    await request.put(`${API}/default`, {
      headers: ORIGIN,
      data: { voice_id: before.default },
    });
  }
});
