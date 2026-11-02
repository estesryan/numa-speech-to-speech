"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DesignCandidates,
  VoiceApiError,
  type VoicesApi,
  type VoicesState,
  voicesApi,
} from "@/lib/voices/api";

export type PreviewTarget =
  | { voiceId: string }
  | { candidate: { token: string; index: number } };

/** Plays a WAV blob; resolves when playback ends. Replaceable in tests. */
export type PlayAudio = (audio: Blob, signal: AbortSignal) => Promise<void>;

export const playBlob: PlayAudio = (audio, signal) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(audio);
    const element = new Audio(url);
    const done = () => {
      element.pause();
      URL.revokeObjectURL(url);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    element.onended = done;
    element.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The browser could not play this audio."));
    };
    void element.play().catch(reject);
  });

export const DEFAULT_SAMPLE_TEXT =
  "Hi, it's lovely to hear from you. Take your time; I'm happy to talk things through.";

export interface VoiceStudio {
  state: VoicesState | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  /** What is in progress, e.g. "preview:preset-serena", "create", "design". */
  pending: string | null;
  playing: string | null;
  refresh: () => Promise<void>;
  preview: (target: PreviewTarget, text: string, key: string) => Promise<void>;
  stopPreview: () => void;
  /** Play audio the browser already has (a design candidate, a recording). */
  playClip: (audio: Blob, key: string) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  create: (
    name: string,
    method: "recorded" | "uploaded",
    wav: Blob,
  ) => Promise<boolean>;
  design: (description: string) => Promise<DesignCandidates | null>;
  saveDesign: (token: string, index: number, name: string) => Promise<boolean>;
  clearMessages: () => void;
}

let browserApi: VoicesApi | null = null;

/** One client for the page: a new one on each render would re-run the loading effect endlessly. */
function defaultApi(): VoicesApi {
  browserApi ??= voicesApi();
  return browserApi;
}

export function useVoiceStudio({
  api = defaultApi(),
  play = playBlob,
  enabled = true,
}: {
  api?: VoicesApi;
  play?: PlayAudio;
  enabled?: boolean;
} = {}): VoiceStudio {
  const [state, setState] = useState<VoicesState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const playback = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      playback.current?.abort();
    };
  }, []);

  const run = useCallback(
    async <T>(key: string, work: () => Promise<T>): Promise<T | null> => {
      setPending(key);
      setError(null);
      setNotice(null);
      try {
        return await work();
      } catch (e) {
        if (
          mounted.current &&
          !(e instanceof DOMException && e.name === "AbortError")
        ) {
          setError(
            e instanceof VoiceApiError || e instanceof Error
              ? e.message
              : "Something went wrong.",
          );
        }
        return null;
      } finally {
        if (mounted.current) {
          setPending(null);
        }
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.list();
      if (mounted.current) {
        setState(next);
        setError(null);
      }
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : "Couldn't load voices.");
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    if (enabled) {
      void refresh();
    }
  }, [enabled, refresh]);

  const stopPreview = useCallback(() => {
    playback.current?.abort();
    playback.current = null;
    setPlaying(null);
  }, []);

  const preview = useCallback(
    async (target: PreviewTarget, text: string, key: string) => {
      stopPreview();
      const controller = new AbortController();
      playback.current = controller;
      const audio = await run(`preview:${key}`, () =>
        api.preview(target, text, controller.signal),
      );
      if (!audio || controller.signal.aborted || !mounted.current) {
        return;
      }
      setPlaying(key);
      try {
        await play(audio, controller.signal);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Playback failed.");
      } finally {
        if (mounted.current && playback.current === controller) {
          setPlaying(null);
        }
      }
    },
    [api, play, run, stopPreview],
  );

  const playClip = useCallback(
    async (audio: Blob, key: string) => {
      stopPreview();
      const controller = new AbortController();
      playback.current = controller;
      setPlaying(key);
      try {
        await play(audio, controller.signal);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Playback failed.");
      } finally {
        if (mounted.current && playback.current === controller) {
          setPlaying(null);
        }
      }
    },
    [play, stopPreview],
  );

  const apply = useCallback((next: VoicesState | null, message?: string) => {
    if (next && mounted.current) {
      setState(next);
      if (message) {
        setNotice(message);
      }
    }
  }, []);

  return {
    state,
    loading,
    error,
    notice,
    pending,
    playing,
    refresh,
    preview,
    stopPreview,
    playClip,
    setDefault: async (id) =>
      apply(await run(`default:${id}`, () => api.setDefault(id))),
    rename: async (id, name) =>
      apply(
        await run(`rename:${id}`, () => api.rename(id, name)),
        "Voice renamed.",
      ),
    remove: async (id) =>
      apply(await run(`delete:${id}`, () => api.remove(id)), "Voice deleted."),
    create: async (name, method, wav) => {
      const result = await run("create", () => api.create(name, method, wav));
      apply(result, result ? `“${result.voice.name}” saved.` : undefined);
      return result !== null;
    },
    design: (description) =>
      run("design", () => api.designCandidates(description)),
    saveDesign: async (token, index, name) => {
      const result = await run("save-design", () =>
        api.saveDesign(token, index, name),
      );
      apply(result, result ? `“${result.voice.name}” saved.` : undefined);
      return result !== null;
    },
    clearMessages: () => {
      setError(null);
      setNotice(null);
    },
  };
}
