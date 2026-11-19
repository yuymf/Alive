#!/usr/bin/env python3
"""sherpa-onnx 流式 STT 服务（CPU-only，WebSocket）。

协议（简洁、可行、易验）：
  GET /health                     -> {"ok":true,"model":...}
  WS  /v1/stt/stream
     客户端 -> 服务端：
        binary frame : 16kHz mono int16 PCM（LiveKit 已重采样）
        text   frame : {"type":"flush"}  终句（VAD/EOU 判停）
        text   frame : {"type":"reset"}  丢弃当前 utterance
     服务端 -> 客户端：
        {"type":"ready"}                    新建 utterance 就绪
        {"type":"interim","text":...}       说话中增量转写（每次变化）
        {"type":"preflight","text":...}     稳定前缀（触发 LiveKit 抢跑）
        {"type":"final","text":...}         flush 后终句
        {"type":"pong"}

设计要点：真流式 —— 音频边到边 decode，flush 时终句已在手上（tail≈0）。
CPU-only（provider=cpu），0 显存；模型启动时加载一次，之后每轮零加载。

Step3-P0（t_0b114497）：flush 前补尾部右上下文。流式 zipformer 的最后一个
encoder chunk 需要后续帧做 lookahead 才会 is_ready()，否则「状态」二字永远
停在缓冲里（coverage 确定性 0.885）。见 tail_flush.py。
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import numpy as np
import sherpa_onnx
from aiohttp import web, WSMsgType

from tail_flush import flush_tail_pad

MODEL_DIR = Path(os.environ.get("SHERPA_MODEL_DIR", "/models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"))
NUM_THREADS = int(os.environ.get("SHERPA_NUM_THREADS", "2"))
SAMPLE_RATE = 16000
# 每个 chunk 20ms；preflight 在文本稳定 STABLE_MS 后发出（允许 LLM 抢跑）
STABLE_MS = float(os.environ.get("SHERPA_STABLE_MS", "220"))
# flush 前最多补多少 ms 尾部静音，把最后一个 encoder chunk 的右上下文喂满。
# 边界实测 300→320ms（见 probe_diag2.json），取 400 = 320 + 80ms 余量。
# 与 STABLE_MS / ALIVE_VAD_MIN_SILENCE 互不相干的第三个独立旋钮。
TAIL_PAD_MS = float(os.environ.get("SHERPA_TAIL_PAD_MS", "400"))


def build_recognizer():
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(MODEL_DIR / "tokens.txt"),
        encoder=str(MODEL_DIR / "encoder.int8.onnx"),
        decoder=str(MODEL_DIR / "decoder.onnx"),
        joiner=str(MODEL_DIR / "joiner.int8.onnx"),
        num_threads=NUM_THREADS,
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        enable_endpoint_detection=False,  # 由 LiveKit VAD 判停，避免双判停
        decoding_method="greedy_search",
        provider="cpu",
    )


async def health(request: web.Request) -> web.Response:
    rec = request.app["rec"]
    return web.json_response({
        "ok": True,
        "model": MODEL_DIR.name,
        "provider": "cpu",
        "vram_mb": 0,
        "num_threads": NUM_THREADS,
        "loaded": rec is not None,
        "ts": round(time.time(), 3),
    })


async def stt_stream(request: web.Request) -> web.WebSocketResponse:
    rec: sherpa_onnx.OnlineRecognizer = request.app["rec"]
    ws = web.WebSocketResponse(autoping=False, heartbeat=None, max_msg_size=0)
    await ws.prepare(request)

    stream = rec.create_stream()
    last_text = ""
    last_change_at = time.perf_counter()
    preflight_sent_text = ""
    got_audio = False

    async def send(obj: dict) -> None:
        if not ws.closed:
            await ws.send_str(json.dumps(obj, ensure_ascii=False))

    await send({"type": "ready"})

    def decode_all() -> str:
        while rec.is_ready(stream):
            rec.decode_stream(stream)
        return rec.get_result(stream).strip()

    def emit_interim(text: str) -> None:
        nonlocal last_text, last_change_at
        if text != last_text:
            last_text = text
            last_change_at = time.perf_counter()

    async def stable_watch() -> None:
        """文本稳定 STABLE_MS 后发一次 preflight；让 LLM 在用户说完前起跑。"""
        nonlocal preflight_sent_text
        while not ws.closed:
            await asyncio.sleep(0.03)
            if last_text and last_text != preflight_sent_text and \
                    (time.perf_counter() - last_change_at) * 1000 >= STABLE_MS:
                preflight_sent_text = last_text
                await send({"type": "preflight", "text": last_text})

    watcher = asyncio.create_task(stable_watch())
    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                if not msg.data:
                    continue
                got_audio = True
                pcm = np.frombuffer(msg.data, dtype=np.int16)
                if pcm.size == 0:
                    continue
                stream.accept_waveform(SAMPLE_RATE, pcm.astype(np.float32) / 32768.0)
                emit_interim(decode_all())
                if last_text:
                    await send({"type": "interim", "text": last_text})
            elif msg.type == WSMsgType.TEXT:
                try:
                    cmd = json.loads(msg.data)
                except Exception:
                    continue
                typ = cmd.get("type")
                if typ == "flush":
                    # 补满最后一个 encoder chunk 的右上下文再取终句，否则末二字
                    # 「状态」永远停在缓冲里（coverage 0.885）。只在 flush 分支、
                    # 不动 interim/preflight/判停链路；got_audio 防止空轮误补。
                    if got_audio:
                        flush_tail_pad(rec, stream, TAIL_PAD_MS, sample_rate=SAMPLE_RATE)
                    final_text = decode_all() or last_text
                    await send({"type": "final", "text": final_text})
                    # 下一轮 utterance：新建 stream，清空状态
                    stream = rec.create_stream()
                    last_text, preflight_sent_text, got_audio = "", "", False
                    last_change_at = time.perf_counter()
                    await send({"type": "ready"})
                elif typ == "reset":
                    stream = rec.create_stream()
                    last_text, preflight_sent_text, got_audio = "", "", False
                    last_change_at = time.perf_counter()
                    await send({"type": "ready"})
                elif typ == "ping":
                    await send({"type": "pong"})
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR):
                break
    finally:
        watcher.cancel()
        try:
            await watcher
        except asyncio.CancelledError:
            pass
    return ws


def main() -> None:
    t0 = time.perf_counter()
    rec = build_recognizer()
    print(f"[sherpa-stream] model loaded in {time.perf_counter()-t0:.2f}s "
          f"({MODEL_DIR.name}, cpu, {NUM_THREADS} threads)", flush=True)
    app = web.Application()
    app["rec"] = rec
    app.router.add_get("/health", health)
    app.router.add_get("/v1/stt/stream", stt_stream)
    web.run_app(app, host="0.0.0.0", port=int(os.environ.get("SHERPA_PORT", "8802")),
                print=None)


if __name__ == "__main__":
    main()
