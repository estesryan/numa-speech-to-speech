"""Realtime server Origin allowlist (ASGI middleware, exercised through Starlette's test client)."""

import threading

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from numa_voice.patches import origin

LOCAL = "http://localhost:3000"


def client(allow_missing=True, origins=origin.DEFAULT_ALLOWED_ORIGINS):
    app = FastAPI()
    opened = []

    @app.websocket("/v1/realtime")
    async def realtime(ws: WebSocket):
        opened.append(ws.headers.get("origin"))  # stands in for claiming a session slot
        await ws.accept()
        await ws.send_json({"type": "session.created"})
        await ws.close()

    @app.get("/v1/pool")
    async def pool():
        return {"free": 1}

    app.add_middleware(origin.OriginAllowlist, allowed_origins=origins, allow_missing_origin=allow_missing)
    return TestClient(app, base_url="http://127.0.0.1:8765"), opened


def connect(c, headers):
    with c.websocket_connect("ws://127.0.0.1:8765/v1/realtime", headers=headers) as ws:
        return ws.receive_json()["type"]


@pytest.mark.parametrize("value", [LOCAL, "http://127.0.0.1:3000", "HTTP://LOCALHOST:3000/"])
def test_the_local_frontend_is_allowed(value):
    c, opened = client()
    assert connect(c, {"origin": value}) == "session.created"
    assert opened == [value]


@pytest.mark.parametrize("value", ["https://evil.example", "http://localhost:3001", "null", "http://localhost"])
def test_other_browser_origins_are_rejected_before_a_session_starts(value):
    c, opened = client()
    with pytest.raises(WebSocketDisconnect) as rejected:
        connect(c, {"origin": value})
    assert rejected.value.code == 1008
    assert opened == []  # upstream's route never ran, so no session slot was claimed


def test_clients_without_an_origin_are_allowed_by_default():
    c, _ = client()
    assert connect(c, {}) == "session.created"


def test_clients_without_an_origin_can_be_rejected():
    c, opened = client(allow_missing=False)
    with pytest.raises(WebSocketDisconnect):
        connect(c, {})
    assert opened == []


def test_http_routes_check_the_origin_too():
    c, _ = client()
    assert c.get("/v1/pool", headers={"origin": LOCAL}).status_code == 200
    assert c.get("/v1/pool").status_code == 200
    assert c.get("/v1/pool", headers={"origin": "https://evil.example"}).status_code == 403


def test_environment_overrides_the_configured_origins(monkeypatch):
    assert origin.resolve_origins(["http://localhost:5173"]) == ["http://localhost:5173"]
    monkeypatch.setenv(origin.ENV_ALLOWED_ORIGINS, "http://localhost:4000, http://studio.local:4000")
    c, _ = client(origins=origin.resolve_origins([LOCAL]))
    assert connect(c, {"origin": "http://studio.local:4000"}) == "session.created"
    with pytest.raises(WebSocketDisconnect):
        connect(c, {"origin": LOCAL})


def test_apply_wraps_upstreams_app(monkeypatch):
    from speech_to_speech.api.openai_realtime import server

    monkeypatch.setattr(server, "create_app", server.create_app)  # restored after the test
    origin.apply(allowed_origins=[LOCAL], allow_missing_origin=False)
    app = server.create_app(pool=[object()], stop_event=threading.Event())
    (entry,) = [m for m in app.user_middleware if m.cls is origin.OriginAllowlist]
    assert entry.kwargs == {"allowed_origins": [LOCAL], "allow_missing_origin": False}


@pytest.mark.parametrize("host", ["attacker.example:8765", "127.0.0.1.attacker.example", "192.168.1.20:8765"])
def test_non_loopback_hosts_are_rejected_even_without_an_origin(host):
    """DNS rebinding: a page whose name now resolves to 127.0.0.1 sends no Origin on same-origin GETs."""
    c, opened = client()
    assert c.get("/v1/pool", headers={"host": host}).status_code == 403
    with pytest.raises(WebSocketDisconnect):
        connect(c, {"host": host})
    assert opened == []


@pytest.mark.parametrize("host", ["127.0.0.1:8765", "localhost:8765", "[::1]:8765"])
def test_loopback_hosts_are_allowed(host):
    c, _ = client()
    assert c.get("/v1/pool", headers={"host": host}).status_code == 200
