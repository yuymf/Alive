"""Step2 (t_b2d062f6) 静态不变量：V1–V3 闸不许被改、VAD 预检与 agent 同源。

为什么需要这些测试：attempt 1 把 agent.py 的 EnergyVAD 从 0.5 收到 0.35，
却漏改 latency_e2e.py 里自称「与 agent.py 保持一致」的预检常量 0.5，
于是 0.35~0.5s 的句中停顿穿过预检、被 VAD 切成两轮（V1 作废），冷启动 5 轮只 2 轮有效。
本文件把「改了闸」和「两处漂移」都钉死成编译期/测试期红。
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

_ROOT = Path(__file__).resolve().parents[2]
_HARNESS = _ROOT / "alive/voice/latency_e2e.py"
_AGENT = _ROOT / "alive/voice/agent/agent.py"


def _load_harness(vad: str | None = None):
    """按给定 ALIVE_VAD_MIN_SILENCE 重新 import harness（常量在 import 期读取）。"""
    if vad is None:
        os.environ.pop("ALIVE_VAD_MIN_SILENCE", None)
    else:
        os.environ["ALIVE_VAD_MIN_SILENCE"] = vad
    name = f"lat_harness_{abs(hash((vad, id(object()))))}"
    spec = importlib.util.spec_from_file_location(name, _HARNESS)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _gate_body(src: str) -> str:
    start = src.index("def validate(res: dict)")
    end = src.index("    return (not reasons), reasons", start) + len("    return (not reasons), reasons")
    return src[start:end]


def test_v1_v3_gate_is_byte_identical_to_committed_head():
    """硬门禁：不许改 latency_e2e.py 的 V1–V3 有效性闸来让数字好看。"""
    # git 子进程必须剥 GIT_*：hook 会 export GIT_DIR 指向宿主仓，继承后
    # git show 会读到别人的索引/HEAD（fleet 已知坑）。
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    head_src = subprocess.check_output(
        ["git", "show", "HEAD:alive/voice/latency_e2e.py"], cwd=_ROOT, text=True, env=env)
    work_src = _HARNESS.read_text(encoding="utf-8")

    def sha(s):
        return hashlib.sha256(s.encode()).hexdigest()

    # 绝对基线：Step1 交付时 validate() 闸体的 sha256。只比 HEAD 不够
    # ——改完闸再提交就能绕过；钉死常量后任何一次改动都必须显式更新这里。
    PINNED_GATE_SHA = "793c332a903def0e9f6c372c48c6c1fce5a7310c61a4cb3b229104f44f6e1c6f"
    assert sha(_gate_body(work_src)) == PINNED_GATE_SHA, (
        "validate() 闸体偏离 Step1 绝对基线 —— V1/V2/V3 判据被动过，卡面明令禁止")
    assert sha(_gate_body(head_src)) == sha(_gate_body(work_src)), (
        "validate() 相对 HEAD 发生变化 —— V1/V2/V3 闸被动过，卡面明令禁止")
    # 三条闸的条件逐条仍在，防止有人把整段挪走但内容巧合相等
    body = _gate_body(work_src)
    assert "len(commits) != 1" in body           # V1 单轮 commit
    assert "cov < 0.8" in body                   # V2 覆盖率
    assert "e2e_first_audio_s\"] <= 0" in body or "['e2e_first_audio_s'] <= 0" in body  # V3 不抢话


def test_both_files_read_the_same_env_knob():
    """单一真源：agent VAD 与 harness 预检必须读同一个 ALIVE_VAD_MIN_SILENCE。"""
    harness_src = _HARNESS.read_text(encoding="utf-8")
    agent_src = _AGENT.read_text(encoding="utf-8")
    assert 'os.environ.get("ALIVE_VAD_MIN_SILENCE", "0.35")' in harness_src
    assert 'os.getenv("ALIVE_VAD_MIN_SILENCE", "0.35")' in agent_src
    # 默认必须相等，否则不设环境变量时两处仍会漂移
    h = _load_harness()
    assert h.VAD_MIN_SILENCE == 0.35
    # 覆盖生效：同一 env 值两边解析出同一浮点数
    h2 = _load_harness("0.42")
    assert h2.VAD_MIN_SILENCE == 0.42


def test_render_tries_covers_measured_clean_rate():
    """RENDER_TRIES 必须够大：实测 clean render 命中率 ~19%（gap_probe.log）。"""
    h = _load_harness()
    p_clean = 0.19
    p_all_miss = (1 - p_clean) ** h.RENDER_TRIES
    assert p_all_miss < 0.01, f"24 次重渲染仍全落空的概率 {p_all_miss:.2%} 不可接受"


def _trigger_with_midsentence_pause(gap_s: float = 0.40) -> np.ndarray:
    """合成 1s 有声 + gap_s 静音 + 1s 有声（24k int16），复现逗号停顿。"""
    sr = 24000
    tone = (np.sin(np.linspace(0, 2 * np.pi * 220 * 1.0, sr)) * 12000).astype(np.int16)
    silence = np.zeros(int(sr * gap_s), dtype=np.int16)
    return np.concatenate([tone, silence, tone])


def test_precheck_catches_040s_pause_that_agent_vad_would_split():
    """击穿用例：0.40s 句中停顿在 VAD=0.35 下会被切两轮，预检必须拦下并重渲染。"""
    h = _load_harness("0.35")
    gaps = h.vad_split_gaps(_trigger_with_midsentence_pause(0.40))
    assert gaps, "0.40s 停顿必须被预检判为可切轮静音谷，否则触发音频会进 V1 作废轮"


def test_old_050_threshold_misses_the_same_pause_negative_control():
    """反例对照：旧值 0.5 会漏检同一段音频 —— 证明上面那条断言真有判别力，不是恒真。"""
    h_old = _load_harness("0.50")
    gaps_old = h_old.vad_split_gaps(_trigger_with_midsentence_pause(0.40))
    assert gaps_old == [], "旧 0.5 阈值应漏检 0.40s 停顿（这正是 attempt 1 冷启动翻车的原因）"


def test_short_pause_is_allowed():
    """0.20s 停顿在 0.35 阈值下应放行（不能把预检收紧到连正常短语都渲染不出来）。"""
    h = _load_harness("0.35")
    assert h.vad_split_gaps(_trigger_with_midsentence_pause(0.20)) == []
