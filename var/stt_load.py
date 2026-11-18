#!/usr/bin/env python3
"""STT 高负载发生器：N 条并发 WS 流式识别，把 sherpa 容器 CPU 打满。"""
import argparse, asyncio, json, time
import aiohttp
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--n', type=int, default=8)
ap.add_argument('--duration', type=float, default=130)
a = ap.parse_args()
WS = 'ws://127.0.0.1:8802/v1/stt/stream'
rng = np.random.default_rng(7)


async def one(idx, deadline):
    try:
        async with aiohttp.ClientSession() as s, s.ws_connect(WS, autoping=False, heartbeat=None) as ws:
            while time.monotonic() < deadline:
                frame = (rng.integers(-3000, 3000, size=320, dtype=np.int16)).tobytes()
                await ws.send_bytes(frame)
                await asyncio.sleep(0.02)  # 实时速率喂流
    except Exception as e:
        print(f'stream {idx}: {e!r}', flush=True)


async def main():
    deadline = time.monotonic() + a.duration
    print(f'load: {a.n} concurrent WS streams for {a.duration}s', flush=True)
    await asyncio.gather(*[one(i, deadline) for i in range(a.n)])
    print('load done', flush=True)


asyncio.run(main())
