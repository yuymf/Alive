#!/usr/bin/env python3
"""实测触发音频内部静音谷分布：决定 harness 预检阈值与 RENDER_TRIES 是否够用。

agent.py 的 EnergyVAD 已改 min_silence=0.35，而 latency_e2e.py 的预检常量
仍写 0.5（源码注释自称「与 agent.py 保持一致」）→ 0.35~0.5s 的逗号停顿
会穿过预检、被 agent 切成两轮（V1 作废）。本脚本量化该区间出现频率。
"""
import asyncio
import importlib.util
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("lat_harness", ROOT / "alive/voice/latency_e2e.py")
h = importlib.util.module_from_spec(spec)
sys.modules["lat_harness"] = h
spec.loader.exec_module(h)

N = int(sys.argv[1]) if len(sys.argv) > 1 else 16
URL = "http://127.0.0.1:8801"


def gaps_at(pcm, min_sil):
    """与 harness vad_split_gaps 同口径，只是阈值参数化。"""
    sr = 24000
    n = sr * 20 // 1000
    frames = pcm[: len(pcm) // n * n].reshape(-1, n).astype("float64")
    rms = (frames ** 2).mean(axis=1) ** 0.5
    below = rms < 200
    gaps, start = [], None
    for i, b in enumerate(below):
        if b and start is None:
            start = i
        elif not b and start is not None:
            if (i - start) * 0.02 >= min_sil:
                gaps.append((start * 0.02, i * 0.02))
            start = None
    if start is not None and (len(below) - start) * 0.02 >= min_sil:
        gaps.append((start * 0.02, len(below) * 0.02))
    return gaps


def max_gap(pcm):
    sr = 24000
    n = sr * 20 // 1000
    frames = pcm[: len(pcm) // n * n].reshape(-1, n).astype("float64")
    rms = (frames ** 2).mean(axis=1) ** 0.5
    below = rms < 200
    best, cur = 0.0, 0.0
    for b in below:
        cur = cur + 0.02 if b else 0.0
        best = max(best, cur)
    return best


async def main():
    out = []
    for i in range(N):
        try:
            pcm = await h.synth(URL, h.TRIGGER_TEXT)
            out.append((len(pcm) / 24000, max_gap(pcm)))
            print(f"render {i+1:2d}: dur={len(pcm)/24000:.2f}s max_internal_gap={max_gap(pcm):.3f}s "
                  f"clean@0.5={not gaps_at(pcm,0.5)} clean@0.35={not gaps_at(pcm,0.35)}", flush=True)
        except Exception as exc:
            print(f"render {i+1:2d}: FAILED {exc!r}", flush=True)
    gs = [g for _, g in out]
    print(f"\nN={len(out)}  max_gap: min={min(gs):.3f} median={statistics.median(gs):.3f} max={max(gs):.3f}")
    for thr in (0.5, 0.4, 0.35, 0.30):
        c = sum(1 for g in gs if g < thr)
        print(f"clean@<{thr:.2f}s: {c}/{len(gs)} = {c/len(gs):.0%}")
    # 8 次重渲染至少拿到一个 clean 的概率（独立近似）
    import math
    for thr in (0.5, 0.35, 0.30):
        p = sum(1 for g in gs if g < thr) / len(gs)
        print(f"RENDER_TRIES=8 at least one clean@<{thr:.2f}s: {1-(1-p)**8:.1%}")


asyncio.run(main())
