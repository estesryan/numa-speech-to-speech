/**
 * Controlled microphone input for the browser tests: Chrome's fake capture device plays a WAV file composed of
 * spoken lines and silences. The lines (backend/voice-engine/tests/fixtures/interrupt/manifest.json) are spoken by
 * the running engine's built-in voice in global-setup.ts at the start of each run; no recordings are committed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LINES = join(
  __dirname,
  "../../backend/voice-engine/tests/fixtures/interrupt/manifest.json",
);
const ENGINE = "http://127.0.0.1:8765";
export const GENERATED = join(__dirname, ".generated");

/** A generated line (question, barge, barge_short) as a WAV file. */
export function clipPath(name: string): string {
  return join(GENERATED, "clips", `${name}.wav`);
}

/** Speak every line with the engine's Voice Studio preview; waits while an earlier session is being released. */
export async function generateClips(): Promise<void> {
  const script = JSON.parse(readFileSync(LINES, "utf8")) as {
    voice: string;
    lines: Record<string, { text: string }>;
  };
  for (const [name, line] of Object.entries(script.lines)) {
    const deadline = Date.now() + 120_000;
    let response: Response;
    for (;;) {
      response = await fetch(`${ENGINE}/v1/numa/voices/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voice_id: script.voice, text: line.text }),
      });
      if (response.status !== 409 || Date.now() > deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!response.ok) {
      throw new Error(
        `could not generate the "${name}" test line: ${response.status}`,
      );
    }
    const out = clipPath(name);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(await response.arrayBuffer()));
  }
}

function pcm(path: string): { rate: number; data: Buffer } {
  const wav = readFileSync(path);
  let rate = 0;
  let offset = 12;
  while (offset < wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      rate = wav.readUInt32LE(offset + 12);
      const channels = wav.readUInt16LE(offset + 10);
      const bits = wav.readUInt16LE(offset + 22);
      if (channels !== 1 || bits !== 16) {
        throw new Error(`${path}: expected 16-bit mono PCM`);
      }
    } else if (id === "data") {
      return { rate, data: wav.subarray(offset + 8, offset + 8 + size) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

/** Generated lines (question, barge, barge_short) and silences in seconds, in order, as one WAV file. */
export function composeWav(
  name: string,
  parts: Array<string | number>,
): string {
  const clips = new Map(
    parts
      .filter((p): p is string => typeof p === "string")
      .map((p) => [p, pcm(clipPath(p))]),
  );
  const rates = new Set([...clips.values()].map((c) => c.rate));
  if (rates.size !== 1) {
    throw new Error("the test lines must share one sample rate");
  }
  const [rate] = rates;
  const data = Buffer.concat(
    parts.map((p) =>
      typeof p === "number"
        ? Buffer.alloc(Math.round(p * rate) * 2)
        : (clips.get(p) as { data: Buffer }).data,
    ),
  );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const out = join(GENERATED, `${name}.wav`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.concat([header, data]));
  return out;
}

/** Chrome flags: grant the microphone and feed it `wav` once (no loop). */
export function fakeMicrophone(wav: string): string[] {
  return [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
  ];
}

/** The user asks an open question, waits for the assistant to start answering, then cuts in. */
export const QUESTION_THEN_BARGE = ["question", 3.5, "barge", 15] as const;
/** Composed by global-setup.ts before the browser starts. */
export const QUESTION_THEN_BARGE_WAV = join(
  GENERATED,
  "question-then-barge.wav",
);
