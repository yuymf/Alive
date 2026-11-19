#!/usr/bin/env python3
"""Integration guard: client -> server, i.e. the payload the worker actually sends.

The unit tests above prove the pieces; this proves the wire. It runs the real
`VoxCPMHttpTTS._post_stream()` against a real FastAPI instance of `server.py` (via
TestClient or a live uvicorn on an ephemeral port), with the model mocked, and asserts:

  * the outgoing JSON body carries `control` when the provider returns one,
  * it carries no `control` key when it returns None (so the old path stays byte-identical),
  * the server sees it and the mock produces different audio per control.

Without this, "client builds the field" and "server honours the field" could both be
true while the field never leaves the process.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

VOICE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(VOICE_DIR / "agent"))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    # Register before exec: `@dataclass` looks the class's module up in sys.modules and
    # raises AttributeError on None if we skip this.
    sys.modules[name] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture()
def live_server(tmp_path, monkeypatch):
    """A real HTTP server on an ephemeral port, mock model, no GPU."""
    monkeypatch.setenv("ALIVE_HOME", str(tmp_path))
    monkeypatch.setenv("VOXCPM_MOCK", "1")
    server = _load("voxcpm_server_integration", VOICE_DIR / "voxcpm" / "server.py")
    server.VOICE_DIR = tmp_path

    import uvicorn

    cfg = uvicorn.Config(server.app, host="127.0.0.1", port=0, log_level="error")
    srv = uvicorn.Server(cfg)
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(200):
        if srv.started:
            break
        time.sleep(0.02)
    if not srv.started:
        pytest.skip("uvicorn 起不来")
    port = srv.servers[0].sockets[0].getsockname()[1]
    yield f"http://127.0.0.1:{port}", server
    srv.should_exit = True
    th.join(timeout=5)


def _capture_payload(monkeypatch, tts_mod, bucket: list):
    """Wrap aiohttp's session.post to record the JSON body without changing behaviour."""
    orig_ensure = tts_mod.VoxCPMHttpTTS._ensure_session

    async def _ensure(self):
        sess = await orig_ensure(self)
        if getattr(sess, "_alive_patched", False):
            return sess
        orig_post = sess.post

        def post(url, **kwargs):
            bucket.append(dict(kwargs.get("json") or {}))
            return orig_post(url, **kwargs)

        sess.post = post  # type: ignore[assignment]
        sess._alive_patched = True
        return sess

    monkeypatch.setattr(tts_mod.VoxCPMHttpTTS, "_ensure_session", _ensure)


import asyncio  # noqa: E402


def test_client_sends_control_and_server_honours_it(live_server, tmp_path, monkeypatch):
    url, _server = live_server
    tts_mod = _load("voxcpm_tts_integration", VOICE_DIR / "agent" / "voxcpm_tts.py")
    bucket: list = []
    _capture_payload(monkeypatch, tts_mod, bucket)

    async def _run(control):
        tts = tts_mod.VoxCPMHttpTTS(url=url, voice="default",
                                    control_provider=lambda: control)
        # ChunkedStream (synthesize) posts once and returns. SynthesizeStream stays open
        # waiting for more input, which would hang a test with no text producer.
        stream = tts.synthesize("测试一句话。")
        got = bytearray()

        class Emitter:
            def initialize(self, **kw):
                pass

            def start_segment(self, **kw):
                pass

            def push(self, chunk):
                got.extend(chunk)

            def flush(self):
                pass

            def end_segment(self):
                pass

        bucket.clear()   # one stream may issue several POSTs (chunking/retry); scope per run
        await stream._run(Emitter())
        await tts.aclose()
        return bytes(got), list(bucket)

    audio_happy, sent_happy = asyncio.run(_run("开心"))
    audio_tired, sent_tired = asyncio.run(_run("疲惫"))
    audio_none, sent_none = asyncio.run(_run(None))

    assert sent_happy, "开心那一轮没有任何 POST"
    assert all(p.get("control") == "开心" for p in sent_happy), sent_happy
    assert all(p.get("control") == "疲惫" for p in sent_tired), sent_tired
    assert all("control" not in p for p in sent_none), f"无情绪时不该带 control: {sent_none}"
    assert audio_happy != audio_tired, "同一句两种情绪，客户端拿到的音频字节相同"
    assert audio_none not in (audio_happy, audio_tired)


def test_client_without_provider_sends_no_control(live_server, monkeypatch):
    """The pre-existing construction path (no provider) must stay byte-identical."""
    url, _server = live_server
    tts_mod = _load("voxcpm_tts_integration2", VOICE_DIR / "agent" / "voxcpm_tts.py")
    bucket: list = []
    _capture_payload(monkeypatch, tts_mod, bucket)

    async def _run():
        tts = tts_mod.VoxCPMHttpTTS(url=url, voice="default")

        class Emitter:
            def initialize(self, **kw): pass
            def start_segment(self, **kw): pass
            def push(self, chunk): pass
            def flush(self): pass
            def end_segment(self): pass

        stream = tts.synthesize("测试一句话。")
        await stream._run(Emitter())
        await tts.aclose()

    asyncio.run(_run())
    assert bucket and "control" not in bucket[0], bucket
