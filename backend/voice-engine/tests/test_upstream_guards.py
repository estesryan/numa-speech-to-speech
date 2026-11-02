"""Every patch checks the upstream code it depends on and fails clearly when that code changes."""

import pytest
import speech_to_speech
from speech_to_speech.api.openai_realtime import audio_client as ac

from numa_voice import patches
from numa_voice.patches import UpstreamIncompatible, audio_client, compaction, require, require_source


def test_the_installed_upstream_is_the_tested_version():
    assert speech_to_speech.__version__ == patches.TESTED_UPSTREAM
    patches.check_upstream_version()


def test_an_untested_version_stops_both_launch_paths(monkeypatch):
    monkeypatch.setattr(speech_to_speech, "__version__", "1.2.0")
    monkeypatch.delenv("NUMA_VOICE_ALLOW_UNTESTED_UPSTREAM", raising=False)
    for apply in (patches.apply_server_patches, patches.apply_client_patches):
        with pytest.raises(UpstreamIncompatible, match="1.2.0"):
            apply()


def test_a_missing_attribute_is_reported_by_name():
    with pytest.raises(UpstreamIncompatible, match="_gone"):
        require(ac, "PlaybackBuffer", "_gone")


def test_changed_source_is_reported():
    with pytest.raises(UpstreamIncompatible, match="no longer contains"):
        require_source(ac.PlaybackBuffer.__init__, "self._audio = bytearray()", "self._ring = deque()")


def test_compaction_patch_checks_the_branch_it_copies(monkeypatch):
    assert compaction.upstream_is_affected()
    monkeypatch.setattr(compaction, "_MLX_BRANCH", (*compaction._MLX_BRANCH, "max_tokens = 2048"))
    with pytest.raises(UpstreamIncompatible):
        compaction.upstream_is_affected()


def test_audio_client_patch_checks_the_event_order(monkeypatch):
    audio_client._check_upstream()

    async def reordered(conn, config):  # handle_server_event( before tool_calls.handle_event(event)
        playback = PlaybackBuffer(16000)  # noqa: F841, F821
        tool_calls = _ToolCallCoordinator(conn, config)  # noqa: F821
        handle_server_event(event)  # noqa: F821
        tool_calls.handle_event(event)  # noqa: F821

    monkeypatch.setattr(ac, "_run_audio_session", reordered)
    with pytest.raises(UpstreamIncompatible, match="order"):
        audio_client._check_upstream()


def test_the_version_override_does_not_skip_the_code_checks(monkeypatch):
    monkeypatch.setattr(speech_to_speech, "__version__", "1.2.0")
    monkeypatch.setenv("NUMA_VOICE_ALLOW_UNTESTED_UPSTREAM", "1")
    patches.check_upstream_version()  # allowed
    monkeypatch.delattr(ac, "_ToolCallCoordinator")
    with pytest.raises(UpstreamIncompatible):
        audio_client._check_upstream()


def test_custom_voice_patch_checks_the_tts_handler_it_extends():
    from speech_to_speech.TTS import qwen3_tts_handler as qt

    from numa_voice.patches import custom_voice

    with pytest.raises(UpstreamIncompatible, match="no longer contains"):
        require_source(qt.Qwen3TTSHandler.process, *("self._apply_session_voice_override(model_type, runtime_config, "
                                                      "response)", "self._process_voice_clone_v2("))
    assert custom_voice.TOKEN == "numa-voice:"


def test_custom_voice_routing_leaves_presets_to_upstream(monkeypatch):
    from types import SimpleNamespace

    from numa_voice.patches import custom_voice

    calls = []
    monkeypatch.setitem(custom_voice._ORIGINAL, "_apply_session_voice_override",
                        lambda self, model_type, rc=None, resp=None: calls.append("upstream"))
    handler = SimpleNamespace(_numa_voice=("voice-0123456789ab", {}))
    session = SimpleNamespace(session=SimpleNamespace(audio=SimpleNamespace(output=SimpleNamespace(voice="aiden"))))
    custom_voice._apply_session_voice_override(handler, "custom_voice", session, None)
    assert calls == ["upstream"] and handler._numa_voice is None


def test_a_missing_saved_voice_is_silent_not_replaced(monkeypatch):
    from types import SimpleNamespace

    from numa_voice.patches import custom_voice

    handler = SimpleNamespace(_numa_voice=None, backend="mlx")
    session = SimpleNamespace(session=SimpleNamespace(audio=SimpleNamespace(
        output=SimpleNamespace(voice="numa-voice:voice-0123456789ab"))))
    custom_voice._apply_session_voice_override(handler, "custom_voice", session, None)
    assert handler._numa_voice == ("voice-0123456789ab", None)
    assert list(custom_voice._process_custom_voice(handler, "Hello.")) == []  # no audio, never a preset instead
