"""Origin allowlist for the local Realtime server (WebSocket and HTTP routes).

Upstream accepts every connection. A browser lets any web page open a WebSocket to 127.0.0.1, so without this
check any site the user visits could start a conversation session. Browsers always send an `Origin` header on
WebSocket handshakes and cross-origin requests, and pages cannot forge it, so:

- Origin in the allowlist: allowed.
- Any other Origin (including "null"): rejected before the request reaches upstream, so no session slot is claimed
  (WebSocket: HTTP 403 handshake rejection; HTTP: 403).
- No Origin header: a non-browser local client (`numa-voice talk`, benchmarks, tests); allowed when
  `allow_missing_origin` is true (the default). The server only listens on 127.0.0.1.

Browsers omit Origin on same-origin GET requests, so a DNS-rebinding page (attacker.example resolved to
127.0.0.1) could otherwise read GET routes. Its requests carry its own Host header, so every request whose Host is
not a loopback name (localhost, 127.0.0.1, [::1]) is rejected the same way.

This is a local-development safeguard, not authentication: a cloud deployment needs real auth in front of it.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterable
from typing import Any

from speech_to_speech.api.openai_realtime import server

from . import require, require_source

logger = logging.getLogger("numa_voice.origin")
DEFAULT_ALLOWED_ORIGINS = ("http://localhost:3000", "http://127.0.0.1:3000")
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
ENV_ALLOWED_ORIGINS = "NUMA_VOICE_ALLOWED_ORIGINS"

require(server, "create_app", "RealtimeServer")
require_source(server.RealtimeServer.run, "create_app(")  # run() looks create_app up in the module: patchable


def _normalize(origin: str) -> str:
    return origin.strip().rstrip("/").lower()


def _loopback_host(host: str | None) -> bool:
    """Whether a Host header names this machine; a missing Host (HTTP/1.0 clients) is allowed."""
    if host is None:
        return True
    host = host.strip().lower()
    name = host[1:].split("]", 1)[0] if host.startswith("[") else host.rsplit(":", 1)[0] if ":" in host else host
    return name in LOOPBACK_HOSTS


class OriginAllowlist:
    """Pure ASGI middleware; lifespan and anything that is not HTTP or WebSocket passes through."""

    def __init__(self, app: Any, allowed_origins: Iterable[str], allow_missing_origin: bool) -> None:
        self.app = app
        self.allowed = {_normalize(o) for o in allowed_origins}
        self.allow_missing = allow_missing_origin

    def permits(self, origin: str | None) -> bool:
        if origin is None:
            return self.allow_missing
        return _normalize(origin) in self.allowed

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] in ("http", "websocket"):
            headers = dict(scope.get("headers") or [])
            raw, raw_host = headers.get(b"origin"), headers.get(b"host")
            origin = raw.decode("latin-1") if raw is not None else None
            host = raw_host.decode("latin-1") if raw_host is not None else None
            if not self.permits(origin) or not _loopback_host(host):
                logger.warning("Rejected %s %s from origin %r, host %r", scope["type"], scope.get("path"), origin,
                               host)
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})  # before accept: a 403 handshake reply
                else:
                    await send({"type": "http.response.start", "status": 403,
                                "headers": [(b"content-type", b"text/plain")]})
                    await send({"type": "http.response.body", "body": b"origin not allowed"})
                return
        await self.app(scope, receive, send)


def resolve_origins(configured: Iterable[str] | None = None) -> list[str]:
    env = os.environ.get(ENV_ALLOWED_ORIGINS)
    if env is not None:
        return [o for o in env.split(",") if o.strip()]
    return list(configured if configured is not None else DEFAULT_ALLOWED_ORIGINS)


def apply(allowed_origins: Iterable[str] | None = None, allow_missing_origin: bool = True) -> str:
    origins = resolve_origins(allowed_origins)
    previous = server.create_app  # may already be wrapped by another patch; keep it

    def create_app(*args: Any, **kwargs: Any) -> Any:
        app = previous(*args, **kwargs)
        app.add_middleware(OriginAllowlist, allowed_origins=origins, allow_missing_origin=allow_missing_origin)
        return app

    server.create_app = create_app
    missing = "allowed" if allow_missing_origin else "rejected"
    return f"origin: Realtime server accepts origins {origins}; requests without Origin {missing}"
