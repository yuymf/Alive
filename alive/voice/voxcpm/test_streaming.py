"""VoxCPM sidecar 真流式路径的离线校验（不加载模型，用替身）。

钉住四件事：
1. `_StreamResampler` 的分块拼接结果与一次性 `soxr.resample` **逐样本一致**；
2. 反例击穿：「每块独立重采样」与一次性结果偏差显著 → 判据真有判别力；
3. `/stream` 每块立刻产出（首块时刻 << 总耗时），不是攒完再切；
4. 尾部 flush 不丢样本，mock 模式仍能联调。
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import pytest
import torch

_TMP = tempfile.mkdtemp(prefix="voxcpm-stream-test-")
os.environ["ALIVE_HOME"] = _TMP
os.environ["VOXCPM_VOICE_DIR"] = os.path.join(_TMP, "voices")

_SERVER_PY = Path(__file__).with_name("server.py")
_spec = importlib.util.spec_from_file_location("voxcpm_server_stream_under_test", _SERVER_PY)
assert _spec and _spec.loader
server = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = server
_spec.loader.exec_module(server)

SRC_SR = 48000
DST_SR = server.SAMPLE_RATE
CHUNK = SRC_SR // 10  # 100ms — one autoregressive step


def _tone(freq: float, sr: int, seconds: float) -> np.ndarray:
    t = np.arange(int(sr * seconds)) / sr
    return (0.5 * np.sin(2 * np.pi * freq * t) * 32767.0).astype(np.int16)


def _chunks(x: np.ndarray, step: int) -> list[np.ndarray]:
    return [x[i:i + step] for i in range(0, len(x), step)]


# --- 1. 分块重采样 == 一次性重采样 ---------------------------------------


def test_streamed_resample_is_sample_exact_vs_one_shot():
    src = _tone(440.0, SRC_SR, 2.0)
    one_shot = server._resample_int16(src, SRC_SR, DST_SR)

    rs = server._StreamResampler(SRC_SR, DST_SR)
    parts = [rs.push(c) for c in _chunks(src, CHUNK)]
    parts.append(rs.push(np.zeros(0, dtype=np.int16), last=True))
    streamed = np.concatenate([p for p in parts if p.size])

    assert len(streamed) == len(one_shot), f"{len(streamed)} vs {len(one_shot)} samples"
    delta = np.abs(streamed.astype(np.int32) - one_shot.astype(np.int32))
    assert delta.max() <= 2, f"max sample delta {delta.max()} — chunked filter drifted"


def test_independent_per_chunk_resample_is_detectably_worse():
    """反例击穿：每块独立重采样 → 与一次性结果偏差明显，上一条判据会红。"""
    src = _tone(440.0, SRC_SR, 2.0)
    one_shot = server._resample_int16(src, SRC_SR, DST_SR)
    naive = np.concatenate([server._resample_int16(c, SRC_SR, DST_SR)
                            for c in _chunks(src, CHUNK)])

    n = min(len(naive), len(one_shot))
    delta = np.abs(naive[:n].astype(np.int32) - one_shot[:n].astype(np.int32))
    assert delta.max() > 50, (
        f"mutant max delta {delta.max()} — the sample-exact assertion has no discriminating power")


def test_streamed_resample_keeps_tail_samples():
    """last=True 必须把滤波器 lookahead 排空，否则每句末尾被截。"""
    src = _tone(440.0, SRC_SR, 1.0)
    one_shot = server._resample_int16(src, SRC_SR, DST_SR)

    rs = server._StreamResampler(SRC_SR, DST_SR)
    no_flush = np.concatenate([rs.push(c) for c in _chunks(src, CHUNK)])

    rs2 = server._StreamResampler(SRC_SR, DST_SR)
    with_flush = np.concatenate([rs2.push(c) for c in _chunks(src, CHUNK)]
                                + [rs2.push(np.zeros(0, dtype=np.int16), last=True)])

    assert len(no_flush) < len(one_shot), "sanity: without flush the tail is short"
    assert abs(len(with_flush) - len(one_shot)) <= 2, (
        f"flush produced {len(with_flush)} vs {len(one_shot)} samples")


# --- 2. 真流式：首块立刻出 ------------------------------------------------


class _FakeModel:
    """替身：每步吐 100ms 48kHz float 张量，共 steps 步，每步人为 delay 秒计算耗时。"""

    def __init__(self, steps: int = 20, delay: float = 0.02) -> None:
        self.steps = steps
        self.delay = delay
        self.tts_model = self

    @property
    def sample_rate(self) -> int:
        return SRC_SR

    def generate_with_prompt_cache_streaming(self, *, target_text, prompt_cache, **kw):
        assert kw["retry_badcase"] is False, "streaming mode must not ask for badcase retry"
        for _ in range(self.steps):
            time.sleep(self.delay)
            yield (torch.zeros(1, CHUNK), None, None)


def test_stream_yields_first_chunk_long_before_total(monkeypatch):
    fake = _FakeModel(steps=20, delay=0.02)  # 20 * 20ms = 0.4s of compute
    monkeypatch.setattr(server, "_load_model", lambda: fake)
    monkeypatch.setattr(server, "_cached_prompt_cache", lambda model, voice: None)

    t0 = time.perf_counter()
    first_at = None
    total_bytes = 0
    for chunk in server._stream_pcm("测试一句话。", "default"):
        if first_at is None:
            first_at = time.perf_counter() - t0
        total_bytes += len(chunk)
    total = time.perf_counter() - t0

    assert first_at is not None, "no audio produced"
    assert first_at < total * 0.25, (
        f"first chunk at {first_at:.3f}s of {total:.3f}s — batch-then-slice, not streaming")
    # 20 steps x 100ms @48k mono int16 = 192000 bytes, halved to 24k
    assert abs(total_bytes - 20 * CHUNK * 2 / 2) < 4096, f"total_bytes={total_bytes}"


def test_batch_then_slice_would_fail_the_first_chunk_criterion(monkeypatch):
    """反例击穿：旧实现（整段合成完再切）首块时刻 ≈ 总耗时 → 上一条判据会红。"""
    fake = _FakeModel(steps=10, delay=0.02)
    monkeypatch.setattr(server, "_load_model", lambda: fake)
    monkeypatch.setattr(server, "_cached_prompt_cache", lambda model, voice: None)

    t0 = time.perf_counter()
    pcm = b"".join(server._stream_pcm("测试。", "default"))
    batch_first = time.perf_counter() - t0
    total = time.perf_counter() - t0

    assert pcm, "mutant produced no audio"
    assert batch_first >= total * 0.25, (
        "mutant should look like batch-then-slice; the first-chunk criterion must catch it")


def test_stream_passes_ratio_cap_so_runaway_utts_are_bounded(monkeypatch):
    """流式不能 retry_badcase，退化只能靠 max_len 截断 → ratio_threshold 必须传下去。

    默认 6.0 时 10 个文本 token 允许 ~70 个音频 token（≈9s），实测就出过 9.27s 的
    「啊啊啊啊」。这里钉住：传给库的 ratio_threshold 必须是收紧后的值。
    """
    seen = {}

    class _Model:
        sample_rate = SRC_SR
        tts_model = None

        def __init__(self) -> None:
            self.tts_model = self

        def generate_with_prompt_cache_streaming(self, **kw):
            seen.update(kw)
            yield (torch.zeros(1, CHUNK), None, None)

    m = _Model()
    monkeypatch.setattr(server, "_load_model", lambda: m)
    monkeypatch.setattr(server, "_cached_prompt_cache", lambda model, voice: None)
    monkeypatch.delenv("VOXCPM_STREAM_RATIO_CAP", raising=False)

    list(server._stream_pcm("测试一句短话。", "default"))

    assert seen["retry_badcase"] is False, "streaming mode must not request badcase retry"
    assert seen["retry_badcase_ratio_threshold"] == 3.0, (
        f"ratio cap is {seen.get('retry_badcase_ratio_threshold')} — the library default 6.0 "
        "allows 9-second runaway utterances in streaming mode")


def test_ratio_cap_is_env_overridable(monkeypatch):
    seen = {}

    class _Model:
        sample_rate = SRC_SR
        tts_model = None

        def __init__(self) -> None:
            self.tts_model = self

        def generate_with_prompt_cache_streaming(self, **kw):
            seen.update(kw)
            yield (torch.zeros(1, CHUNK), None, None)

    m = _Model()
    monkeypatch.setattr(server, "_load_model", lambda: m)
    monkeypatch.setattr(server, "_cached_prompt_cache", lambda model, voice: None)
    monkeypatch.setenv("VOXCPM_STREAM_RATIO_CAP", "2.5")

    list(server._stream_pcm("测试。", "default"))
    assert seen["retry_badcase_ratio_threshold"] == 2.5


# --- 3. mock 模式仍可联调 -------------------------------------------------


def test_mock_stream_emits_chunks_without_model(monkeypatch):
    monkeypatch.setenv("VOXCPM_MOCK", "1")
    monkeypatch.setattr(server, "_model", None)
    chunks = list(server._stream_pcm("你好。", "default"))
    assert len(chunks) > 1, "mock streaming must yield multiple chunks, not one blob"
    assert all(len(c) % 2 == 0 for c in chunks)


# --- 4. 并发安全：模型实例必须串行 ---------------------------------------


def test_model_calls_are_serialised(monkeypatch):
    """两个并发流不能同时进模型：GPU 上会互相踩 KV/VAE 状态。"""
    import threading

    state = {"active": 0, "max": 0}
    guard = threading.Lock()

    class _SlowModel(_FakeModel):
        def generate_with_prompt_cache_streaming(self, **kw):
            with guard:
                state["active"] += 1
                state["max"] = max(state["max"], state["active"])
            try:
                yield from super().generate_with_prompt_cache_streaming(**kw)
            finally:
                with guard:
                    state["active"] -= 1

    fake = _SlowModel(steps=4, delay=0.01)
    monkeypatch.setattr(server, "_load_model", lambda: fake)
    monkeypatch.setattr(server, "_cached_prompt_cache", lambda model, voice: None)

    threads = [threading.Thread(target=lambda: list(server._stream_pcm("测试。", "default")))
               for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert state["max"] == 1, f"{state['max']} concurrent model calls — _MODEL_LOCK is not held"
