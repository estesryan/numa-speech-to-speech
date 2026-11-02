import { composeWav, generateClips, QUESTION_THEN_BARGE } from "./audio";
import { engineRunning } from "./engine";

/** Generates the spoken test lines with the running engine. Without an engine the specs skip themselves. */
export default async function globalSetup(): Promise<void> {
  if (!(await engineRunning())) {
    return;
  }
  await generateClips();
  composeWav("question-then-barge", [...QUESTION_THEN_BARGE]);
}
