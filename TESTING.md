# Testing

All test instructions for Numa. Install the project first ([README](README.md#install)): `scripts/setup.sh` creates
the engine's environment, including pytest, and `npm ci` installs the frontend's test tools.

## Quick checks

These need no models, GPU or running engine:

```bash
cd backend/voice-engine && uv run pytest                          # engine unit tests
cd frontend && npm test && npm run typecheck && npm run lint      # frontend unit tests, types, Biome
```

## Test categories

| Category | Command | Needs |
|---|---|---|
| Engine unit | `uv run pytest` (in `backend/voice-engine`) | nothing; a few profile tests run only when the `fast` models are installed |
| Engine integration | `uv run pytest -m integration` | Apple Silicon, the `fast` models, port 8765 free; about 3 minutes |
| Frontend unit and component | `npm test` (in `frontend`) | nothing (Vitest, jsdom, fake media and engine) |
| Types and lint | `npm run typecheck`, `npm run lint` | nothing |
| Browser end-to-end | `npm run test:e2e` (in `frontend`) | Google Chrome, a running engine on port 8765 with models |

**Engine unit tests** cover profiles, the model manifest, personas, the Origin and persona middleware, Voice Studio
storage and API (with a fake model backend), the interruption logic, and the upstream guards. They never touch
`data/voices/`.

**Engine integration tests** (`tests/integration/`) start their own engine with
`numa-voice serve --profile fast --persona ren-test`, offline, with a temporary voices directory. They check
offline loading, the origin policy, interruptions with spoken test lines, a 40-turn session that triggers history
compaction, and Voice Studio end to end.

- The Voice Studio tests are skipped without the optional Base or VoiceDesign models.
- To use an engine that is already running, set `NUMA_VOICE_TEST_URL`. Assertions that read the engine log are then
  skipped, and so are the Voice Studio tests, which create voices only in the engine they start themselves.

**Browser tests** (`frontend/e2e/`) use Playwright with the installed Chrome (nothing is downloaded). Chrome's fake
microphone plays the generated test lines, so the tests cover the browser audio path, transcripts and
interruptions, but not a physical microphone, speakers or echo cancellation.

- Playwright builds and starts the app on port 3000, or reuses a server already running there.
- Tests are skipped when no engine is listening on port 8765.
- `voice-studio.spec.ts` creates a voice in the running engine's voice store (and deletes it afterwards). It is
  skipped unless you start the engine with a temporary store and confirm it:
  `NUMA_VOICES_DIR=$(mktemp -d) uv run numa-voice serve`, then `NUMA_E2E_TEMP_VOICES=1 npm run test:e2e`.

`bench/realtime_bench.py` is the Realtime client the integration tests use. Its own benchmark sessions read inputs
from `bench-data/`, which is not included in the repository.

## Fixtures

`backend/voice-engine/tests/fixtures/` ([README](backend/voice-engine/tests/fixtures/README.md)):

- `interrupt/manifest.json`: the lines the integration and browser tests speak. No audio is committed: at the start
  of each run the engine's Voice Studio preview speaks them in a built-in voice, into a temporary folder
  (`tests/integration/conftest.py`, `frontend/e2e/global-setup.ts`). The question addresses the assistant as
  "Ren", so the tests use the `ren-test` persona, whose prompt a unit test keeps fixed.
- `traces/`: Realtime event traces replayed by both interruption implementations
  (`tests/test_audio_client.py` and `frontend/tests/realtime-interruption.test.ts`). A change to the interruption
  logic must pass both.

## Focused runs

```bash
# engine (in backend/voice-engine)
uv run pytest tests/test_interruption.py
uv run pytest tests/test_voices.py -k consent
uv run pytest -m integration tests/integration/test_voice_studio_live.py

# frontend (in frontend)
npx vitest run tests/voice-session.test.ts
npx vitest run -t "interrupted"
npx playwright test e2e/voice.spec.ts
```

## Interpreting failures

- **`UpstreamIncompatible` / `test_upstream_guards.py`:** the installed speech-to-speech differs from what a patch
  was written against. Restore the pinned environment with `uv sync --frozen`, or update the patch and its checks.
- **`test_ren_test_prompt_is_fixed`:** the `ren-test` prompt or the engine instructions changed. If that was
  intended, update the expected prompt. Live results are then no longer comparable with earlier runs.
- **Manifest tests ("run `numa-voice models lock`"):** a model entry has no recorded file hashes.
- **"port 8765 is busy":** stop the running engine, or set `NUMA_VOICE_TEST_URL` to test against it.
- **Skipped tests:** read the skip reason. Missing optional models and a stopped engine are reported as skips, not
  failures.
- **Integration and browser assertions about replies** (no repeated question, recalling details after compaction)
  depend on model output. Before changing code, check the reply text in the failure message and the engine log.
