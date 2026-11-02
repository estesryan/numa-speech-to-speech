# Test fixtures

`interrupt/manifest.json`: the three lines the integration and browser tests speak to the engine (a question,
an interruption and a short interruption), with the built-in voice and sample rate to use. No audio is committed:
each run has the engine's Voice Studio preview speak the lines (`tests/integration/conftest.py` and
`frontend/e2e/global-setup.ts`). The question addresses the assistant as "Ren": use the `ren-test` persona.

`traces/`: Realtime event traces for the client-side interruption fix, replayed by `tests/test_audio_client.py`
and by the browser implementation's tests (`frontend/tests/realtime-interruption.test.ts`). Each has `steps` (a
server event, or `{"play_s": seconds}` for the speaker consuming audio) and the exact client events `expected` in
reply. Audio deltas give `seconds` of silence instead of base64 data; other required protocol fields are filled in
on replay.
