"""Voice Studio HTTP API, served by the voice engine next to the Realtime WebSocket (patches/voice_studio.py).

    GET    /v1/numa/voices                      voices, Conversation default, capabilities, whether a session is live
    POST   /v1/numa/voices/preview              {voice_id | candidate, text} -> audio/wav (real synthesis)
    POST   /v1/numa/voices?name=&method=&consent=true   body: WAV reference (recorded | uploaded)
    POST   /v1/numa/voices/design/candidates    {description, count} -> candidate voices (base64 WAV)
    POST   /v1/numa/voices/design               {token, index, name} -> saves a candidate
    PATCH  /v1/numa/voices/{id}                 {name}
    DELETE /v1/numa/voices/{id}
    PUT    /v1/numa/voices/default              {voice_id}

Generation (preview, transcription, design) is refused with 409 while a conversation is live, and a conversation
is refused while generation runs (voice_models.generation): they would compete for the GPU. Only the browser origins
allowed for the Realtime endpoint can call it, and reference recordings are never served back. Unexpected failures
are logged in full; the browser gets a generic message.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import secrets
import shutil
import time
from collections.abc import Callable
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import voice_models
from .voices import (CLONE_MODEL, DESIGN_MODEL, MAX_UPLOAD_BYTES, SAMPLE_RATE, Voice, VoiceError, VoiceNotFound,
                     VoiceStore, prepare_reference, valid_name, wav_bytes)

logger = logging.getLogger("numa_voice.voice_api")
TOO_LARGE = "The recording is larger than 15 MB. Use a shorter clip (up to 30 seconds)."
DEFAULT_PREVIEW = "Hi, it's lovely to hear from you. Take your time; I'm happy to talk things through."
CANDIDATE_TOKEN = re.compile(r"[0-9a-f]{16}")
CANDIDATE_TTL_S = 3600


class PreviewRequest(BaseModel):
    voice_id: str | None = None
    candidate: dict[str, Any] | None = None
    text: str = Field(default=DEFAULT_PREVIEW, max_length=300)


class DesignRequest(BaseModel):
    description: str = Field(min_length=10, max_length=300)
    count: int = Field(default=3, ge=1, le=3)


class SaveDesignRequest(BaseModel):
    token: str
    index: int = Field(ge=0, le=2)
    name: str


class RenameRequest(BaseModel):
    name: str


class DefaultRequest(BaseModel):
    voice_id: str


def router(busy: Callable[[], bool], store_factory: Callable[[], VoiceStore] = VoiceStore,
           models: Any = voice_models) -> APIRouter:
    """`busy` reports whether a conversation session is live; `models` is replaceable in tests."""
    api = APIRouter(prefix="/v1/numa/voices")

    def store() -> VoiceStore:
        return store_factory()

    def idle() -> None:
        if busy():
            raise HTTPException(409, "End the conversation first: voices are generated with the same model.")

    def fail(error: Exception) -> HTTPException:
        if isinstance(error, VoiceNotFound):
            return HTTPException(404, str(error))
        if isinstance(error, voice_models.ModelUnavailable):
            return HTTPException(503, str(error))
        if isinstance(error, voice_models.EngineBusy):
            return HTTPException(409, str(error))
        if isinstance(error, VoiceError):
            return HTTPException(400, str(error))
        logger.error("Voice Studio request failed", exc_info=error)
        return HTTPException(500, "Voice generation failed. The voice engine's log has the details.")

    async def read_upload(request: Request) -> bytes:
        """The request body, refused as soon as it exceeds the upload limit (never buffered beyond it)."""
        length = request.headers.get("content-length", "")
        if length.isdigit() and int(length) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, TOO_LARGE)
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                raise HTTPException(413, TOO_LARGE)
            chunks.append(chunk)
        return b"".join(chunks)

    def summary(s: VoiceStore) -> dict[str, Any]:
        voice, fallback_reason = s.resolve_default()
        return {
            "voices": [v.public() for v in s.list()],
            "default": voice.id,
            "default_problem": fallback_reason,
            "capabilities": models.capabilities(),
            "busy": busy(),
        }

    def candidate_dir(s: VoiceStore, token: str):
        if not CANDIDATE_TOKEN.fullmatch(token):
            raise VoiceNotFound("These candidates have expired; generate them again.")
        directory = s.root / ".candidates" / token
        if not (directory / "meta.json").is_file():
            raise VoiceNotFound("These candidates have expired; generate them again.")
        return directory, json.loads((directory / "meta.json").read_text())

    def candidate_voice(s: VoiceStore, token: str, index: int) -> tuple[Voice, np.ndarray, dict[str, Any]]:
        import soundfile as sf

        directory, meta = candidate_dir(s, token)
        if not 0 <= index < meta["count"]:
            raise VoiceNotFound("No such candidate.")
        audio, _ = sf.read(directory / f"{index}.wav", dtype="float32")
        return Voice(id="candidate", name="Candidate", method="designed", builtin=False), audio, meta

    @api.get("")
    def list_voices() -> dict[str, Any]:
        s = store()
        s.cleanup()
        return summary(s)

    @api.post("/preview")
    def preview(body: PreviewRequest) -> Response:
        idle()
        s = store()
        text = " ".join(body.text.split()) or DEFAULT_PREVIEW
        try:
            with voice_models.generation():
                if body.candidate is not None:
                    _, reference, meta = candidate_voice(s, str(body.candidate.get("token", "")),
                                                         int(body.candidate.get("index", -1)))
                    audio = models.synthesize_reference(reference, meta["text"], text)
                else:
                    audio = models.synthesize(s, s.get(body.voice_id or s.default_id()), text)
        except Exception as error:
            raise fail(error) from error
        return Response(wav_bytes(audio), media_type="audio/wav", headers={"Cache-Control": "no-store"})

    @api.post("", status_code=201)
    async def create(request: Request, name: str, method: str, consent: bool = False) -> dict[str, Any]:
        if method not in ("recorded", "uploaded"):
            raise HTTPException(400, "Use the design endpoints for designed voices.")
        if consent is not True:
            raise HTTPException(400, "Confirm that you own this voice or have its owner's permission.")
        try:
            valid_name(name)
        except VoiceError as error:
            raise fail(error) from error
        data = await read_upload(request)
        idle()

        def work() -> dict[str, Any]:
            s = store()
            if not models.capabilities()["clone"]["available"]:
                raise voice_models.ModelUnavailable(models.capabilities()["clone"]["reason"])
            audio, _ = prepare_reference(data)
            with voice_models.generation():
                text = models.transcribe(audio)
            voice = s.create(name=name, method=method, audio=audio, reference_text=text,
                             revision=voice_models.revision(CLONE_MODEL), consent=consent)
            return {"voice": voice.public(), **summary(s)}

        from starlette.concurrency import run_in_threadpool

        try:
            return await run_in_threadpool(work)
        except Exception as error:
            raise fail(error) from error

    @api.post("/design/candidates")
    def design_candidates(body: DesignRequest) -> dict[str, Any]:
        idle()
        s = store()
        try:
            with voice_models.generation():
                clips, text = models.design_candidates(" ".join(body.description.split()), body.count)
        except Exception as error:
            raise fail(error) from error
        root = s.root / ".candidates"
        root.mkdir(parents=True, exist_ok=True)
        for old in root.iterdir():  # candidates are temporary
            if old.is_dir() and time.time() - old.stat().st_mtime > CANDIDATE_TTL_S:
                shutil.rmtree(old, ignore_errors=True)
        token = secrets.token_hex(8)
        directory = root / token
        directory.mkdir()
        for i, clip in enumerate(clips):
            (directory / f"{i}.wav").write_bytes(wav_bytes(clip))
        (directory / "meta.json").write_text(json.dumps(
            {"description": " ".join(body.description.split()), "text": text, "count": len(clips),
             "created": time.time()}))
        return {"token": token, "text": text, "candidates": [
            {"index": i, "audio": base64.b64encode(wav_bytes(c)).decode(), "duration_s": round(len(c) / SAMPLE_RATE, 2)}
            for i, c in enumerate(clips)]}

    @api.post("/design", status_code=201)
    def save_design(body: SaveDesignRequest) -> dict[str, Any]:
        s = store()
        try:
            _, audio, meta = candidate_voice(s, body.token, body.index)
            voice = s.create(name=body.name, method="designed", audio=audio, reference_text=meta["text"],
                             revision=voice_models.revision(CLONE_MODEL),
                             design={"description": meta["description"], "model": DESIGN_MODEL,
                                     "revision": voice_models.revision(DESIGN_MODEL)})
        except Exception as error:
            raise fail(error) from error
        shutil.rmtree(s.root / ".candidates" / body.token, ignore_errors=True)
        return {"voice": voice.public(), **summary(s)}

    @api.put("/default")
    def set_default(body: DefaultRequest) -> dict[str, Any]:
        s = store()
        try:
            s.set_default(body.voice_id)
        except Exception as error:
            raise fail(error) from error
        return summary(s)

    @api.patch("/{voice_id}")
    def rename(voice_id: str, body: RenameRequest) -> dict[str, Any]:
        s = store()
        try:
            s.rename(voice_id, body.name)
        except Exception as error:
            raise fail(error) from error
        return summary(s)

    @api.delete("/{voice_id}")
    def delete(voice_id: str) -> dict[str, Any]:
        if voice_models.voice_in_use(voice_id):
            raise HTTPException(409, "The running conversation speaks in this voice. End the conversation first.")
        s = store()
        try:
            s.delete(voice_id)
        except Exception as error:
            raise fail(error) from error
        return summary(s)

    return api
