"""Profiles, manifest and project-local paths (no models needed except where noted)."""

import re
import shutil
from pathlib import Path

import pytest

from numa_voice.manifest import Model, hash_tree, load_manifest, verify
from numa_voice.paths import PROJECT_ROOT, VOICE_ENGINE_DIR, models_root, runtime_env
from numa_voice.profiles import (PLACEHOLDER, ProfileError, available_profiles, load_profile, required_models,
                                 resolve_profile)

TRACKED = [*sorted((VOICE_ENGINE_DIR / "profiles").glob("*.yaml")), *sorted((VOICE_ENGINE_DIR / "personas").glob("*.yaml")),
           VOICE_ENGINE_DIR / "model-manifest.yaml"]


def models_present() -> bool:
    return all(not verify(load_manifest()[m], models_root(), deep=False) for m in required_models(load_profile("fast")))


def test_profiles_fast_is_4b_and_quality_is_9b():
    assert {"fast", "quality"} <= set(available_profiles())
    assert "llm/qwen3.5-4b-4bit" in required_models(load_profile("fast"))
    assert "llm/qwen3.5-9b-4bit" in required_models(load_profile("quality"))
    assert "llm/qwen3.5-9b-4bit" not in required_models(load_profile("fast"))


def test_unknown_profile_is_rejected():
    with pytest.raises(ProfileError, match="available"):
        load_profile("enormous")


def test_tracked_configuration_has_no_absolute_paths():
    for path in TRACKED:
        text = path.read_text()
        assert not re.search(r"(/Users/|/home/|~/|[A-Z]:\\)", text), f"absolute path in {path.name}"


def test_manifest_pins_every_model():
    for m in load_manifest().values():
        assert m.license and m.path and m.component
        assert not Path(m.path).is_absolute()
        if m.source["type"] in ("huggingface", "github-archive"):
            assert re.fullmatch(r"[0-9a-f]{40}", m.source["revision"]), f"{m.id} is not pinned to a commit"
        assert m.files, f"{m.id}: run `numa-voice models lock`"


def test_models_root_defaults_to_project_and_can_be_overridden(monkeypatch, tmp_path):
    monkeypatch.delenv("NUMA_MODELS_DIR", raising=False)
    assert models_root() == PROJECT_ROOT / "models"
    monkeypatch.setenv("NUMA_MODELS_DIR", str(tmp_path))
    assert models_root() == tmp_path.resolve()


def test_runtime_environment_is_offline_and_never_points_at_another_cache(tmp_path):
    env = runtime_env(tmp_path)
    assert env["HF_HUB_OFFLINE"] == "1" and env["TRANSFORMERS_OFFLINE"] == "1"
    for key in ("HF_HOME", "TORCH_HOME", "NLTK_DATA"):
        assert env[key].startswith(str(tmp_path)), key


def test_missing_models_fail_loudly(tmp_path):
    with pytest.raises(ProfileError, match="missing"):
        resolve_profile("fast", root=tmp_path)


def test_verify_detects_changed_and_missing_files(tmp_path):
    d = tmp_path / "tts" / "x"
    d.mkdir(parents=True)
    (d / "weights.bin").write_bytes(b"\x00" * 100)
    (d / "config.json").write_text("{}")
    m = Model(id="tts/x", component="tts", source={"type": "huggingface"}, license="mit", path="tts/x",
              files=hash_tree(d))
    assert verify(m, tmp_path) == []
    (d / "weights.bin").write_bytes(b"\x01" * 100)
    assert any("SHA-256" in p for p in verify(m, tmp_path))
    (d / "config.json").unlink()
    assert any("missing config.json" in p for p in verify(m, tmp_path))


@pytest.mark.skipif(not models_present(), reason="fast-profile models are not installed under models/")
def test_rendered_profiles_point_only_into_the_models_root():
    root = models_root()
    for name in ("fast", "quality"):
        try:
            doc = resolve_profile(name)
        except ProfileError:
            if name == "quality":
                continue  # 9B not installed on this machine
            raise
        paths = []

        def walk(node):
            if isinstance(node, dict):
                [walk(v) for v in node.values()]
            elif isinstance(node, str) and node.startswith("/"):
                paths.append(node)

        walk(doc)
        assert paths and all(p.startswith(str(root)) for p in paths)
        assert PLACEHOLDER not in str(doc)


@pytest.mark.skipif(not models_present(), reason="fast-profile models are not installed under models/")
def test_rendered_profile_passes_upstream_validation():
    from numa_voice.paths import apply_runtime_env
    from numa_voice.profiles import write_resolved

    apply_runtime_env()
    for speakers in (False, True):
        path = write_resolved("fast", speakers=speakers)
        assert ("block_mic_during_playback: true" in path.read_text()) == speakers


def test_quality_profile_resolves_when_9b_is_present_in_a_models_root(tmp_path):
    # build a fake models root with just the directories (and file) the profile references
    for mid in required_models(load_profile("quality")):
        d = tmp_path / load_manifest()[mid].path
        d.mkdir(parents=True)
    (tmp_path / "vad/smart-turn-v3.2/smart-turn-v3.2-cpu.onnx").write_bytes(b"")
    doc = resolve_profile("quality", root=tmp_path)
    assert doc["blocks"]["llm"]["settings"]["model_name"] == str(tmp_path / "llm/qwen3.5-9b-4bit")
    shutil.rmtree(tmp_path)
