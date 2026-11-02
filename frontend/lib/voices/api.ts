/**
 * Voice Studio API of the local voice engine (backend/voice-engine/numa_voice/voice_api.py), on the same host as
 * the Realtime WebSocket. Every generation runs on the engine's real models; errors carry the engine's message.
 */

import { DEFAULT_VOICE_URL, unreachableMessage } from "@/lib/realtime/client";

export type VoiceMethod =
  | "preset"
  | "recorded"
  | "uploaded"
  | "designed"
  | "unknown";

export interface VoiceInfo {
  id: string;
  name: string;
  method: VoiceMethod;
  builtin: boolean;
  created_at: string | null;
  description: string | null;
  available: boolean;
  problem: string | null;
}

export interface Capability {
  available: boolean;
  reason: string | null;
}

export interface VoicesState {
  voices: VoiceInfo[];
  default: string;
  default_problem: string | null;
  capabilities: { presets: Capability; clone: Capability; design: Capability };
  /** A conversation is live: generation waits until it ends. */
  busy: boolean;
}

export interface DesignCandidates {
  token: string;
  text: string;
  candidates: { index: number; audio: string; duration_s: number }[];
}

export class VoiceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VoiceApiError";
  }
}

export function voicesBaseUrl(realtimeUrl = DEFAULT_VOICE_URL): string {
  const url = new URL(realtimeUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${url.origin}/v1/numa/voices`;
}

export type Fetch = typeof fetch;

export function voicesApi(
  base = voicesBaseUrl(),
  fetcher: Fetch = (...a) => fetch(...a),
) {
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, init);
    } catch {
      throw new VoiceApiError(unreachableMessage(base), 0);
    }
    if (!response.ok) {
      let message = `The voice engine answered ${response.status}.`;
      try {
        const body = (await response.json()) as { detail?: unknown };
        if (typeof body.detail === "string") {
          message = body.detail;
        }
      } catch {
        // keep the generic message
      }
      throw new VoiceApiError(message, response.status);
    }
    return response;
  }
  const json = (body: unknown): RequestInit => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const state = async (r: Promise<Response>) =>
    (await (await r).json()) as VoicesState;

  return {
    list: () => state(call("")),
    preview: async (
      target:
        | { voiceId: string }
        | { candidate: { token: string; index: number } },
      text: string,
      signal?: AbortSignal,
    ): Promise<Blob> => {
      const body =
        "voiceId" in target
          ? { voice_id: target.voiceId, text }
          : { candidate: target.candidate, text };
      return (
        await call("/preview", { method: "POST", signal, ...json(body) })
      ).blob();
    },
    create: async (
      name: string,
      method: "recorded" | "uploaded",
      wav: Blob,
    ): Promise<VoicesState & { voice: VoiceInfo }> => {
      const query = new URLSearchParams({ name, method, consent: "true" });
      return (
        await call(`?${query}`, {
          method: "POST",
          headers: { "content-type": "audio/wav" },
          body: wav,
        })
      ).json();
    },
    designCandidates: async (
      description: string,
      count = 3,
    ): Promise<DesignCandidates> =>
      (
        await call("/design/candidates", {
          method: "POST",
          ...json({ description, count }),
        })
      ).json(),
    saveDesign: async (
      token: string,
      index: number,
      name: string,
    ): Promise<VoicesState & { voice: VoiceInfo }> =>
      (
        await call("/design", {
          method: "POST",
          ...json({ token, index, name }),
        })
      ).json(),
    rename: (id: string, name: string) =>
      state(
        call(`/${encodeURIComponent(id)}`, {
          method: "PATCH",
          ...json({ name }),
        }),
      ),
    remove: (id: string) =>
      state(call(`/${encodeURIComponent(id)}`, { method: "DELETE" })),
    setDefault: (id: string) =>
      state(call("/default", { method: "PUT", ...json({ voice_id: id }) })),
  };
}

export type VoicesApi = ReturnType<typeof voicesApi>;
