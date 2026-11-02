"""numa-voice: set up models, render profiles and launch the local voice engine.

    numa-voice models list
    numa-voice models download --profile fast      # pinned revisions, only this profile's models
    numa-voice models migrate  --profile all       # copy from a local Hugging Face cache (--source; no download)
    numa-voice models verify   --profile fast      # sizes + SHA-256, then upstream config validation
    numa-voice config --profile fast --persona ren-test   # print the rendered upstream configuration
    numa-voice run    --profile fast [--speakers]         # standalone conversation: mic + speakers (upstream client)
    numa-voice serve  --profile fast                      # Realtime server only: ws://127.0.0.1:8765/v1/realtime
    numa-voice talk                                       # upstream client against a running server

Running commands are offline: models load by path from the models root ($NUMA_MODELS_DIR or <project>/models).
The profile picks models; the persona (personas/, default numa-assistant) picks the assistant.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from . import __version__
from .manifest import download, load_manifest, lock, migrate, verify
from .patches import UpstreamIncompatible
from .paths import MIGRATE_CACHE, MANIFEST_PATH, apply_runtime_env, models_root
from .personas import DEFAULT_PERSONA, PersonaError, available_personas
from .profiles import DEFAULT_PROFILE, ProfileError, available_profiles, load_profile, realtime_policy, required_models


def _ids(profile: str) -> list[str]:
    if profile == "all":
        return list(load_manifest())
    return required_models(load_profile(profile))


def cmd_models(args: argparse.Namespace) -> int:
    root = models_root()
    manifest = load_manifest()
    if args.action == "list":
        print(f"models root: {root}")
        for name in available_profiles():
            print(f"profile {name}: {', '.join(required_models(load_profile(name)))}")
        for m in manifest.values():
            present = "ok" if m.files and not verify(m, root, deep=False) else "missing"
            size = sum(f["size"] for f in m.files.values()) / 1e9 if m.files else 0
            print(f"  {m.id:36s} {present:8s} {size:5.2f} GB  {m.license:12s} {m.quantization}")
        return 0
    if args.action == "lock":
        lock(MANIFEST_PATH, args.ids or list(manifest), root)
        print(f"recorded file hashes for {len(args.ids or manifest)} models in {MANIFEST_PATH.name}")
        return 0
    ids = args.ids or _ids(args.profile)
    unknown = [i for i in ids if i not in manifest]
    if unknown:
        print(f"unknown model ids: {unknown}", file=sys.stderr)
        return 2
    failed = 0
    for mid in ids:
        m = manifest[mid]
        if args.action == "verify":
            problems = verify(m, root, deep=not args.quick)
            print(f"{'ok  ' if not problems else 'FAIL'} {mid}" + "".join(f"\n       {p}" for p in problems))
            failed += bool(problems)
        else:
            try:
                state = migrate(m, root, Path(args.source)) if args.action == "migrate" else download(m, root)
                problems = verify(m, root) if m.files else []
                print(f"{state:16s} {mid}" + (f"  VERIFY FAILED: {problems}" if problems else ""))
                failed += bool(problems)
            except Exception as error:  # report every model, then fail
                print(f"FAILED           {mid}: {error}")
                failed += 1
    if args.action == "verify" and not failed and args.profile != "all" and not args.ids:
        apply_runtime_env(root)
        from .profiles import write_resolved

        try:
            for persona in available_personas():
                for speakers in (False, True):
                    write_resolved(args.profile, persona=persona, speakers=speakers, root=root)
            print(f"ok   profile {args.profile}: renders with every persona and passes upstream validation")
        except Exception as error:
            print(f"FAIL profile {args.profile}: {error}")
            failed += 1
    return 1 if failed else 0


def cmd_config(args: argparse.Namespace) -> int:
    apply_runtime_env()
    from .profiles import write_resolved

    path = write_resolved(args.profile, persona=args.persona, speakers=args.speakers)
    print(path.read_text())
    print(f"# written to {path}", file=sys.stderr)
    return 0


def _launch(command: str, args: argparse.Namespace) -> int:
    root = models_root()
    if command != "talk":
        missing = [mid for mid in required_models(load_profile(args.profile))
                   if verify(load_manifest()[mid], root, deep=False)]
        if missing:
            print(f"models missing or incomplete under {root}: {missing}\n"
                  f"run: numa-voice models download --profile {args.profile}", file=sys.stderr)
            return 1
    apply_runtime_env(root)  # before importing upstream: huggingface_hub reads HF_HUB_OFFLINE at import time
    from .patches import apply_client_patches, apply_server_patches

    applied = apply_server_patches(realtime_policy(args.profile)) if command in ("local", "serve") else []
    if command in ("local", "talk"):
        applied += apply_client_patches()
    for line in applied:
        print(f"[numa-voice] {line}", file=sys.stderr)
    if command == "talk":
        sys.argv = ["speech-to-speech", "talk", "--url", args.url]
    else:
        from .profiles import write_resolved

        config = write_resolved(args.profile, persona=args.persona, speakers=getattr(args, "speakers", False),
                                root=root)
        print(f"[numa-voice] profile {args.profile}, persona {args.persona}, models from {root}, offline",
              file=sys.stderr)
        sys.argv = ["speech-to-speech", command, "-f", str(config), "--name", "numa"]
    from speech_to_speech.cli import main as upstream_main

    upstream_main()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="numa-voice", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", action="version", version=f"numa-voice {__version__}")
    sub = parser.add_subparsers(dest="cmd", required=True)
    profile_help = f"one of: {', '.join(available_profiles())} (default {DEFAULT_PROFILE})"
    persona_default = os.environ.get("NUMA_VOICE_PERSONA", DEFAULT_PERSONA)
    persona_help = f"persona, one of: {', '.join(available_personas())} (default {persona_default})"

    m = sub.add_parser("models", help="list, download, migrate, verify or lock model files")
    m.add_argument("action", choices=["list", "download", "migrate", "verify", "lock"])
    m.add_argument("--profile", default=DEFAULT_PROFILE, help=profile_help + ", or all")
    m.add_argument("--source", default=str(MIGRATE_CACHE), help="cache to migrate from")
    m.add_argument("--quick", action="store_true", help="verify presence and sizes only, skip SHA-256")
    m.add_argument("--ids", nargs="*", help="only these manifest ids (instead of --profile)")
    m.set_defaults(func=cmd_models)

    c = sub.add_parser("config", help="render and print a profile's upstream configuration")
    c.add_argument("--profile", default=DEFAULT_PROFILE, help=profile_help)
    c.add_argument("--persona", default=persona_default, help=persona_help)
    c.add_argument("--speakers", action="store_true")
    c.set_defaults(func=cmd_config)

    for name, command, text in (("run", "local", "standalone conversation with mic and speakers"),
                                ("serve", "serve", "Realtime server only")):
        p = sub.add_parser(name, help=text)
        p.add_argument("--profile", default=os.environ.get("NUMA_VOICE_PROFILE", DEFAULT_PROFILE), help=profile_help)
        p.add_argument("--persona", default=persona_default, help=persona_help)
        if name == "run":
            p.add_argument("--speakers", action="store_true",
                           help="laptop speakers: mute the mic while the assistant talks (disables barge-in)")
        p.set_defaults(func=lambda a, c=command: _launch(c, a))

    t = sub.add_parser("talk", help="upstream audio client (with Numa's interruption fix) for a running server")
    t.add_argument("--url", default="ws://127.0.0.1:8765/v1/realtime")
    t.set_defaults(func=lambda a: _launch("talk", a))

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (ProfileError, PersonaError, UpstreamIncompatible) as error:
        print(f"numa-voice: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
