#!/usr/bin/env python3
"""Step1-B 工具层：真 @function_tool + 与 session 解耦的后台长活。

语义（对应卡面三个决策）：
- 工具本体 *真读一次*（fast path，约 0.05s）拿到真 GPU 读数并立即 return，
  LLM 据此生成过渡语 → agent 能继续说话/应答下一轮（干活不堵嘴）。
- 真长活（≥5s GPU 采样 / 或换 seat 派 hermes）跑在自己 create_task 起的
  *游离* asyncio.Task 里，模块级集合强引用，不进 session 的任何 activity/task
  集合 → 打断掐掉的是当前 speech handle，cancel 不到这个 task（打断只掐嘴）。
- 后台活跑完后 session.say(result, allow_interruptions=False) 主动播报（结果能插话）。
- provider 是唯一接缝：换 acp 常驻会话只换 WorkProvider 实现类，不动打断语义。
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Protocol

from livekit.agents import RunContext, function_tool

# 游离后台任务强引用：asyncio 只持弱引用，不钉住会被 GC 中途回收。
_BG_TASKS: set[asyncio.Task] = set()


def _log(event: str, **fields: object) -> None:
    kv = " ".join(f"{k}={v}" for k, v in fields.items())
    print(f"[voice-tool] {event} ts={time.time():.3f} {kv}", flush=True)


class WorkProvider(Protocol):
    """provider 抽象：唯一接缝。实现类只负责「真干活 → 返回真结果文本」。"""

    name: str

    async def quick_read(self) -> str:
        """快读：工具本体同步等它（必须 <0.5s，不能堵嘴），返回真值短语。"""
        ...

    async def run(self, goal: str) -> str:
        """长活：后台 task 里跑（≥5s 真 IO/CPU/子进程），返回真结果文本。"""
        ...


class GpuProbeProvider:
    """默认 provider：真读本机 GPU。`nvidia-smi dmon -c 6 -d 1` 实测 5.04s。"""

    name = "gpu_probe"

    async def quick_read(self) -> str:
        out, rc = await _cmd(
            "nvidia-smi",
            "--query-gpu=name,memory.used,utilization.gpu",
            "--format=csv,noheader,nounits",
        )
        if rc != 0 or not out.strip():
            return "显卡读数暂不可用"
        rows = [r.strip() for r in out.strip().splitlines() if r.strip()]
        gpus = []
        for r in rows:
            parts = [p.strip() for p in r.split(",")]
            if len(parts) >= 3:
                gpus.append(f"{parts[0]} 显存{parts[1]}MiB 算力{parts[2]}%")
        return "；".join(gpus) if gpus else "未读到显卡"

    async def run(self, goal: str) -> str:
        # 真采样：-c 16 -d 1 → 16 次逐秒采样，实测 15.1s，全是真实 SM/util 值。
        # 长度是刻意选的：要跨过「LLM 生成过渡语 + 假流式 TTS 整段合成」这段
        # （实测约 6s 延迟）并覆盖 agent 说话窗口，才能让「后台干活」与
        # 「agent 继续说话」在时间轴上真重叠，而不是各说各话。
        out, rc = await _cmd(
            "nvidia-smi", "dmon", "-s", "u", "-c", "16", "-d", "1", timeout=30.0
        )
        if rc != 0:
            return f"后台采样失败（nvidia-smi rc={rc}），没能拿到结果。"
        sm: dict[str, list[int]] = {}
        for line in out.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            p = line.split()
            if len(p) >= 3 and p[0].isdigit():
                try:
                    sm.setdefault(p[0], []).append(int(p[1]))
                except ValueError:
                    continue
        if not sm:
            return "后台采样没读到有效数据。"
        segs = []
        for gpu, vals in sorted(sm.items()):
            avg = sum(vals) / len(vals)
            segs.append(f"{gpu} 号卡平均算力占用 {avg:.0f}%、峰值 {max(vals)}%")
        quick = await self.quick_read()
        return f"查好了，刚才后台逐秒采样 {sum(len(v) for v in sm.values())} 次：" + \
               "；".join(segs) + f"。当前 {quick}。"


class HermesSeatProvider:
    """a 类真派活：subprocess 起 `hermes -p <seat> -z <goal>`（--safe-mode 防嵌套死锁）。"""

    name = "hermes_seat"

    def __init__(self, seat: str) -> None:
        self._seat = seat

    async def quick_read(self) -> str:
        return f"已准备派活给 {self._seat} 席位"

    async def run(self, goal: str) -> str:
        out, rc = await _cmd(
            "hermes", "-p", self._seat, "--safe-mode", "-z", goal,
            timeout=60.0,
        )
        text = " ".join(out.split())[:400]
        if rc != 0 or not text:
            return f"派活给 {self._seat} 没拿到结果（rc={rc}）。"
        return f"派给 {self._seat} 的活跑完了，它说：{text}"


async def _cmd(*argv: str, timeout: float = 20.0) -> tuple[str, int]:
    """真跑一条外部命令，返回 (stdout+stderr, returncode)。"""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    p = None
    try:
        p = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=env,
        )
        out, _ = await asyncio.wait_for(p.communicate(), timeout=timeout)
        return out.decode("utf-8", "replace"), p.returncode or 0
    except asyncio.TimeoutError:
        if p is not None:
            try:
                p.kill()
            except Exception:
                pass
        return f"命令超时 {timeout}s: {argv[0]}", 124
    except Exception as e:  # noqa: BLE001
        return f"命令异常 {argv[0]}: {e!r}", 127


def get_provider() -> WorkProvider:
    kind = (os.getenv("VOICE_WORK_PROVIDER") or "gpu").strip().lower()
    if kind == "hermes":
        return HermesSeatProvider(os.getenv("VOICE_WORK_SEAT", "aniya"))
    return GpuProbeProvider()


def read_own_mood(*, persona: str | None = None, alive_home: "os.PathLike[str] | str | None" = None) -> str:
    """读 ~/.alive/personas/<id>/state/emotion-state.json，不编造心情。"""
    import json
    from pathlib import Path

    pid = (persona or os.getenv("ALIVE_PERSONA") or "").strip() or "unknown"
    home = Path(alive_home or os.getenv("ALIVE_HOME") or (Path.home() / ".alive"))
    path = home / "personas" / pid / "state" / "emotion-state.json"
    if not path.is_file():
        return f"{pid} 此刻心情说不清：没有自己的心情文件。"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return f"{pid} 此刻心情说不清：心情文件读不出来。"
    mood = data.get("mood") if isinstance(data, dict) else None
    desc = ""
    if isinstance(mood, dict):
        desc = str(mood.get("description") or "").strip()
    elif isinstance(mood, str):
        desc = mood.strip()
    if not desc:
        return f"{pid} 此刻心情说不清：文件里没有 description。"
    return f"{pid} 此刻心情是：{desc}"


@function_tool()
async def report_mood(ctx: RunContext) -> str:
    """回报你自己此刻的心情。用户问心情、状态、今天感觉怎么样时必须调用，
    绝不编一句通用的「还行」。读的是你自己那份 emotion-state.json。"""
    _log("TOOL_CALL", what="mood", persona=os.getenv("ALIVE_PERSONA", ""))
    return read_own_mood()


async def _background_probe(session, provider: WorkProvider, goal: str) -> None:
    """游离后台长活：与 speech handle / activity 生命周期解耦。"""
    t0 = time.monotonic()
    _log("BG_START", provider=provider.name, goal=goal)
    try:
        result = await provider.run(goal)
        _log("BG_DONE", provider=provider.name,
             elapsed=f"{time.monotonic() - t0:.2f}s", result=result)
        # 假流式 TTS 整段合成完才吐首帧，工具本体秒回后 LLM 的过渡语要再过 ~6s
        # 才真正播出。若此刻直接 say(result) 会被生成中的 turn 吞掉 —— 先等这一轮
        # （含用户打断后的应答）播完，结果播报才排得上、且不盖住对方。
        # shortcut: 轮询 current_speech / user_state 而非挂事件，上限 20s；
        # 升级点 = UserStateChangedEvent 精确让位（语义不变）。
        deadline = time.monotonic() + 20.0
        while time.monotonic() < deadline:
            if session.current_speech is None and session.user_state != "speaking":
                break
            await asyncio.sleep(0.15)
        session.say(result, allow_interruptions=False)
        _log("BG_SAY", provider=provider.name, user_state=session.user_state)
    except Exception as e:  # noqa: BLE001
        _log("BG_ERROR", provider=provider.name, error=repr(e))


@function_tool()
async def inspect_machine(ctx: RunContext, what: str = "gpu") -> str:
    """真实读取这台机器的显卡/GPU/磁盘状态或把活派出去。用户问「显卡忙不忙」
    「查下机器」「帮我跑个任务」时必须调用本工具，绝不自己编数据。
    工具会立刻返回即时读数；完整结果由后台约 15 秒后自动播报，无需用户再问。"""
    session = ctx.session
    provider = get_provider()
    _log("TOOL_CALL", what=what, provider=provider.name)
    quick = await provider.quick_read()  # 真读，约 0.05s，不堵嘴
    task = asyncio.create_task(_background_probe(session, provider, what))
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return (
        f"已开始后台查 {what}。即时读数：{quick}。"
        "完整采样要十几秒，好了我会主动告诉你；你先接着说别的，不用等我。"
    )


def active_task_count() -> int:
    return len(_BG_TASKS)
