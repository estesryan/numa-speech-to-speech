/**
 * The Conversation experience. A mode names a backend persona (backend/voice-engine/personas/<persona>.yaml); the
 * persona's prompt and engine rules are composed by the voice engine, never sent from here.
 * The strings below are display copy only. A backend test checks every persona id exists.
 */
import modes from "./modes.json";

export type ModeId = keyof typeof modes;

export interface ModeConfig {
  id: ModeId;
  path: string;
  label: string;
  persona: string;
  /** Speaker name in the transcript. */
  hostName: string;
  /** Short name in status labels ("Numa speaking"). */
  speakerLabel: string;
  idleDetail: string;
  startLabel: string;
  endLabel: string;
}

export const MODES: Record<ModeId, ModeConfig> = {
  conversation: { id: "conversation", ...modes.conversation },
};

/** What one voice session asks the backend for, plus how the studio labels the assistant. */
export interface SessionConfig {
  mode: ModeId;
  persona: string;
  hostName: string;
}

export function sessionConfig(mode: ModeConfig): SessionConfig {
  return { mode: mode.id, persona: mode.persona, hostName: mode.hostName };
}
