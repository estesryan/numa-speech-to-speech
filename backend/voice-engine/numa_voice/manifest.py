"""Model manifest: load, verify, download (pinned revisions) and migrate from a local Hugging Face cache.

Models are stored as plain files under the models root, one directory per model, never as cache snapshots made of
symlinks, so they can be copied or moved freely. Every operation is idempotent: a model whose files already match
the manifest is left alone.
"""

from __future__ import annotations

import hashlib
import io
import os
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .paths import MIGRATE_CACHE, MANIFEST_PATH

IGNORED = {".cache", "__pycache__", ".DS_Store", ".gitattributes"}


@dataclass
class Model:
    id: str
    component: str
    source: dict[str, Any]
    license: str
    path: str
    quantization: str = ""
    format: str = ""
    description: str = ""
    base_model: str | None = None
    install_as: str | None = None
    files: dict[str, dict[str, Any]] = field(default_factory=dict)

    def directory(self, root: Path) -> Path:
        return root / self.path


def load_manifest(path: Path = MANIFEST_PATH) -> dict[str, Model]:
    doc = yaml.safe_load(path.read_text())
    if doc.get("schema") != 1:
        raise ValueError(f"{path}: unsupported manifest schema {doc.get('schema')!r}")
    return {mid: Model(id=mid, **spec) for mid, spec in doc["models"].items()}


# ------------------------------------------------------------------------------------------------------ hashing
def _walk(directory: Path) -> list[Path]:
    out = []
    for p in sorted(directory.rglob("*")):
        rel = p.relative_to(directory)
        if any(part in IGNORED for part in rel.parts) or p.is_dir() or p.suffix == ".pyc":
            continue
        out.append(p)
    return out


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def hash_tree(directory: Path) -> dict[str, dict[str, Any]]:
    return {str(p.relative_to(directory)): {"size": p.stat().st_size, "sha256": sha256(p)} for p in _walk(directory)}


def verify(model: Model, root: Path, deep: bool = True) -> list[str]:
    """Problems with a model's files (empty list = verified). `deep=False` checks presence and sizes only."""
    d = model.directory(root)
    if not d.is_dir():
        return [f"missing directory {d}"]
    if not model.files:
        return [f"{model.id}: manifest has no file list; run `numa-voice models lock`"]
    problems = []
    for rel, meta in model.files.items():
        p = d / rel
        if not p.is_file():
            problems.append(f"missing {rel}")
        elif p.is_symlink():
            problems.append(f"{rel} is a symlink (expected a plain file)")
        elif p.stat().st_size != meta["size"]:
            problems.append(f"{rel}: size {p.stat().st_size} != {meta['size']}")
        elif deep and sha256(p) != meta["sha256"]:
            problems.append(f"{rel}: SHA-256 mismatch")
    return problems


def lock(manifest_path: Path, ids: list[str], root: Path) -> None:
    """Record the size and SHA-256 of every file of the given (already verified-by-source) models."""
    doc = yaml.safe_load(manifest_path.read_text())
    for mid in ids:
        d = root / doc["models"][mid]["path"]
        doc["models"][mid]["files"] = hash_tree(d)
    header = "".join(line + "\n" for line in manifest_path.read_text().splitlines() if line.startswith("#"))
    manifest_path.write_text(header + yaml.safe_dump(doc, sort_keys=False, width=120))


# ------------------------------------------------------------------------------------------------ installation
def _clone_file(src: Path, dst: Path) -> None:
    """Copy one file (following symlinks). On APFS `cp -c` makes a copy-on-write clone: instant, no extra space."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".partial")
    if subprocess.run(["cp", "-c", str(src.resolve()), str(tmp)], capture_output=True).returncode != 0:
        shutil.copyfile(src.resolve(), tmp)
    os.replace(tmp, dst)


def _hub_snapshot(cache: Path, repo: str, revision: str) -> Path:
    snap = cache / "hub" / f"models--{repo.replace('/', '--')}" / "snapshots" / revision
    if not snap.is_dir():
        raise FileNotFoundError(f"{repo}@{revision[:10]} is not in {cache}")
    return snap


def migrate(model: Model, root: Path, cache: Path = MIGRATE_CACHE) -> str:
    """Copy a model out of a local Hugging Face cache, dereferencing snapshot symlinks. The cache is untouched."""
    if model.files and not verify(model, root):
        return "already present"
    d = model.directory(root)
    src_type = model.source["type"]
    if src_type == "huggingface":
        snap = _hub_snapshot(cache, model.source["repo"], model.source["revision"])
        wanted = model.source.get("include")
        for p in sorted(snap.rglob("*")):
            rel = p.relative_to(snap)
            if p.is_dir() or (wanted and str(rel) not in wanted):
                continue
            _clone_file(p, d / rel)
    elif src_type == "github-archive":
        src = cache / "torch" / "hub" / "snakers4_silero-vad_master"
        if not src.is_dir():
            raise FileNotFoundError(f"{src} not found")
        for p in _walk(src):
            _clone_file(p, d / model.install_as / p.relative_to(src))
        _write_trusted_list(d)
    elif src_type == "nltk":
        src = Path.home() / "nltk_data"
        for pkg_dir in ("tokenizers/punkt_tab", "taggers/averaged_perceptron_tagger_eng"):
            for p in _walk(src / pkg_dir):
                _clone_file(p, d / pkg_dir / p.relative_to(src / pkg_dir))
    else:
        raise ValueError(f"unknown source type {src_type}")
    return "migrated"


def download(model: Model, root: Path) -> str:
    """Fetch a model at its pinned revision straight into the models root (plain files, no cache symlinks)."""
    if model.files and not verify(model, root):
        return "already present"
    d = model.directory(root)
    d.mkdir(parents=True, exist_ok=True)
    src_type = model.source["type"]
    if src_type == "huggingface":
        from huggingface_hub import snapshot_download

        snapshot_download(model.source["repo"], revision=model.source["revision"], local_dir=d,
                          allow_patterns=model.source.get("include"))
    elif src_type == "github-archive":
        url = f"https://github.com/{model.source['repo']}/archive/{model.source['revision']}.zip"
        with urllib.request.urlopen(url) as r:
            data = r.read()
        target = d / model.install_as
        with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(io.BytesIO(data)) as zf:
            zf.extractall(tmp)
            (inner,) = [p for p in Path(tmp).iterdir() if p.is_dir()]
            if target.exists():
                shutil.rmtree(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(inner, target)
        _write_trusted_list(d)
    elif src_type == "nltk":
        import nltk

        for pkg in model.source["packages"]:
            nltk.download(pkg, download_dir=str(d), quiet=True)
    else:
        raise ValueError(f"unknown source type {src_type}")
    return "downloaded"


def _write_trusted_list(silero_dir: Path) -> None:
    # torch.hub asks before running a repository's hubconf.py unless the repo is in TORCH_HOME/hub/trusted_list
    (silero_dir / "torch-home" / "hub" / "trusted_list").write_text("snakers4_silero-vad\n")
