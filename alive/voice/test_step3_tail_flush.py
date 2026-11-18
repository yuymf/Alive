#!/usr/bin/env python3
"""Step3-P0 (t_0b114497) correctness 行为门禁：末字「状态」不再被截断。

与 test_step2_stream_stt.py 互补：那边连真 Docker 容器量尾延迟，这边用
**同一份模型 + 与 server.py 完全一致的逐帧喂流/decode 循环**，在 in-process
里把「尾部右上下文 flush」这件事钉成可复现的红/绿：

  1. pad=400（生产默认）  → final 含完整「磁盘状态」，coverage ≥0.95
  2. pad=0（反例击穿）    → final 停在「…磁盘」，coverage 0.885，无「磁盘状态」
     —— 证明上面的绿是**修复带来的**，不是恒真断言
  3. 静态钉住 server.py 的 flush 分支真的调用了 flush_tail_pad，
     且 Dockerfile / compose 带着 tail_flush.py 与旋钮（防「留着 helper 不接线」）
  4. V1–V3 闸体 sha256 仍等于 Step1 绝对基线（本卡没碰 latency_e2e.py）

诊断依据：probe_diag2.json 边界 300→320ms；probe_algo.json 跨 6 种
caller-silence 全部 pad→0.962 / 关掉→0.885。
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
import sys
from pathlib import Path

import numpy as np
import pytest

_ROOT = Path(__file__).resolve().parents[2]
_SERVER = _ROOT / "alive/voice/sherpa_stream/server.py"
_TAIL = _ROOT / "alive/voice/sherpa_stream/tail_flush.py"
_DOCKERFILE = _ROOT / "alive/voice/sherpa_stream/Dockerfile"
_COMPOSE = _ROOT / "alive/voice/sherpa_stream/docker-compose.yml"
_WAV24 = _ROOT / "var/poc/trigger24.wav"
_HARNESS = _ROOT / "alive/voice/latency_e2e.py"
_MODEL_DIR = Path(os.environ.get(
    "SHERPA_MODEL_DIR",
    "/mnt/data/models/sherpa-streaming/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"))
TRIGGER = "帮我查一下这台机器的显卡现在忙不忙，顺便看看磁盘状态"
SR, HOP = 16000, 320

PINNED_GATE_SHA = "793c332a903def0e9f6c372c48c6c1fce5a7310c61a4cb3b229104f44f6e1c6f"


def _tail_mod():
    spec = importlib.util.spec_from_file_location("tail_flush_under_test", _TAIL)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _needs_model():
    try:
        import sherpa_onnx  # noqa: F401
        import soxr  # noqa: F401
    except Exception:
        return False
    return (_MODEL_DIR / "encoder.int8.onnx").exists() and _WAV24.exists()


@pytest.mark.skipif(not _needs_model(), reason="sherpa 模型/trigger wav 或 sherpa_onnx/soxr 不可用")
def _drive(pad_ms: float):
    """复刻 server.py：每个 20ms hop -> accept_waveform + decode_all；flush 时补尾部帧。"""
    import sherpa_onnx
    import soxr
    flush_tail_pad = _tail_mod().flush_tail_pad

    rec = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(_MODEL_DIR / "tokens.txt"),
        encoder=str(_MODEL_DIR / "encoder.int8.onnx"),
        decoder=str(_MODEL_DIR / "decoder.onnx"),
        joiner=str(_MODEL_DIR / "joiner.int8.onnx"),
        num_threads=2, sample_rate=SR, feature_dim=80,
        enable_endpoint_detection=False, decoding_method="greedy_search", provider="cpu",
    )
    pcm24 = np.frombuffer(_WAV24.read_bytes()[44:], dtype=np.int16).copy()
    pcm16 = np.asarray(soxr.resample(pcm24.astype(np.float32) / 32768.0,
                                     24000, 16000, quality="HQ"), dtype=np.float32)
    stream = rec.create_stream()

    def drain():
        n = 0
        while rec.is_ready(stream):
            rec.decode_stream(stream)
            n += 1
        return n

    for off in range(0, len(pcm16), HOP):
        stream.accept_waveform(SR, pcm16[off:off + HOP])
        drain()
    # ---- flush ----
    pad_steps = flush_tail_pad(rec, stream, pad_ms, sample_rate=SR)
    flush_decodes = drain()
    final = rec.get_result(stream).strip()
    g = set(final)
    cov = sum(1 for ch in TRIGGER if ch in g) / len(TRIGGER)
    return {"final": final, "coverage": round(cov, 3),
            "has_磁盘状态": "磁盘状态" in final,
            "pad_steps": pad_steps, "flush_decodes": flush_decodes}


def test_tail_pad_recovers_complete_final():
    """生产默认 400ms：末二字「状态」必须回来，coverage ≥0.95（对照批式 0.962）。"""
    r = _drive(400.0)
    assert r["has_磁盘状态"], f"末字仍被截断: {r['final']!r}"
    assert r["coverage"] >= 0.95, f"coverage {r['coverage']} < 0.95: {r['final']!r}"
    assert r["pad_steps"] >= 1 and r["flush_decodes"] >= 1, (
        "补丁没有促使任何 encoder chunk 解码 —— 绿可能是恒真")


def test_no_pad_is_truncated_negative_control():
    """反例击穿：pad=0 必须复现 0.885 截断，证明上面的绿来自修复本身。"""
    r = _drive(0.0)
    assert not r["has_磁盘状态"], f"pad=0 却拿到完整末字，测试失去判别力: {r['final']!r}"
    assert r["coverage"] < 0.95, f"pad=0 coverage 反而 {r['coverage']}"
    assert r["pad_steps"] == 0 and r["flush_decodes"] == 0


def test_server_flush_branch_is_wired():
    """静态钉住接线：server.py flush 分支真调用 helper，镜像/编排带着新文件与旋钮。"""
    src = _SERVER.read_text(encoding="utf-8")
    assert "from tail_flush import flush_tail_pad" in src
    assert 'os.environ.get("SHERPA_TAIL_PAD_MS", "400")' in src
    # flush 分支里必须调用，且只在 flush 分支（interim 路径不得补帧）
    flush_block = src.split('if typ == "flush":', 1)[1].split('elif typ == "reset":', 1)[0]
    assert "flush_tail_pad(rec, stream, TAIL_PAD_MS" in flush_block
    # 只禁「调用」：顶部 `from tail_flush import flush_tail_pad` 是合法导入，
    # 用裸标识符会把 import 自身误判成漏进 interim 路径（假红）。
    assert "flush_tail_pad(" not in src.split('if typ == "flush":', 1)[0], (
        "尾部填充调用漏进了 interim/preflight 路径")
    assert "tail_flush.py" in _DOCKERFILE.read_text(encoding="utf-8")
    assert 'SHERPA_TAIL_PAD_MS: "400"' in _COMPOSE.read_text(encoding="utf-8")


def test_v1_v3_gate_body_unchanged():
    """本卡不许碰 V1–V3 有效性闸（sha256 == Step1 绝对基线 == HEAD）。"""
    def gate_body(s: str) -> str:
        start = s.index("def validate(res: dict)")
        end = s.index("    return (not reasons), reasons", start) + len(
            "    return (not reasons), reasons")
        return s[start:end]
    work = _HARNESS.read_text(encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    import subprocess
    head = subprocess.check_output(
        ["git", "show", "HEAD:alive/voice/latency_e2e.py"],
        cwd=_ROOT, text=True, env=env)
    sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
    assert sha(gate_body(work)) == PINNED_GATE_SHA
    assert sha(gate_body(head)) == sha(gate_body(work))
