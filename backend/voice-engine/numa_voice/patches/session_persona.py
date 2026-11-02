"""Per-session personas for Realtime clients, with the prompt always composed on the server.

A client chooses the persona by connecting to `/v1/realtime?persona=<id>`. This ASGI middleware composes that
persona's prompt (`numa_voice.personas`: persona prompt plus engine instructions) and hands it to upstream as the
session's `instructions`, exactly as if the server had been launched with that persona. Without `persona` the
session keeps the launch persona. An unknown persona is refused before upstream sees the connection, so no session
slot is claimed.

The persona also fixes the session's voice (`numa_voice.personas`): a built-in preset, or the Conversation default
chosen in Voice Studio. A fixed voice is never replaced: if it cannot be used, the session is refused with an
`error` event saying why, and no other voice is substituted. The server resolves and validates the voice, sets it
as the session's `audio.output.voice` (`numa-voice:<id>` for a saved voice, patches/custom_voice.py), and right
after `session.created` tells the client which voice is in use with a `numa.session` event, including why the
fallback voice is used if the chosen one cannot be.

Every Realtime connection registers with voice_models.begin_session for its lifetime, so Voice Studio cannot
generate during a conversation and a conversation cannot start during generation (it is refused with an `error`
event), and the voice it speaks in cannot be deleted. A saved voice's Base model starts loading at connect.

Clients can never supply prompt text or a voice themselves. For every connection, with or without `persona`:
- `instructions` are removed from `session.update` and `response.create`;
- `audio.output.voice` is removed from both (upstream would also accept any audio file path there);
- `conversation.item.create` with a `system` or `developer` item is dropped (upstream would add it to the prompt).
"""

from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import parse_qs

from speech_to_speech.api.openai_realtime import server

from .. import voice_models
from ..personas import PersonaError, load_persona
from ..voices import CONVERSATION_DEFAULT, FALLBACK_VOICE, Voice, VoiceNotFound, VoiceStore
from . import require

logger = logging.getLogger("numa_voice.session_persona")
REALTIME_PATH = "/v1/realtime"


class HostVoiceUnavailable(Exception):
    """The persona's fixed voice cannot be used; the session must not start in another voice."""

require(server, "create_app")


def resolve_voice(persona_voice: str, store: VoiceStore | None = None) -> tuple[Voice, str, str | None]:
    """The voice a session with this persona speaks in, its session token, and why a fallback was needed.

    Only the Conversation default falls back (to Serena). A persona's fixed voice is used as is, or not at all:
    HostVoiceUnavailable says why it cannot be.
    """
    store = store or VoiceStore()
    reason = None
    if persona_voice == CONVERSATION_DEFAULT:
        voice, reason = store.resolve_default()
        if not voice.builtin and not voice_models.capabilities()["clone"]["available"]:
            voice, reason = store.get(FALLBACK_VOICE), "the Qwen3-TTS Base model is not installed"
    else:
        try:
            voice = store.get(persona_voice)
        except VoiceNotFound:
            raise HostVoiceUnavailable(f"{persona_voice} is not in {store.root}") from None
        if not voice.available:
            raise HostVoiceUnavailable(f"{persona_voice}: {voice.problem}")
        clone = voice_models.capabilities()["clone"]
        if not voice.builtin and not clone["available"]:
            raise HostVoiceUnavailable(f"{persona_voice} needs the Qwen3-TTS Base model ({clone['reason']})")
    token = voice.profile["speaker"] if voice.builtin else f"numa-voice:{voice.id}"
    return voice, token, reason


def _strip_voice(holder: Any) -> None:
    output = (holder.get("audio") or {}).get("output") if isinstance(holder, dict) else None
    if isinstance(output, dict) and "voice" in output:
        output.pop("voice")
        logger.warning("Removed a client-supplied voice")


def _strip(event: dict) -> dict | None:
    """The client event with every way of setting prompt text or the voice removed; None to drop it entirely."""
    kind = event.get("type")
    if kind == "session.update":
        _strip_voice(event.get("session"))
    elif kind == "response.create":
        _strip_voice(event.get("response"))
    if kind == "session.update" and isinstance(event.get("session"), dict) and "instructions" in event["session"]:
        event["session"].pop("instructions")
        logger.warning("Removed client-supplied session instructions")
    elif kind == "response.create" and isinstance(event.get("response"), dict) and "instructions" in event["response"]:
        event["response"].pop("instructions")
        logger.warning("Removed client-supplied response instructions")
    elif kind == "conversation.item.create" and (event.get("item") or {}).get("role") in ("system", "developer"):
        logger.warning("Dropped a client-supplied %s message", event["item"]["role"])
        return None
    return event


class SessionPersona:
    """Pure ASGI middleware for the Realtime WebSocket route; everything else passes through."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "websocket" or scope.get("path") != REALTIME_PATH:
            await self.app(scope, receive, send)
            return
        query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
        persona_id = query.get("persona", [None])[0]
        update = notice = voice = None
        if persona_id is not None:
            try:
                persona = load_persona(persona_id)
                instructions = persona.system_prompt()
                voice, token, fallback = resolve_voice(persona.voice)
            except PersonaError as error:
                logger.warning("Refused Realtime session: %s", error)
                await send({"type": "websocket.close", "code": 1008})  # before accept: a 403 handshake reply
                return
            except HostVoiceUnavailable as error:
                logger.error("Refused %s session: its fixed voice is unavailable: %s", persona_id, error)
                await _refuse_with_error(scope, receive, send, "host_voice_unavailable",
                                         f"The {persona.host} voice for this session is unavailable ({error}). "
                                         "No other voice is used instead.")
                return
            logger.info("Realtime session persona: %s, voice %s%s", persona_id, voice.id,
                        f" (fallback: {fallback})" if fallback else "")
            session = {"type": "realtime", "instructions": instructions, "audio": {"output": {"voice": token}}}
            update = {"type": "websocket.receive", "text": json.dumps({"type": "session.update", "session": session})}
            notice = {"type": "numa.session", "persona": persona_id,
                      "voice": {"id": voice.id, "name": voice.name, "method": voice.method}, "voice_fallback": fallback}

        async def send_with_notice(message: dict) -> None:
            nonlocal notice
            await send(message)
            if notice is not None and message.get("type") == "websocket.send" and \
                    '"session.created"' in (message.get("text") or ""):
                text, notice = json.dumps(notice), None
                await send({"type": "websocket.send", "text": text})

        connected = False

        async def filtered_receive() -> dict:
            nonlocal update, connected
            if update is not None and connected:
                message, update = update, None  # first message after the handshake: the server-composed prompt
                return message
            while True:
                message = await receive()
                if message["type"] == "websocket.connect":
                    connected = True
                    return message
                filtered = _filter(message)
                if filtered is not None:
                    return filtered

        voice_id = voice.id if voice is not None else None
        if not voice_models.begin_session(voice_id):
            logger.warning("Refused Realtime session: Voice Studio is generating a voice")
            await _refuse_with_error(scope, receive, send, "voice_studio_busy",
                                     "Voice Studio is generating a voice. Try again when it has finished.")
            return
        if voice is not None and not voice.builtin:
            voice_models.warm_base_model()
        try:
            await self.app(scope, filtered_receive, send_with_notice)
        finally:
            voice_models.end_session(voice_id)


async def _refuse_with_error(scope: dict, receive: Any, send: Any, kind: str, message: str) -> None:
    """Accept, report the reason as a Realtime `error` event (clients show it), and close; upstream never sees it."""
    if (await receive())["type"] != "websocket.connect":
        return
    protocols = scope.get("subprotocols") or []
    await send({"type": "websocket.accept", "subprotocol": "realtime" if "realtime" in protocols else None})
    await send({"type": "websocket.send", "text": json.dumps({"type": "error", "error": {"type": kind,
                                                                                         "message": message}})})
    await send({"type": "websocket.close", "code": 1011})


def _filter(message: dict) -> dict | None:
    """The message with prompt text removed, or None to drop it."""
    if message.get("type") != "websocket.receive" or message.get("text") is None:
        return message
    try:
        event = json.loads(message["text"])
    except ValueError:
        return message  # upstream reports malformed JSON itself
    if not isinstance(event, dict):
        return message
    kept = _strip(event)
    return None if kept is None else {**message, "text": json.dumps(kept)}


def apply() -> str:
    previous = server.create_app

    def create_app(*args: Any, **kwargs: Any) -> Any:
        app = previous(*args, **kwargs)
        app.add_middleware(SessionPersona)
        return app

    server.create_app = create_app
    return "session persona: Realtime clients may pick ?persona=<id>; prompt text is server-composed"
