# Architecture

Numa has two processes on one Mac: a **browser app** (`frontend/`, Next.js) and a **voice engine**
(`backend/voice-engine/`, Python). The engine wraps Hugging Face
[speech-to-speech](https://github.com/huggingface/speech-to-speech) 1.1.0 ("upstream") and runs every model locally
on MLX. Nothing leaves the machine.

```
Browser (localhost:3000)                          Voice engine (127.0.0.1:8765)
┌──────────────────────────────┐                  ┌───────────────────────────────────────────────┐
│ microphone → AudioWorklet    │  PCM16 16 kHz    │ Silero VAD + Smart Turn   (turn-taking)       │
│   → downsample → WebSocket ──┼─────────────────►│   → Parakeet TDT          (speech → text)     │
│                              │  Realtime events │   → Qwen3.5 via mlx-lm    (reply text)        │
│ playback ◄── audio deltas ◄──┼◄─────────────────┤   → Qwen3-TTS             (text → speech)     │
│ transcript, state machine    │                  │                                               │
│ Voice panel ── HTTP ─────────┼─────────────────►│ Voice Studio API (/v1/numa/voices)            │
└──────────────────────────────┘                  └───────────────────────────────────────────────┘
```

## Responsibilities

**Frontend:** microphone capture and levels, streaming audio to the engine, playing replies, the transcript,
the conversation state machine (`lib/state/conversation-machine.ts`: `idle → connecting → listening ⇄ muted`,
plus `processing`, `speaking`, `error` and `ended`), the client half of interruption handling,
and the Voice panel UI. It never sends prompt text and never chooses the voice.

**Voice engine** (`numa_voice`, launched by the `numa-voice` CLI):

- **Profiles** (`profiles/`) pick the models; **personas** (`personas/`) define the assistant's prompt and voice.
- **Model loading:** weights live under `models/`, pinned and hashed in `model-manifest.yaml`, and are loaded by
  path with Hugging Face offline mode on. A missing model fails at startup rather than being downloaded.
- **Pipeline:** upstream runs the speech pipeline and the Realtime server.
- **Fixes:** Numa's changes to upstream behaviour are applied at launch (see
  [Upstream boundary](#upstream-boundary)).

## Speech pipeline

| Stage | Model | Notes |
|---|---|---|
| Voice activity | Silero VAD v5 | detects speech start and end |
| End of turn | Smart Turn v3.2 (ONNX) | decides whether a pause ends the turn; `profiles/base.yaml` sets the threshold (0.5), the extra hold for incomplete turns (600 ms) and the maximum wait (2 s) |
| Speech recognition | Parakeet TDT 0.6B v3 (MLX) | streams partial transcripts, then a final one |
| Language model | Qwen3.5-4B 4-bit (`fast`, default) or Qwen3.5-9B 4-bit (`quality`) | prompt = persona prompt + engine instructions |
| Speech synthesis | Qwen3-TTS 1.7B CustomVoice (presets); Base for saved voices | audio streams to the client as it is generated |

The engine serves **one session at a time**; a second connection is refused while one is active. All MLX
generation, live speech and Voice Studio previews alike, holds upstream's process-wide MLX lock.

After `chat_size` (30) user turns, upstream summarizes older history with the LLM (compaction).

## WebSocket session

The browser connects to `ws://127.0.0.1:8765/v1/realtime?persona=numa-assistant` with the `realtime` subprotocol,
using an OpenAI Realtime-style protocol:

1. **Origin and Host check:** an Origin outside the allowlist (`profiles/base.yaml`, or
   `NUMA_VOICE_ALLOWED_ORIGINS`) is rejected with 403 before a session slot is claimed. Requests without an Origin
   (CLI clients, tests) are allowed, but every request must name a loopback Host (`localhost`, `127.0.0.1`,
   `[::1]`), which stops DNS-rebinding pages. This protects a local machine from other web pages; it is not
   authentication.
2. **Persona:** the engine loads the persona, composes its prompt and resolves its voice. An unknown persona is
   refused. If the persona's voice is unavailable, the engine reports an `error` event and closes; it never
   substitutes a different voice.
3. **Session setup:** after `session.created`, the engine sends a Numa event, `numa.session`, naming the voice in
   use and, if the user's chosen default could not be used, why Serena was used instead. The client then sends
   its `session.update`.
4. **Client restrictions:** `instructions` and `audio.output.voice` are stripped from client events, and
   `system`/`developer` messages are dropped. Only the server sets the prompt and voice.

**Audio** is 16 kHz mono PCM16 in both directions. An AudioWorklet delivers microphone samples in about 40 ms
blocks; the page downsamples them and sends `input_audio_buffer.append`. Replies arrive as
`response.output_audio.delta` chunks with matching transcript deltas, and the page schedules them on its
`AudioContext`.

**Transcript:** user entries come from the recognition events; assistant entries appear when a reply's audio
arrives. Upstream may start speculative replies before the turn ends; one abandoned before it produced audio never
appears.

## Turn-taking and interruptions

Silero VAD and Smart Turn decide when the user has finished speaking. When the user starts talking while Numa
speaks (`input_audio_buffer.speech_started`), the page clears its playback at once and upstream cancels the reply
if it is still being generated.

Upstream then drops the interrupted reply from its history, so the model would not know it was interrupted and
tends to ask its question again. Only the client knows how much audio was played, so the fix is client-side and uses
only the public protocol:

- The unheard reply is removed: upstream has already removed a reply that was still generating, and the client
  deletes one that was already finalized (`conversation.item.delete`).
- A short note goes into the user's turn, quoting only the **complete sentences** the user heard, e.g.
  `(The guest interrupts you. They heard you say: "…" Then they cut you off.)`. The engine instructions tell the
  model to treat it as context, never read it aloud, and follow the user.
- The transcript keeps only the words that were heard.

**Why whole sentences:** Qwen3.5 imitates its own earlier turns. Truncated assistant turns, markers in them, or
quoted half-sentences made later replies come out truncated, read the marker aloud, or finish the abandoned
sentence. The prompts call the user "the guest"; that wording is part of the tested prompt.

There are two implementations: `frontend/lib/realtime/interruption.ts` (browser) and
`numa_voice/interruption.py` (the terminal client, `numa-voice run` / `talk`). Both replay the same event traces in
tests, so they must change together.

**Speakers:** the browser's echo cancellation is on, but whether it suppresses Numa's own voice from laptop speakers
has not been verified. `?halfDuplex` in the page URL sends silence while Numa speaks, which disables interruptions.

## Voice Studio

Voice Studio is served by the same engine process: an HTTP API under `/v1/numa/voices` (`numa_voice/voice_api.py`)
with CORS for the same allowed origins.

- **Built-in voices:** six Qwen3-TTS CustomVoice presets. Serena is the default until the user chooses another.
- **Saved voices:** recorded, uploaded or designed. Each is a reference clip plus its transcript in
  `data/voices/<id>/` (or `NUMA_VOICES_DIR`). Record and Upload require the owner's consent; the transcript comes
  from Parakeet. Describe uses the VoiceDesign model to generate three candidates; the chosen one becomes the
  reference.
- **Live use:** a saved voice is cloned by the Qwen3-TTS **Base** model on every reply, through upstream's own
  streaming path, so cancellation and the MLX lock behave as they do for presets.
- **Fixed per session:** the voice is chosen when a session starts; a new default applies from the next one.
- **Personas:** `numa-assistant` speaks in the user's chosen default. Other personas use a fixed preset and can
  never use a saved voice.
- **No conflict with live speech:** conversations and generation (previews, transcription, design) exclude each
  other. Generation is refused with 409 while a conversation is connected, and a conversation is refused with an
  `error` event while generation runs. The voice a conversation speaks in cannot be deleted until it ends.
- **Shared models:** previews in built-in voices use the pipeline's CustomVoice model, and transcription of new
  references uses the pipeline's Parakeet model. A session in a saved voice starts loading the Base model when it
  connects.
- **Optional models:** Base and VoiceDesign are optional. Without them the UI shows those methods as unavailable.
- **Privacy:** reference recordings are never served back over HTTP.

## Upstream boundary

Nothing inside `.venv` is edited. `numa-voice` replaces specific upstream functions in memory at launch
(`numa_voice/patches/`). Each patch first checks the upstream version (1.1.0) and the exact source it depends on,
and stops with `UpstreamIncompatible` if either changed. `NUMA_VOICE_ALLOW_UNTESTED_UPSTREAM=1` skips only the
version check.

| Patch | Purpose |
|---|---|
| `origin.py` | Origin allowlist and loopback Host check for WebSocket and HTTP routes |
| `session_persona.py` | per-session persona, server-composed prompt, voice selection, stripping client prompt text |
| `voice_studio.py` | mounts the Voice Studio API and CORS on upstream's server; shares the pipeline's Parakeet model |
| `custom_voice.py` | speaks saved voices with the Base model |
| `compaction.py` | passes `enable_thinking=False` on upstream's MLX compaction path; without it, compaction fails with Qwen3.5 on every turn |
| `audio_client.py` | adds the interruption fix to upstream's terminal audio client |

## Key decisions

- **Local only:** the engine listens on `127.0.0.1`, loads models offline from the project, and sends no telemetry.
  Microphone audio is not stored; only Voice Studio references are saved, and only on the user's request.
- **Server-owned prompts and voices:** clients choose a persona by id and nothing else.
- **Pinned upstream with guarded patches**, rather than a fork, so upgrades fail loudly instead of silently changing
  behaviour.
