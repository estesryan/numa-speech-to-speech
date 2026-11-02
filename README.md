# Numa

Numa is a local-first AI voice assistant. You talk to it out loud in your browser and it answers out loud, in real
time, with every model running on your own Mac: speech recognition, the language model and speech synthesis.
Nothing is sent to a cloud service, and your microphone audio is not recorded or stored.

## Features

- **Spoken conversation:** open-ended, low-latency voice chat with Numa, a general-purpose assistant.
- **Turn-taking:** voice activity detection (Silero VAD) and end-of-turn detection (Smart Turn) decide when you
  have finished speaking.
- **Interruptions:** start talking while Numa speaks and it stops at once. Its memory of the conversation then keeps
  only the words you actually heard, so it follows you instead of repeating itself.
- **Live transcript** of both speakers, with partial text while you speak.
- **Voice Studio:** choose one of six built-in voices, or create your own by recording or uploading a short
  reference (with the speaker's consent) or by describing a voice in words.
- **Local model status** in the header (connecting, connected, unavailable).

## Tech stack

| Part | Technology |
|---|---|
| Frontend (`frontend/`) | Next.js 16, React 19, TypeScript (strict), Tailwind CSS 4, Zod, Biome, Vitest, Playwright |
| Voice engine (`backend/voice-engine/`) | Python 3.12 (uv), [Hugging Face speech-to-speech](https://github.com/huggingface/speech-to-speech) 1.1.0 on MLX |
| Voice activity / turn detection | Silero VAD, Smart Turn v3.2 |
| Speech recognition | NVIDIA Parakeet TDT 0.6B v3 (MLX) |
| Language model | Qwen3.5-4B 4-bit (default) or Qwen3.5-9B 4-bit (MLX) |
| Speech synthesis | Qwen3-TTS 1.7B CustomVoice (built-in voices); optional Base (cloning) and VoiceDesign models |
| Transport | OpenAI Realtime-style WebSocket on `127.0.0.1:8765`, 16 kHz PCM16 audio |

How the parts work together: [docs/architecture.md](docs/architecture.md).

## Requirements

| | Version | Needed for |
|---|---|---|
| Mac with Apple Silicon | a recent macOS release; tested only on recent Apple Silicon chips | the voice engine (MLX) |
| Memory | the engine itself uses about 8 GB, 11–14 GB with custom voices, on top of macOS and the browser | the voice engine |
| [uv](https://docs.astral.sh/uv/) | 0.13+ (it installs Python 3.12 itself) | the voice engine |
| Node.js / npm | 22 LTS / 10 | the frontend |
| Google Chrome | current | the browser (other browsers are untested) |
| Disk | about 9 GB for the default models, about 14 GB with Voice Studio's optional models | models |

Headphones are recommended (see [Known limitations](#known-limitations)).

## Project structure

```
backend/voice-engine/    local voice engine (Python, uv): speech-to-speech plus Numa's profiles, personas and fixes
frontend/                browser app (Next.js, npm)
docs/                    architecture
models/                  model weights (created by setup; not versioned)
data/voices/             your Voice Studio voices (created on first use; private, not versioned)
```

## Install

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh     # once, if uv is missing

# Voice engine: Python environment, default models (downloaded and verified), unit tests
cd backend/voice-engine
scripts/setup.sh

# Frontend
cd ../../frontend
npm ci
```

### Models

Model weights are not part of this repository. `scripts/setup.sh` downloads the default (`fast`) profile's models
from Hugging Face at pinned revisions into `models/` at the project root, then checks every file's size and
SHA-256 against `backend/voice-engine/model-manifest.yaml`. To do it by hand:

```bash
cd backend/voice-engine
uv run numa-voice models download --profile fast     # about 9 GB
uv run numa-voice models verify --profile fast
uv run numa-voice models list                        # status, size and license of every model
```

Optional models:

```bash
# Voice Studio's Record, Upload and Describe (2.7 GB each)
uv run numa-voice models download --ids tts/qwen3-tts-1.7b-base-6bit tts/qwen3-tts-1.7b-voicedesign-6bit

# The larger language model for the `quality` profile (6 GB)
uv run numa-voice models download --profile quality
```

Set `NUMA_MODELS_DIR` to keep models elsewhere. At run time the engine works offline and loads models only from
that folder. Each model has its own license (listed by `models list` and in the manifest); for example, Parakeet is
CC BY 4.0 and Qwen3.5 / Qwen3-TTS are Apache 2.0.

## Run

Two terminals, from the project root:

```bash
# 1. The voice engine (keep it running; ready when it logs "Uvicorn running")
cd backend/voice-engine
uv run numa-voice serve

# 2. The browser app
cd frontend
npm run dev
```

Open <http://localhost:3000> and allow microphone access. Use `localhost` or `127.0.0.1`: the engine accepts only
those browser origins by default (`NUMA_VOICE_ALLOWED_ORIGINS` changes that).

For a production build, use `npm run build && npm run start` instead of `npm run dev`. `uv run numa-voice serve
--profile quality` uses the 9B model. Without the browser, `uv run numa-voice run` holds the same conversation in
the terminal.

Optional settings are listed in `frontend/.env.example` and `backend/voice-engine/.env.example`.

## Use

**Conversation.** Press *Start conversation* and talk. Numa listens, thinks and answers; the waveform shows who is
speaking. Interrupt it at any time. The microphone button mutes you; *End conversation* stops everything.
*Transcript* in the header opens the transcript; *Clear* empties the displayed transcript only.

**Voice Studio.** *Voice* in the header opens the panel:

- **Choose:** preview any voice with your own text, then *Set as Numa default*. It applies from the next
  conversation (Serena until you choose).
- **Create:** *Record* (read the passage shown, 3–30 s), *Upload* an audio file, or *Describe* a voice and pick one
  of three generated candidates. Record and Upload require confirming that it is your own voice or that its owner
  has given permission. These need the optional models above; without them the panel says so.
- **Manage:** rename or delete your voices.

Saved voices are kept on your Mac in `data/voices/` (or `NUMA_VOICES_DIR`). The folder is created on first use, is
git-ignored, and holds reference recordings: keep it private. A fresh install starts with no saved voices.

## Known limitations

- **Apple Silicon only:** the engine runs on MLX, so it needs a Mac with Apple Silicon. There is no Linux, Windows or
  Intel Mac support.
- **One conversation at a time:** a second browser tab is refused while a conversation runs.
- **Speakers and echo:** echo cancellation with laptop speakers has not been validated on real hardware. With
  speakers, Numa may hear itself and interrupt its own replies. Use headphones, or add `?halfDuplex` to the page URL
  (your microphone is ignored while Numa speaks, so you cannot interrupt it).
- **English:** the prompts and test material are English; other languages are untested.
- **Local network only:** the engine has an origin check but no authentication. Do not expose port 8765 to a
  network.
- **Voice Studio** cannot generate while a conversation runs, and a new default voice applies from the next
  conversation.
- **Model downloads** come from Hugging Face; the first setup needs a network connection and about 9 GB.

## Documentation

| Document | Contents |
|---|---|
| [TESTING.md](TESTING.md) | Test categories, commands, fixtures and troubleshooting |
| [docs/architecture.md](docs/architecture.md) | Pipeline, WebSocket session, interruptions, Voice Studio, upstream patches |
| [backend/voice-engine/README.md](backend/voice-engine/README.md) | Engine CLI, model storage, profiles, personas, Voice Studio API and storage |
| [frontend/README.md](frontend/README.md) | Frontend commands, settings, source layout and design tokens |
| [AGENTS.md](AGENTS.md) | Conventions and boundaries for AI coding agents |

## License

Copyright © 2026. All rights reserved.

This repository is publicly available for viewing and evaluation. No license is granted for reuse, modification or
redistribution beyond permissions provided by applicable law and GitHub's Terms of Service.
