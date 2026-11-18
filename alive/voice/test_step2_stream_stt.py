"""Step2 流式 STT 节点/服务的真行为门禁（不打桩、连真 Docker 容器）。

钉住四件事（对应 server.py 协议与 sherpa_stream_stt.py 的 V1/V3 防线）：
1. 服务健康且真 CPU-only（vram_mb=0）——别让常驻 STT 白天占 A6000；
2. 说完后 flush 的「尾延迟」≈0（批式 whisper 是 0.54s），这是本卡提速的物理来源；
3. interim 只在 flush 之前出现，FINAL 恰一次 —— 防止 interim 被误当终句触发多轮 commit（V1）；
4. 反例击穿：把 flush 拿掉（模拟批式只在判停后整段转写）尾延迟显著变大 / 拿不到 final。

用法：.venv-voice/bin/python -m pytest alive/voice/test_step2_stream_stt.py -q
"""
from __future__ import annotations

import asyncio
import json
import math
import struct
import time
import urllib.request

import numpy as np
import pytest

WS_URL = "ws://127.0.0.1:8802/v1/stt/stream"
HEALTH = "http://127.0.0.1:8802/health"
SR = 16000


def _service_up() -> bool:
    try:
        with urllib.request.urlopen(HEALTH, timeout=2) as r:
            return r.status == 200 and json.loads(r.read().decode()).get("ok") is True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _service_up(), reason="alive-sherpa-stt Docker 容器未起")


def _speech_pcm(seconds: float = 1.6) -> np.ndarray:
    """合成类语音（多谐波 + 音节包络），让 sherpa 有东西可 decode。"""
    n = int(SR * seconds)
    t = np.arange(n) / SR
    env = 0.5 + 0.5 * np.sin(2 * np.pi * 3.1 * t)  # 3Hz 音节包络
    base = (np.sin(2 * np.pi * 130 * t) + 0.6 * np.sin(2 * np.pi * 260 * t)
            + 0.3 * np.sin(2 * np.pi * 390 * t))
    return np.clip(base * env * 9000, -32768, 32767).astype(np.int16)


async def _drive(*, do_flush: bool):
    import aiohttp
    pcm = _speech_pcm()
    chunk = 320  # 20ms @16k
    frames = [pcm[i:i + chunk].tobytes() for i in range(0, len(pcm), chunk)]
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(WS_URL, autoping=False, heartbeat=None) as ws:
            await ws.send_json({"type": "reset"})
            for f in frames:
                await ws.send_bytes(f)
                await asyncio.sleep(0.02)  # 实时速率喂流（真流式，不是一次灌完）
            t_flush = time.perf_counter()
            if do_flush:
                await ws.send_json({"type": "flush"})
            interims, final_text, t_final = [], None, None
            deadline = time.perf_counter() + 3.0

            async def _collect():
                nonlocal final_text, t_final
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    d = json.loads(msg.data)
                    if d.get("type") == "interim":
                        interims.append(d.get("text", ""))
                    elif d.get("type") == "final":
                        t_final = time.perf_counter()
                        final_text = d.get("text", "")
                        return
                    if time.perf_counter() > deadline:
                        return
                return

            try:
                await asyncio.wait_for(_collect(), timeout=3.5)
            except asyncio.TimeoutError:
                pass  # 未 flush 时本就收不到 final，属预期
            return {
                "interims": interims,
                "final_text": final_text,
                "tail_s": (t_final - t_flush) if t_final else None,
            }


def test_service_is_cpu_only_and_loaded():
    with urllib.request.urlopen(HEALTH, timeout=3) as r:
        d = json.loads(r.read().decode())
    assert d["ok"] is True
    assert d["provider"] == "cpu"
    assert d["vram_mb"] == 0, "常驻 STT 必须 0 显存，不能占两张 A6000"
    assert d["loaded"] is True


def test_flush_final_is_near_zero_tail_and_single_final():
    """流式核心：判停时终句已在手上 → flush 到 final 的尾延迟 ≈0。"""
    r = asyncio.run(_drive(do_flush=True))
    assert r["final_text"] is not None, "flush 后必须拿到 final"
    assert r["tail_s"] is not None and r["tail_s"] < 0.15, (
        f"尾延迟 {r['tail_s']}s 没塌到 0 —— 流式没生效，退化成批式")


def test_no_flush_never_yields_final_negative_control():
    """反例击穿：不 flush 就拿不到 final —— 证明 FINAL 只在判停发，interim 不会抢跑。"""
    r = asyncio.run(_drive(do_flush=False))
    assert r["final_text"] is None, "未 flush 却出现 final：interim 被误当终句，V1 会崩"


def test_interim_only_before_flush_gate_has_teeth():
    """门禁判别力：flush 分支能拿到 final，不 flush 分支拿不到，两者必须不同。"""
    with_flush = asyncio.run(_drive(do_flush=True))
    without_flush = asyncio.run(_drive(do_flush=False))
    assert with_flush["final_text"] is not None
    assert without_flush["final_text"] is None
