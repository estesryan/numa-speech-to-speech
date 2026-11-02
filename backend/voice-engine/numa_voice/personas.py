"""Personas: who the assistant is, kept apart from the engine's operational instructions.

A persona (`personas/<id>.yaml`) describes only the assistant (`host` is its name). The LLM system prompt is always
composed as the persona prompt followed by the engine's instructions (`ENGINE_INSTRUCTIONS`), which the
interruption fix depends on. A persona cannot remove or replace the engine instructions; profiles may not set the
prompt at all, and Realtime clients can only choose a persona (patches/session_persona.py).

A persona also fixes its voice: a built-in preset (`preset-aiden`), or `conversation-default` to speak in the voice
the user chose in Voice Studio. Clients cannot pick a voice. A persona can never use a saved Voice Studio voice (a
synthetic copy of someone's voice).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from .interruption import ENGINE_INSTRUCTIONS
from .paths import PERSONAS_DIR
from .voices import CONVERSATION_DEFAULT, PRESET_ID, is_voice_id

DEFAULT_PERSONA = "numa-assistant"
_FIELDS = {"host", "voice", "prompt"}


class PersonaError(ValueError):
    pass


@dataclass(frozen=True)
class Persona:
    id: str
    host: str
    voice: str
    prompt: str

    def system_prompt(self) -> str:
        return " ".join([self.prompt.strip(), ENGINE_INSTRUCTIONS])


def available_personas(directory: Path = PERSONAS_DIR) -> list[str]:
    return sorted(p.stem for p in directory.glob("*.yaml"))


def load_persona(name: str, directory: Path = PERSONAS_DIR) -> Persona:
    path = directory / f"{name}.yaml"
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name) or not path.exists():
        raise PersonaError(f"unknown persona {name!r}; available: {', '.join(available_personas(directory))}")
    data = yaml.safe_load(path.read_text()) or {}
    if set(data) != _FIELDS:
        raise PersonaError(f"{path.name}: expected the fields {sorted(_FIELDS)}, got {sorted(data)}")
    for key in ("host", "prompt"):
        if not isinstance(data[key], str) or not data[key].strip():
            raise PersonaError(f"{path.name}: {key} must be a non-empty string")
    voice = str(data["voice"])
    if voice != CONVERSATION_DEFAULT and not (PRESET_ID.fullmatch(voice) and is_voice_id(voice)):
        raise PersonaError(f"{path.name}: voice must be a built-in preset (preset-<name>) or {CONVERSATION_DEFAULT}")
    return Persona(id=name, **data)
