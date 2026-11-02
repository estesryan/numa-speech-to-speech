# Numa frontend

The browser app: the Conversation page (`/`) and the Voice panel. It talks to the local voice engine over its
Realtime WebSocket and Voice Studio API. Installation and running are in the [root README](../README.md#install),
tests in [TESTING.md](../TESTING.md), and the session and audio design in
[docs/architecture.md](../docs/architecture.md).

This project uses npm and `package-lock.json`, never pnpm or yarn.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | development server on <http://localhost:3000> (includes the development-only state simulation) |
| `npm run build` / `npm run start` | production build / serve it |
| `npm run lint:fix` | apply Biome fixes and formatting |

## Settings

Microphone access needs a secure context, so use `http://localhost:3000` or `http://127.0.0.1:3000`. Those are also
the only browser origins the engine accepts by default.

| Setting | Effect |
|---|---|
| `NEXT_PUBLIC_NUMA_VOICE_URL` | engine WebSocket (default `ws://127.0.0.1:8765/v1/realtime`) |
| `NEXT_PUBLIC_NUMA_VOICE=off` | no engine: microphone-only preview with the development state simulation |
| `?halfDuplex` in the page URL | send silence while Numa speaks (for speakers if echo cancellation fails) |

The environment variables are listed in `.env.example`; copy it to `.env.local` to change them.

## Source layout

```
app/                     layout, Conversation page (/), icon, design tokens
components/studio/       page shell, header, waveform, controls, timer, status, transcript and Voice panels
components/ui/           shadcn/ui primitives (button)
hooks/                   useConversation (state, microphone, voice session, transcript), useSessionTimer, ...
lib/audio/               microphone session (getUserMedia, AnalyserNode, AudioWorklet capture), level maths
lib/realtime/            voice session: WebSocket client, PCM codec, playback, interruption history, transcript
lib/session/modes.json   Conversation settings: persona id and display copy (persona prompts live in the engine)
lib/voices/              Voice Studio: engine API client, reference checks and WAV encoding, recorder
lib/state/               conversation state machine
lib/schemas/             Zod transcript events and reducer
public/worklets/         AudioWorklet that hands microphone samples to the page
tests/                   Vitest + React Testing Library, with media and voice fakes
e2e/                     Playwright tests in Chrome with a fake microphone, against the real engine
```

## Behaviour notes

- **Leaving the page** ends the session. Next.js keeps a route hidden instead of unmounting it, so the page also
  ends its session when hidden, releasing the microphone, playback and connection.
- **Voice recordings** use a separate microphone stream without echo cancellation or noise suppression, which would
  colour the reference. They go only to the local engine and are never played back from a URL.
- **Reduced motion:** the processing sweep stops, live levels update in discrete steps, and pulsing indicators are
  disabled.
- **Without an engine** (`NEXT_PUBLIC_NUMA_VOICE=off`), the transcript panel says so instead of showing anything
  derived from the microphone.

## Design

The design tokens live in `app/globals.css`:

- navy gradient `#182333 → #111821`;
- white Inter-bold wordmark with tight tracking;
- mint status dot `#7DDCC9` with slate label `#B5C1CE`;
- rounded mint bars `#78DDC8`.

The resting waveform is Numa's 52-bar signature silhouette (`components/studio/waveform.tsx`).
