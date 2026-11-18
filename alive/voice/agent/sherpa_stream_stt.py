#!/usr/bin/env python3
"""LiveKit `stt.STT` 节点：把 sherpa-onnx 流式 STT 服务（Docker/CPU）接进 voice pipeline。

为什么有效（改前 2.09s 的瓶颈）：批式 STT 在 VAD 判停之后才把整段音频 POST 给
whisper，尾巴 0.63s；本节点边说边 decode，判停 flush 时终句已在手上（tail≈0）。

协议见 sherpa_stream/server.py。只发 INTERIM/FINAL；PREFLIGHT 由 env 开关控制
（打开后 LiveKit 会在用户说完前抢跑 LLM，需实测 V1/V3 与「不砍回答」后再启用）。
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass

import aiohttp
from livekit import rtc
from livekit.agents import stt
from livekit.agents.language import LanguageCode
from livekit.agents.types import APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN, NotGivenOr
from livekit.agents.utils.audio import AudioBuffer

WS_URL = os.environ.get("SHERPA_WS_URL", "ws://127.0.0.1:8802/v1/stt/stream")
SAMPLE_RATE = 16000
ENABLE_PREFLIGHT = os.environ.get("SHERPA_PREFLIGHT", "0").strip() == "1"


class SherpaStreamSTT(stt.STT):
    """CPU 流式 STT（sherpa-onnx zipformer-zh-int8, 0 显存）。"""

    def __init__(self, *, ws_url: str = WS_URL) -> None:
        super().__init__(capabilities=stt.STTCapabilities(
            streaming=True,
            interim_results=True,
            manual_flush=True,
            offline_recognize=False,
        ))
        self._ws_url = ws_url
        self._session: aiohttp.ClientSession | None = None

    @property
    def model(self) -> str:
        return "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"

    @property
    def provider(self) -> str:
        return "sherpa-onnx (homelab docker, cpu)"

    @property
    def label(self) -> str:
        return "SherpaStreamSTT"

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(limit=8),
                timeout=aiohttp.ClientTimeout(total=60, sock_read=30),
            )
        return self._session

    async def _recognize_impl(
        self, buffer: AudioBuffer, *, language: NotGivenOr[str | list[str]] = NOT_GIVEN,
        conn_options: APIConnectOptions,
    ) -> stt.SpeechEvent:
        """非流式兜底：整段送完 + flush，拿终句。"""
        # 每次新建 session：THREAD executor 下每个 job 可能各有 event loop，
        # 共享 ClientSession 会撞 "attached to a different loop"。
        async with aiohttp.ClientSession() as sess:
            async with sess.ws_connect(self._ws_url, autoping=False, heartbeat=None) as ws:
                for frame in buffer:
                    await ws.send_bytes(bytes(frame.data))
                await ws.send_json({"type": "flush"})
                text = ""
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    data = json.loads(msg.data)
                    if data.get("type") == "final":
                        text = data.get("text", "")
                        break
        return stt.SpeechEvent(
            type=stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives=[stt.SpeechData(language=LanguageCode("zh"), text=text, confidence=0.9)],
        )

    def stream(
        self, *, language: NotGivenOr[str | list[str]] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> stt.RecognizeStream:
        return SherpaRecognizeStream(
            stt=self, conn_options=conn_options, ws_url=self._ws_url,
        )

    async def aclose(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None


class SherpaRecognizeStream(stt.RecognizeStream):
    def __init__(self, *, stt: SherpaStreamSTT, conn_options: APIConnectOptions,
                 ws_url: str) -> None:
        # sample_rate=16000 → LiveKit 自动把 48k 输入重采样，_input_ch 里都是 16k int16
        super().__init__(stt=stt, conn_options=conn_options, sample_rate=SAMPLE_RATE)
        self._sherpa_stt = stt
        self._ws_url = ws_url
        self._last_text = ""
        self._got_first_audio = False

    def _emit(self, typ: stt.SpeechEventType, text: str) -> None:
        if not text:
            return
        self._mark_provider_progress()
        self._event_ch.send_nowait(stt.SpeechEvent(
            type=typ,
            alternatives=[stt.SpeechData(
                language=LanguageCode("zh"), text=text, confidence=0.9,
            )],
        ))

    async def _run(self) -> None:
        # 每个 stream 一个 ClientSession：THREAD executor 下各 job event loop 独立，
        # 复用 session 会撞 "attached to a different loop"。
        async with aiohttp.ClientSession() as sess, \
                sess.ws_connect(self._ws_url, autoping=False, heartbeat=None) as ws:

            async def _forward_input() -> None:
                async for data in self._input_ch:
                    if isinstance(data, self._FlushSentinel):
                        # VAD/EOU 判停：终句已在服务端手上，flush 立即回 final
                        await ws.send_json({"type": "flush"})
                        continue
                    if ws.closed:
                        return
                    await ws.send_bytes(bytes(data.data))
                # 输入结束时不再关闭 ws，交给 _recv 收尾

            async def _recv() -> None:
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        try:
                            data = json.loads(msg.data)
                        except Exception:
                            continue
                        typ = data.get("type")
                        text = data.get("text", "")
                        if typ == "interim" and text != self._last_text:
                            self._last_text = text
                            self._emit(stt.SpeechEventType.INTERIM_TRANSCRIPT, text)
                        elif typ == "preflight" and ENABLE_PREFLIGHT and text:
                            self._emit(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, text)
                        elif typ == "final":
                            self._last_text = ""
                            self._emit(stt.SpeechEventType.FINAL_TRANSCRIPT, text)
                        elif typ == "ready":
                            self._mark_provider_progress()
                    elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSE,
                                      aiohttp.WSMsgType.ERROR):
                        return

            fwd = asyncio.create_task(_forward_input(), name="sherpa_forward")
            rcv = asyncio.create_task(_recv(), name="sherpa_recv")
            try:
                done, pending = await asyncio.wait(
                    {fwd, rcv}, return_when=asyncio.FIRST_COMPLETED)
                # 若接收侧先结束（服务断连），把发送侧也收掉；异常向上抛给 _main_task 重试
                for t in done:
                    if t.exception():
                        raise t.exception()
            finally:
                for t in (fwd, rcv):
                    if not t.done():
                        t.cancel()
                await asyncio.gather(fwd, rcv, return_exceptions=True)
