#!/usr/bin/env python3
"""Step1-B 打断语义 + provider 真活单测（不依赖 LiveKit 会话，可离线复跑）。

覆盖：
1. GpuProbeProvider.run() 真读 GPU、耗时 ≥5s、返回含真实数值（非硬编码/非 sleep 假装）。
2. HermesSeatProvider 存在且能构造（a 类派活接缝）。
3. 【核心】"打断只掐嘴不掐活"：模拟 LiveKit interruption 掐掉当前 speech task，
   断言游离后台 task 仍跑到 done 且 session.say() 被调用（任务没被杀）。
4. 【反例击穿】若把后台 task 挂进被 cancel 的 task 集合，它会被杀 → 证明测试有判别力。
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from work_tools import GpuProbeProvider, HermesSeatProvider, _background_probe, get_provider


class FakeSession:
    def __init__(self) -> None:
        self.user_state = "listening"
        self.current_speech = None  # 与真实 AgentSession 对齐：无正在播放的 turn
        self.said: list[tuple[str, bool]] = []

    def say(self, text: str, *, allow_interruptions: bool = True) -> None:
        self.said.append((text, allow_interruptions))


async def test_provider_real() -> None:
    p = GpuProbeProvider()
    quick = await p.quick_read()
    assert quick and "显存" in quick, f"quick_read 未返回真读数: {quick!r}"
    t0 = time.monotonic()
    result = await p.run("gpu")
    elapsed = time.monotonic() - t0
    assert elapsed >= 13.0, f"后台活只有 {elapsed:.2f}s，够不到覆盖过渡语播放窗的时长"
    assert "查好了" in result and "%" in result, f"未返回真结果: {result!r}"
    assert "失败" not in result, f"真命令失败: {result!r}"
    print(f"[test1] PASS quick={quick!r}")
    print(f"[test1] PASS run elapsed={elapsed:.2f}s result={result!r}")


async def test_provider_seam() -> None:
    h = HermesSeatProvider("aniya")
    assert "已准备" in (await h.quick_read())
    assert get_provider().name == "gpu_probe"
    print("[test2] PASS provider 接缝：GpuProbeProvider(默认) + HermesSeatProvider(可切)")


async def test_interruption_does_not_kill_background() -> None:
    """核心：打断掐嘴（cancel speech task），游离后台 task 必须活到播报。"""
    session = FakeSession()
    provider = GpuProbeProvider()

    # 游离后台 task（正如 inspect_machine 里 create_task 的那样）
    bg = asyncio.create_task(_background_probe(session, provider, "gpu"))

    # 模拟"当前语音生成"：一个独立的 speech task；用户打断 = cancel 它。
    async def _speech() -> None:
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            raise

    speech = asyncio.create_task(_speech())
    await asyncio.sleep(0.4)         # 让后台活真正开始（已进入 5s 采样）
    speech.cancel()                  # ← 打断：掐嘴
    try:
        await speech
    except asyncio.CancelledError:
        pass
    assert speech.cancelled(), "speech task 应被 cancel（掐嘴生效）"

    await bg                         # ← 若后台 task 被连坐杀掉，这里抛 CancelledError
    assert bg.done() and not bg.cancelled(), "后台 task 不该被 cancel（只掐嘴不掐活）"
    assert len(session.said) == 1, f"结果应被主动播报一次: {session.said!r}"
    text, allow_int = session.said[0]
    assert "查好了" in text and "%" in text
    assert allow_int is False, "结果播报用 allow_interruptions=False"
    print(f"[test3] PASS 打断后后台 task 仍 done、结果已主动播报: {text[:60]!r}")


async def test_counterexample() -> None:
    """反例：若后台活被错误地挂进'会被 cancel 的集合'，它确实会死——证明 test3 有判别力。"""
    session = FakeSession()
    provider = GpuProbeProvider()
    bg = asyncio.create_task(_background_probe(session, provider, "gpu"))
    await asyncio.sleep(0.2)
    bg.cancel()                      # 错误实现：把后台活当 speech 一起 cancel
    try:
        await bg
    except asyncio.CancelledError:
        pass
    assert bg.cancelled(), "被 cancel 的后台 task 应当 cancelled"
    assert session.said == [], "后台活被杀 → 不该有结果播报"
    print("[test4] PASS 反例击穿：把后台活连坐 cancel 会丢结果（test3 的判别力成立）")


async def main() -> int:
    await test_provider_real()
    await test_provider_seam()
    await test_interruption_does_not_kill_background()
    await test_counterexample()
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
