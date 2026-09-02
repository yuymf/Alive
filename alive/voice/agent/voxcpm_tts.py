"""VoxCPM HTTP TTS for LiveKit Agents.

Talks to the OpenAI-compatible server at VOXCPM_URL
(POST /v1/audio/speech and /v1/audio/speech/stream).
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

import aiohttp
from livekit.agents import APIConnectOptions, APIStatusError, DEFAULT_API_CONNECT_OPTIONS
from livekit.agents.tts import ChunkedStream, TTS, TTSCapabilities

TARGET_SAMPLE_RATE = 24000


@dataclass
class VoxCPMOptions:
    url: str
    voice: str
    sample_rate: int


class VoxCPMHttpTTS(TTS):
    def __init__(
        self,
        *,
        url: str | None = None,
        voice: str | None = None,
        sample_rate: int = TARGET_SAMPLE_RATE,
    ) -> None:
        super().__init__(
            capabilities=TTSCapabilities(streaming=False),
            sample_rate=sample_rate,
            num_channels=1,
        )
        self._opts = VoxCPMOptions(
            url=(url or os.getenv("VOXCPM_URL", "http://127.0.0.1:8000")).rstrip("/"),
            voice=(voice or os.getenv("VOXCPM_VOICE", "default")).strip() or "default",
            sample_rate=sample_rate,
        )
        self._http_session: aiohttp.ClientSession | None = None

    @property
    def provider(self) -> str:
        return "voxcpm"

    @property
    def model(self) -> str:
        return "VoxCPM2"

    def synthesize(self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) -> ChunkedStream:
        return _VoxCPMChunkedStream(tts=self, input_text=text, conn_options=conn_options)

    async def aclose(self) -> None:
        if self._http_session and not self._http_session.closed:
            await self._http_session.close()
        self._http_session = None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._http_session is None or self._http_session.closed:
            self._http_session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(force_close=True),
                timeout=aiohttp.ClientTimeout(total=120, sock_read=60),
            )
        return self._http_session


class _VoxCPMChunkedStream(ChunkedStream):
    def __init__(self, *, tts: VoxCPMHttpTTS, input_text: str, conn_options: APIConnectOptions) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._vox = tts

    async def _run(self, output_emitter) -> None:
        request_id = str(uuid.uuid4())
        text = (self._input_text or "").strip()
        if not text:
            output_emitter.initialize(
                request_id=request_id,
                sample_rate=self._vox.sample_rate,
                num_channels=1,
                mime_type="audio/pcm",
            )
            return

        sess = await self._vox._ensure_session()
        payload = {"input": text, "voice": self._vox._opts.voice, "response_format": "pcm"}
        async with sess.post(f"{self._vox._opts.url}/v1/audio/speech", json=payload) as resp:
            if resp.status >= 400:
                body = await resp.text()
                raise APIStatusError(
                    f"VoxCPM {resp.status}: {body[:200]}",
                    status_code=resp.status,
                    request_id=request_id,
                    body=body,
                )
            output_emitter.initialize(
                request_id=request_id,
                sample_rate=self._vox.sample_rate,
                num_channels=1,
                mime_type="audio/pcm",
            )
            async for chunk in resp.content.iter_chunked(4096):
                if not chunk:
                    continue
                if len(chunk) % 2:
                    chunk = chunk[:-1]
                if chunk:
                    output_emitter.push(chunk)
