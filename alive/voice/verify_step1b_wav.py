#!/usr/bin/env python3
"""Step1-B 录制验收：把 wav 按静音切成语音段，逐段 STT + RMS，供 chief 复核。

用法：
  .venv-voice/bin/python alive/voice/verify_step1b_wav.py <wav> [--stt-base URL]

输出每段 [start,end] + RMS + STT 文本，并给出段间静音长度（打断版应能看到
「过渡语 → 长静音 → 结果播报」；不打断版两段间隔短）。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import urllib.request
import wave

import numpy as np


def rms_segments(pcm: np.ndarray, sr: int, *, thresh: float = 120.0,
                 win: float = 0.05, gap: float = 2.5) -> list[tuple[float, float]]:
    """按短窗 RMS 找有声段；<gap 的静音视为句内 chunk 间隙合并。"""
    n = int(win * sr)
    voiced = []
    for i in range(0, len(pcm), n):
        seg = pcm[i:i + n]
        if seg.size == 0:
            continue
        r = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2)))
        voiced.append((i / sr, (i + seg.size) / sr, r > thresh))
    segs: list[tuple[float, float]] = []
    cur_start = None
    last_end = 0.0
    for a, b, on in voiced:
        if on:
            if cur_start is None:
                cur_start = a
            last_end = b
        else:
            if cur_start is not None and a - last_end >= gap:
                segs.append((cur_start, last_end))
                cur_start = None
    if cur_start is not None:
        segs.append((cur_start, last_end))
    return segs


def stt(seg: np.ndarray, sr: int, base: str) -> str:
    b = io.BytesIO()
    w = wave.open(b, "wb")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes(seg.tobytes()); w.close()
    bd = "----probe"
    body = io.BytesIO()
    for k, v in (("model", "whisper-1"), ("language", "zh")):
        body.write(f"--{bd}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    body.write(f"--{bd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"s.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode())
    body.write(b.getvalue())
    body.write(f"\r\n--{bd}--\r\n".encode())
    req = urllib.request.Request(
        f"{base}/audio/transcriptions", data=body.getvalue(),
        headers={"Content-Type": f"multipart/form-data; boundary={bd}"},
    )
    try:
        return json.loads(urllib.request.urlopen(req, timeout=90).read().decode()).get("text", "")
    except Exception as e:  # noqa: BLE001
        return f"<STT 失败 {e!r}>"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("wav")
    p.add_argument("--stt-base", default=os.environ.get("OPENAI_STT_BASE", "http://10.89.22.4:8000/v1"))
    p.add_argument("--gap", type=float, default=2.5)
    cfg = p.parse_args()

    w = wave.open(cfg.wav, "rb")
    sr = w.getframerate()
    pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    w.close()
    segs = rms_segments(pcm, sr, gap=cfg.gap)
    print(f"WAV {cfg.wav} sr={sr} duration={len(pcm)/sr:.2f}s segments={len(segs)}")
    prev_end = 0.0
    for i, (a, b) in enumerate(segs, 1):
        seg = pcm[int(a * sr):int(b * sr)]
        r = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2)))
        print(f"[seg{i}] {a:.2f}-{b:.2f}s len={b-a:.2f}s gap_before={a-prev_end:.2f}s "
              f"rms={r:.0f} STT={stt(seg, sr, cfg.stt_base)!r}", flush=True)
        prev_end = b
    return 0


if __name__ == "__main__":
    sys.exit(main())
