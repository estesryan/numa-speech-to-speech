/** Connection to the local voice engine (backend/voice-engine), as reported by useConversation. */
export type ModelConnectionStatus =
  | "not-connected"
  | "connecting"
  | "connected"
  | "error";

export const MODEL_STATUS_LABEL: Record<ModelConnectionStatus, string> = {
  "not-connected": "Not connected",
  connecting: "Connecting",
  connected: "Connected",
  error: "Unavailable",
};
