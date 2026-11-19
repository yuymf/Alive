#!/usr/bin/env python3
"""Step3-P3 (t_e61fc3ac) 行为门禁：LLM 超时长尾「快速失败 + 降级过渡语」。

不放宽任何 V1–V3 闸、不改 latency_e2e.py 一个字节（sha256 钉死）。用
**同一份 agent.py 里的 _fastfail_llm_chunks** + 假 LLM stream 在 in-process
把四件事钉成可复现的红/绿：

  1. 正常轮零回归：首 chunk 在 cap 内到达 → 逐字原样转发全部 chunk，
     无 FlushSentinel、无过渡语、无降级日志（与改前代码路径一致）。
  2. 快速失败 + 降级：注入超时 → 首项是真话过渡语 str、紧跟 FlushSentinel
     切段（首字 <cap）、挂死 stream 被 aclose；随后重发请求的 chunk 仍全部到达
     —— assistant_texts 不被砍成只有过渡语，工具读数在后续 segment 播报。
  3. 修复前 A/B：fast_fail=False 时首 chunk 挂到 >=hold_s、无降级，复现长尾。
  4. 每道门配击穿反例（规则 12）：快响应不降级 / 120s 被夹到 ≤5s /
     0 被夹到 ≥0.5s / 重发也挂仍有兜底真话 / 默认 cap ≤2s / 过渡语非领域数据。

静态钉住：V1–V3 闸体 sha256 == Step1 绝对基线；agent.py 的 VAD 单一真源
`os.getenv("ALIVE_VAD_MIN_SILENCE", "0.35")` 仍在（不破坏 test_step2_invariants）；
llm_node 真的接线到看门狗（不留 helper 不用）。
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_AGENT = _ROOT / "alive/voice/agent/agent.py"
_HARNESS = _ROOT / "alive/voice/latency_e2e.py"

PINNED_GATE_SHA = "793c332a903def0e9f6c372c48c6c1fce5a7310c61a4cb3b229104f44f6e1c6f"


def _load_agent():
    sys.path.insert(0, str(_AGENT.parent))
    name = "guard_agent_p3"
    spec = importlib.util.spec_from_file_location(name, _AGENT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _gate_body(src: str) -> str:
    start = src.index("def validate(res: dict)")
    end = src.index("    return (not reasons), reasons", start) + len(
        "    return (not reasons), reasons")
    return src[start:end]


class _FakeStream:
    """模拟 super().llm_node() 的 async generator：delay 秒后才吐首 chunk。"""

    def __init__(self, delay, chunks):
        self.delay, self.chunks = delay, chunks
        self.closed = False

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        if self.delay > 0:
            await asyncio.sleep(self.delay)
        for c in self.chunks:
            yield c

    async def aclose(self):
        self.closed = True


def _factory(delay, chunks, calls):
    def make():
        s = _FakeStream(delay, chunks)
        calls.append(s)
        return s
    return make


def _collect(mod, make_iter, cap_s, hold_s, fast_fail, reissue_cap_s=None):
    """同步跑完 async generator，返回 (items, events)。"""
    from livekit.agents.types import FlushSentinel  # noqa: F401  (导入即验证可用性)
    events, out = [], []

    def log(kind, **fields):
        events.append((kind, fields))

    async def run():
        async for item in mod._fastfail_llm_chunks(
            make_iter, cap_s=cap_s, hold_s=hold_s, fast_fail=fast_fail,
            phrase=mod.LLM_DEGRADE_PHRASE,
            still_phrase=mod.LLM_STILL_STALLED_PHRASE, log=log,
            reissue_cap_s=reissue_cap_s):
            out.append(item)

    asyncio.run(run())
    return out, events


# ---------------------------------------------------------------------------
# 静态不变量
# ---------------------------------------------------------------------------
def test_gate_body_sha256_is_step1_baseline():
    """本卡绝不改 V1–V3 有效性闸：闸体 sha256 恒等于 Step1 绝对基线。"""
    src = _HARNESS.read_text(encoding="utf-8")
    assert hashlib.sha256(_gate_body(src).encode()).hexdigest() == PINNED_GATE_SHA


def test_agent_keeps_vad_single_source_and_is_wired():
    """VAD 单一真源仍在（不破坏 Step2 门禁），且 llm_node 真接到看门狗。"""
    src = _AGENT.read_text(encoding="utf-8")
    assert 'os.getenv("ALIVE_VAD_MIN_SILENCE", "0.35")' in src
    assert "async def llm_node(self, chat_ctx, tools, model_settings):" in src
    assert "_fastfail_llm_chunks(" in src
    assert "FlushSentinel()" in src
    assert "_read_fault()" in src


def test_default_cap_leaves_e2e_budget_for_first_audio():
    """默认 cap 必须给「STT 0.4 + 过渡语 TTS 0.1 + 管线 0.3」留出 <2.5s 首字预算。

    真机实测（t_e61fc3ac/driver_calib.json）：cap=2.0 → 注入轮 e2e=2.76s（超标），
    cap=1.5 → 2.301s。钉死 ≤1.6，防止有人把默认改回 2.0 让单测仍过、真机首字却超 2.5s。
    同时仍守住卡面「默认 ≤2s、不许塞 120s 堵死」。
    """
    mod = _load_agent()
    assert 0.5 < mod.LLM_TTFT_TIMEOUT_S <= 1.6
    assert mod.LLM_TTFT_TIMEOUT_S <= 2.0                  # 卡面硬约束
    assert mod._clamp_timeout(120) <= 5.0                 # 击穿反例：120s 被夹住
    assert mod._clamp_timeout(0) >= 0.5                   # 击穿反例：0 被夹住


def test_degrade_phrase_is_truth_not_fabricated_domain_data():
    """过渡语是一句真话，不含编造的显卡/磁盘读数（规则 15：兜底不合成领域数据）。"""
    mod = _load_agent()
    p = mod.LLM_DEGRADE_PHRASE
    assert p and isinstance(p, str)
    assert "显卡" not in p and "磁盘" not in p and "显存" not in p
    assert "%" not in p and "MiB" not in p


# ---------------------------------------------------------------------------
# 行为门禁（in-process，配击穿反例）
# ---------------------------------------------------------------------------
def test_normal_round_is_zero_regression():
    """正常轮：首 chunk 在 cap 内 → 逐字原样转发，无过渡语/切段/降级日志。"""
    from livekit.agents.types import FlushSentinel
    mod = _load_agent()
    CH = ["哦好，我看一眼哈", "显卡读数暂不可用", "磁盘状态正常"]
    out, ev = _collect(mod, _factory(0.0, CH, []), cap_s=2.0, hold_s=0.0, fast_fail=True)
    assert out == CH                                   # 逐字原样，不增不减
    assert not any(isinstance(x, FlushSentinel) for x in out)
    assert mod.LLM_DEGRADE_PHRASE not in out
    assert ev == []                                    # 无降级/注入日志


def test_timeout_fast_fails_with_phrase_and_keeps_full_answer():
    """注入超时 → 真话过渡语首出、切段、挂死流被关；后续 segment 仍带完整回答。"""
    from livekit.agents.types import FlushSentinel
    mod = _load_agent()
    CH = ["哦好，我看一眼哈", "显卡读数暂不可用", "磁盘状态正常"]
    calls = []
    out, ev = _collect(mod, _factory(0.0, CH, calls), cap_s=0.15, hold_s=0.6,
                       fast_fail=True)
    assert out[0] == mod.LLM_DEGRADE_PHRASE           # 首项=真话过渡语
    assert isinstance(out[1], FlushSentinel)           # 独立 segment 立刻播出
    later = [x for x in out if isinstance(x, str) and x != mod.LLM_DEGRADE_PHRASE]
    assert later == CH                                 # 工具读数/完整回答没被砍
    assert any(k == "LLMDegrade" and f.get("event") == "fast_fail" for k, f in ev)
    assert len(calls) >= 2 and calls[0].closed         # 挂死 stream 被 aclose


def test_pre_fix_ab_reproduces_long_tail_without_degrade():
    """修复前 A/B：fast_fail=False 无看门狗，首 chunk 挂到 hold_s，无降级。"""
    mod = _load_agent()
    CH = ["哦好，我看一眼哈", "显卡读数暂不可用", "磁盘状态正常"]
    out, ev = _collect(mod, _factory(0.0, CH, []), cap_s=0.15, hold_s=0.25,
                       fast_fail=False)
    assert out == CH
    assert not any(k == "LLMDegrade" for k, _ in ev)  # 修复前不降级
    assert mod.LLM_DEGRADE_PHRASE not in out


def test_fast_response_does_not_degrade_break_the_gate():
    """击穿反例：快响应（delay < cap）不触发降级，证明上面的绿不是恒真。"""
    from livekit.agents.types import FlushSentinel
    mod = _load_agent()
    CH = ["a", "b"]
    out, ev = _collect(mod, _factory(0.01, CH, []), cap_s=0.4, hold_s=0.0,
                       fast_fail=True)
    assert out == CH
    assert not any(isinstance(x, FlushSentinel) for x in out)
    assert ev == []


def test_reissue_uses_looser_bounded_cap_so_full_answer_survives():
    """击穿反例：重发请求比首字 cap 慢、但仍在有界窗口内 → 完整回答照常到达。

    若两次 attempt 都套同一个紧 cap，LM Studio 偶发 ttft=1.9s（容器态实测）
    会被误判二次卡死、砍成只有过渡语，直接违反卡面「工具读数仍要播报」。
    """
    mod = _load_agent()
    CH = ["哦好，我看一眼哈", "显卡读数暂不可用", "磁盘状态正常"]
    calls = [0]

    def make():
        # attempt 0 挂死；attempt 1 慢 0.4s 才给首个 chunk，但仍完整
        n = calls[0]
        calls[0] += 1
        return _FakeStream(0.0 if n > 0 else 5.0, [] if n == 0 else CH)

    out, ev = _collect(mod, make, cap_s=0.15, hold_s=0.0, fast_fail=True,
                       reissue_cap_s=1.0)
    later = [x for x in out if isinstance(x, str) and x != mod.LLM_DEGRADE_PHRASE]
    assert mod.LLM_DEGRADE_PHRASE == out[0]
    assert later == CH                                      # 没被砍成只有过渡语
    assert mod.LLM_STILL_STALLED_PHRASE not in out         # 没误判二次卡死
    assert not any(f.get("event") == "reissue_stalled" for _, f in ev)


def test_read_fault_cap_override_is_clamped_and_default_is_none():
    """可控注入的 cap_s 覆盖必须也过 clamp，缺省 None = 用生产默认，不许塞 120s。"""
    import tempfile
    mod = _load_agent()
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "fault.json"
        old = os.environ.get("ALIVE_VOICE_P3_FAULT_FILE")
        os.environ["ALIVE_VOICE_P3_FAULT_FILE"] = str(p)
        try:
            assert mod._read_fault()["cap_s"] is None        # 文件不存在=生产默认
            p.write_text(json.dumps({"hold_s": 16, "cap_s": 120}), encoding="utf-8")
            assert mod._read_fault()["cap_s"] == 5.0         # 被夹到上限
            assert not p.exists()                            # one-shot 已消费
            p.write_text(json.dumps({"hold_s": 16, "fast_fail": False}),
                         encoding="utf-8")
            assert mod._read_fault()["fast_fail"] is False    # A/B 对照开关生效
            assert not p.exists()                            # 缺省 one-shot
            # persist=True：V1 作废重跑时同一组内每次 llm_node 都能重新读到
            p.write_text(json.dumps({"hold_s": 16, "persist": True}),
                         encoding="utf-8")
            assert mod._read_fault()["hold_s"] == 16 and p.exists()
            assert mod._read_fault()["hold_s"] == 16 and p.exists()
            p.unlink()                                       # driver 显式清场
        finally:
            if old is None:
                os.environ.pop("ALIVE_VOICE_P3_FAULT_FILE", None)
            else:
                os.environ["ALIVE_VOICE_P3_FAULT_FILE"] = old


def test_reissue_also_stalled_still_speaks_truth():
    """击穿反例：重发也挂 → 仍出兜底真话，不静默（不许 16s 死等）。"""
    mod = _load_agent()

    class _Never:
        def __aiter__(self):
            return self._g()

        async def _g(self):
            await asyncio.sleep(5)
            yield "never"

        async def aclose(self):
            pass

    def make():
        return _Never()

    out, ev = _collect(mod, make, cap_s=0.12, hold_s=0.0, fast_fail=True)
    strs = [x for x in out if isinstance(x, str)]
    assert mod.LLM_DEGRADE_PHRASE in strs
    assert mod.LLM_STILL_STALLED_PHRASE in strs
    assert any(k == "LLMDegrade" and f.get("event") == "reissue_stalled"
               for k, f in ev)
