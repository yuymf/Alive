#!/usr/bin/env python3
"""Step3-P1 (t_65f84c9c) PREFLIGHT 抢跑「默认关」行为门禁 + 真因固化。

本卡实测结论：抢跑无效（0.000s ttft/判停窗口重叠、preemptive generation 采纳 0 次），
不放宽 V1–V3 就修不通。按卡面 invariant #5，SHERPA_PREFLIGHT 保持默认 0，
不许把未验功能标成「已生效」。本文件把这条决定钉成**编译期/测试期红**，
而不是靠一句注释/Prompt：

  1. 默认关：`agent.py` 与 `sherpa_stream_stt.py` 都读 `SHERPA_PREFLIGHT`、
     缺省值必须是 "0"（fail-closed，env 没显式设 1 就绝不抢跑）。
  2. 接线一致：`preemptive_generation.enabled` 必须绑定到 ENABLE_PREFLIGHT，
     不许硬编码 True；PREFLIGHT_TRANSCRIPT 只在开关打开时发。
  3. 结构真因（不是时序猜测）：LiveKit `_on_user_turn_completed` 只在
     `_transcripts_equivalent(preflight_text, final_text)` 为真时采纳抢跑生成。
     我们的 preflight 是**增长中的稳定前缀**（"帮"→"帮我查"→…→"…看看磁盘"），
     而 P0 的尾部补帧让末字「状态」只在 flush 后才出现 →
     任何 pre-flush 前缀都 ≠ FINAL 整句 → 抢跑生成恒被 invalidate/重建，
     LLM 无法与判停窗口重叠。用 LiveKit 真实函数逐条钉死，并配**击穿反例**
     （完整整句 == 自身 → True），证明这条断言真有判别力，不是恒真。
  4. V1–V3 有效性闸 sha256 仍等于 Step1 绝对基线（本卡没碰 latency_e2e.py）。

证据（不入库、随任务附件）：var/voice-evidence/t_65f84c9c/
  latency_overlap.txt / prefix_equiv.txt / dual_caliber.txt / REPORT.md。
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_AGENT = _ROOT / "alive/voice/agent/agent.py"
_STT = _ROOT / "alive/voice/agent/sherpa_stream_stt.py"
_HARNESS = _ROOT / "alive/voice/latency_e2e.py"

PINNED_GATE_SHA = "793c332a903def0e9f6c372c48c6c1fce5a7310c61a4cb3b229104f44f6e1c6f"
FINAL = "帮我查一下这台机器的显卡现在忙不忙顺便看看磁盘状态"


def _gate_body(src: str) -> str:
    start = src.index("def validate(res: dict)")
    end = src.index("    return (not reasons), reasons", start) + len(
        "    return (not reasons), reasons")
    return src[start:end]


def _livekit_equivalent():
    """取 LiveKit 真实判定函数。

    守卫类用例不许静默 skip：跑错解释器（没装 livekit）必须当场判红，
    否则「抢跑无效」这道门会无声失效（见 pytest-skip-to-fail-guard）。
    """
    from livekit.agents.voice.agent_activity import _transcripts_equivalent  # noqa
    return _transcripts_equivalent


# ---- 1. 默认关（fail-closed） -------------------------------------------------

def test_preflight_default_is_off_in_both_files():
    """硬门禁：env 未显式设 1 时，两处开关都必须缺省 0。"""
    agent = _AGENT.read_text(encoding="utf-8")
    stt = _STT.read_text(encoding="utf-8")
    assert 'os.getenv("SHERPA_PREFLIGHT", "0")' in agent, (
        "agent.py 的 SHERPA_PREFLIGHT 缺省值不是 0 —— 抢跑会被默认打开")
    assert 'os.environ.get("SHERPA_PREFLIGHT", "0")' in stt, (
        "sherpa_stream_stt.py 的 SHERPA_PREFLIGHT 缺省值不是 0 —— 抢跑会被默认打开")


def test_preemptive_generation_bound_to_flag_not_hardcoded():
    """preemptive_generation.enabled 必须绑定开关，不许写死 True。"""
    agent = _AGENT.read_text(encoding="utf-8")
    assert '"preemptive_generation": {"enabled": ENABLE_PREFLIGHT}' in agent, (
        "preemptive_generation 未绑定到 ENABLE_PREFLIGHT（或已被硬编码打开）")
    assert '"preemptive_generation": {"enabled": True}' not in agent


def test_preflight_transcript_emission_is_gated():
    """PREFLIGHT_TRANSCRIPT 必须只在开关打开时 emit，不许无条件发。"""
    stt = _STT.read_text(encoding="utf-8")
    assert 'typ == "preflight" and ENABLE_PREFLIGHT and text' in stt, (
        "PREFLIGHT_TRANSCRIPT 没被 ENABLE_PREFLIGHT 门住")
    assert "SpeechEventType.PREFLIGHT_TRANSCRIPT" in stt


def test_agent_and_stt_stable_knob_are_independent():
    """SHERPA_STABLE_MS（前缀稳定等待）与 ALIVE_VAD_MIN_SILENCE（判停）是两个独立旋钮。"""
    server = (_ROOT / "alive/voice/sherpa_stream/server.py").read_text(encoding="utf-8")
    assert 'os.environ.get("SHERPA_STABLE_MS", "220")' in server
    assert 'os.environ.get("ALIVE_VAD_MIN_SILENCE", "0.35")' in _HARNESS.read_text(encoding="utf-8")
    assert 'os.getenv("ALIVE_VAD_MIN_SILENCE", "0.35")' in _AGENT.read_text(encoding="utf-8")


# ---- 2. 结构真因：增长前缀永远不等于 FINAL 整句 ------------------------------

def _growing_prefixes():
    """复现真实 preflight 序列：逐字增长、最后一字「状态」缺位（P0 flush 才补）。"""
    return ["帮", "帮我查", "帮我查一下这", "帮我查一下这台机器",
            "帮我查一下这台机器的显卡", "帮我查一下这台机器的显卡现在忙",
            "帮我查一下这台机器的显卡现在忙不忙",
            "帮我查一下这台机器的显卡现在忙不忙顺便",
            "帮我查一下这台机器的显卡现在忙不忙顺便看看磁",
            "帮我查一下这台机器的显卡现在忙不忙顺便看看磁盘"]


def test_every_preflight_prefix_is_non_equivalent_to_final():
    """真因固化：任一 pre-flush 前缀都过不了 LiveKit 的采纳判据。"""
    eq = _livekit_equivalent()
    bad = [p for p in _growing_prefixes() if eq(p, FINAL)]
    assert bad == [], f"以下前缀竟被判为与 FINAL 等价（抢跑可被采纳）: {bad}"


def test_full_sentence_is_equivalent_negative_control():
    """击穿反例：完整整句与自身必须被判等价 —— 证明上面那条不是恒真断言。"""
    eq = _livekit_equivalent()
    assert eq(FINAL, FINAL) is True
    assert eq(FINAL, FINAL + "。") is True          # 标点不影响分词语义
    assert eq(FINAL, "帮我查一下") is False          # 少一大截 → 必须不采纳


def test_final_word_only_materializes_after_flush_prefix_cannot_contain_it():
    """P0 尾部补帧的连带结论：末字「状态」不在任何稳定前缀里。"""
    assert all("状态" not in p for p in _growing_prefixes())
    assert FINAL.endswith("状态")


# ---- 3. 闸体不许被动过 -------------------------------------------------------

def test_v1_v3_gate_body_still_pinned():
    """本卡没碰 latency_e2e.py 的 V1–V3 有效性闸。"""
    work = _HARNESS.read_text(encoding="utf-8")
    body = _gate_body(work)
    assert hashlib.sha256(body.encode()).hexdigest() == PINNED_GATE_SHA
    for needle in ("len(commits) != 1", "cov < 0.8"):
        assert needle in body
