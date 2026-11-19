#!/usr/bin/env python3
"""Alive LiveKit worker: 流式 STT → 人格 LLM → VoxCPM TTS.

Step2（t_b2d062f6）：
  * STT 从 speaches 批式换成 sherpa-onnx 流式（Docker/CPU，0 显存）：
    边说边 decode，VAD 判停 flush 时终句已在手上（tail 0.54s → 0.016s）。
  * worker 启动预热：预建 STT/LLM/TTS 单例、预取人格 prompt、发一次真实 LLM
    完成请求编译 LM Studio 的 prompt cache —— 收掉冷启动首轮 3.834s。
  * event-loop 阻塞：把 `_fetch_prompt()` 的同步 httpx 改成共享 AsyncClient 的
    await；把 plugin 的 httpx2 SSL context 构造从 entrypoint 挪到进程启动期。

不变：`work_tools.py` / `voice.env` / `voxcpm_tts.py::SynthesizeStream` 零改动；
人格正本、VoxCPM2、qwen3.8-27b 不换。
"""

from __future__ import annotations

import asyncio
import gc
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx
from dotenv import load_dotenv
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, JobExecutorType, cli
from livekit.agents.types import FlushSentinel
from livekit.plugins import openai, silero

from work_tools import inspect_machine, report_mood  # Step1-B 干活 + Step2 各报自己的心情

try:
    from emotion_runtime import build_runtime as _build_emotion_runtime
except Exception:  # noqa: BLE001 - emotion is an add-on; its absence must not stop the call
    _build_emotion_runtime = None

for name in (".env",):
    home = os.environ.get("ALIVE_HOME") or str(Path.home() / ".alive")
    env_file = Path(home) / name
    if env_file.exists():
        load_dotenv(env_file, override=False)
        break

AGENT_NAME = os.getenv("AGENT_NAME", "alive-voice").strip() or "alive-voice"
VOICE_URL = os.getenv("ALIVE_VOICE_URL", "http://127.0.0.1:8766").rstrip("/")

# 让 qwen 在「查机器/显卡」时确实 emit tool_call，而且**同一条回复里带过渡语**。
# 两条措辞都是实测选出来的（probe_toolcall4.py，每格 n=10）：
#  · 加 reasoning_effort="none" 关掉 thinking 后，原指令会退化成「只调工具不吭声」，
#    于是工具后台跑的那十几秒里用户一个字都听不到 —— 过渡语必须和 tool_call 同轮产出。
#  · 指令改成「这一轮必须同时做两件事：先写半句接话 + 调用工具」后，
#    tool_call 10/10、工具+正文 10/10、首正文中位 204ms（原指令 0/10 带正文）。
_TOOL_GUIDE = (
    "\n\n[工具使用 · 硬性规则] 只要用户提到查机器、显卡/GPU 忙不忙、算力、显存、磁盘、"
    "「帮我跑个任务/派个活」，你这一轮回复必须**同时**做两件事：\n"
    "1) 先写**半句到一句**口语化的接话（例如「哦好，我看一眼哈」），不要写空；\n"
    "2) 并在这同一条回复里调用 inspect_machine 工具。\n"
    "两件事必须在同一条回复内一起完成——先说话再调用，不要只调用不吭声，"
    "也不要只说「我看看」「查不了」「工具没接上」而不用工具。"
    "调用时 what 参数**只填一个短词**（gpu / disk / all 之一），绝对不要复述用户的话——"
    "参数每多写一个字，用户就多等一帧才听到你的接话。"
    "工具立刻返回即时读数（约 0.05s），不会让你等；完整结果由后台十几秒后自动播报。"
    "你说完那一两句之后就让用户继续说，不要加「请稍等」这类干等的话。"
    "当用户问心情、状态、今天感觉怎么样时，必须调用 report_mood，把工具返回的原话念出来，"
    "不许换成「还行」「挺好的」这种通用句。"
)

# ---------------------------------------------------------------------------
# Step3-P3 (t_e61fc3ac)：LLM 首字长尾「快速失败 + 降级过渡语」
# ---------------------------------------------------------------------------
# 根因：框架的 LLMStream._main_task 每次 attempt 内跑整条 _run()，上游 LM Studio
# 单次 `Request timed out` 会静默挂 ~16s 才抛错、再 retry in 0.1s；用户 19.61s
# 听不到一个字（[latency] LLMMetrics ttft=16.3196s）。抢跑/PREFLIGHT 省的是 0.3s，
# 挡不住稳态的单次上游超时。这里在 llm_node 接缝上加一道**独立于框架内部重试**的
# 墙钟看门狗：
#   * 首 chunk 在 cap 内到达 → 逐字节原样转发，正常轮零回归（不碰 gate/闸/上游）。
#   * cap 超时 → 立即取消挂死 stream（不等 16s、不静默重试），先 yield 一句真话
#     作为**独立 segment**（FlushSentinel 切段，TTS 立刻播出，首字 <2.5s），随后
#     重新发起一次有界请求，把工具读数与完整回答在后续 segment 照常播报——
#     assistant_texts 不会被砍成只有过渡语。
# 只改 LLM 调用路径与降级分支：不动 LLM_MODEL / reasoning_effort / sherpa /
# VoxCPM / 人格正本 / latency_e2e.py 的 V1–V3 闸体。
def _clamp_timeout(v) -> float:
    # 默认 ≤2s；配置也不许塞到 120s 那种「堵住真死」，下限防 0 立即降级。
    return max(0.5, min(float(v), 5.0))


# LLM 调用超时上限：可配置常量，默认 1.5s（卡面要求默认 ≤2s）。
#
# 为什么是 1.5 而不是卡面上限 2.0：首字口径是 e2e = STT 终句(~0.4s) +
# 本 cap + 过渡语 TTS ttfb(~0.1s) + 管线(~0.3s) ≈ cap + 0.8s。实测 cap=2.0
# 时注入轮 e2e=2.76s > 卡面 <2.5s；cap=1.5 实测 2.301s。稳态 ttft 实测
# 0.21–0.92s，1.5s 对健康轮仍有余量，不误降级（见 t_e61fc3ac/REPORT.md）。
LLM_TTFT_TIMEOUT_S = _clamp_timeout(os.getenv("ALIVE_LLM_TTFT_TIMEOUT_S", "1.5"))
# 降级过渡语：一句真话（确实卡住了），不是编造的领域读数。
LLM_DEGRADE_PHRASE = os.getenv("ALIVE_LLM_DEGRADE_PHRASE", "我卡了一下，等半秒")
LLM_STILL_STALLED_PHRASE = os.getenv(
    "ALIVE_LLM_STILL_STALLED_PHRASE", "还没缓过来，我先把查到的报给你")

# 可控注入（mock，仅本机验收用）：一次性控制文件，由 harness driver 在该组
# harness 启动前写入、worker 在 llm_node 入口读一次即消费（unlink）。文件不存在
# 时 = 生产默认（hold_s=0 / fast_fail=True），行为与现状逐字节一致。
#   {"hold_s": 16.0, "fast_fail": true}   -> 挂住单次 LLM 请求 16s，走降级
#   {"hold_s": 16.0, "fast_fail": false}  -> 复现修复前的 19s 长尾（A/B 对照）
# hold 发生在**客户端 LLM 调用路径内**（pump 转发首 chunk 前 sleep），LM Studio
# 全程只收到 1 个正常快请求，绝不被拖垮；不改上游、不重启/替换 LM Studio。
def _fault_paths():
    seen = set()
    for p in (
        os.getenv("ALIVE_VOICE_P3_FAULT_FILE"),
        "/logs/.p3_llm_fault.json",
        os.path.join(os.path.expanduser("~"), ".alive", "logs", ".p3_llm_fault.json"),
    ):
        if p and p not in seen:
            seen.add(p)
            yield p


def _read_fault() -> dict:
    for p in _fault_paths():
        try:
            if not os.path.isfile(p):
                continue
            data = json.loads(Path(p).read_text(encoding="utf-8") or "{}")
            # persist=True：本组 harness 的每一次 attempt 都注入（V1 作废重跑时不被
            # one-shot 消费掉）；driver 在该组结束后显式删除文件，不留下地雷。
            if not bool(data.get("persist", False)):
                try:
                    os.unlink(p)  # one-shot：只影响该组 harness 的第一轮 LLM 生成
                except OSError:
                    pass
            return {
                "hold_s": max(0.0, float(data.get("hold_s", 0.0))),
                "fast_fail": bool(data.get("fast_fail", True)),
                # 可选：单组覆盖首字看门狗上限，用于不重建镜像的实测标定；
                # 缺省 None = 用模块级生产默认 LLM_TTFT_TIMEOUT_S。
                "cap_s": (None if data.get("cap_s") is None
                          else _clamp_timeout(data["cap_s"])),
            }
        except (OSError, ValueError, TypeError, AttributeError, KeyError):
            continue
    return {"hold_s": 0.0, "fast_fail": True, "cap_s": None}


def _log_latency(kind: str, **fields: object) -> None:
    # 与 _on_metrics 同格式，供 harness / 报告从 agent.log 抽 [latency] 行。
    rec = {"kind": kind, "wall": round(time.time(), 4)}
    rec.update(fields)
    print("[latency] " + json.dumps(rec, ensure_ascii=False), flush=True)


async def _pump_to_queue(gen, q, END, hold_s, log) -> None:
    """把一次 llm_node 迭代灌进队列；hold_s>0 时把单次 LLM 请求的**首 chunk**挂住。

    hold 发生在 gen 已经开始迭代（LLM 请求已发出、上游已正常秒回）之后、首 chunk
    转发给用户之前 —— 这样「单次 LLM 请求被挂 >10s」是可控的客户端 mock，用户侧
    死寂与真上游超时逐字节同构，而 LM Studio 全程只收到正常快请求、绝不被拖垮。
    """
    try:
        held = False
        async for chunk in gen:
            if hold_s > 0 and not held:
                held = True
                log("LLMInjectHold", event="start", hold_s=hold_s)
                await asyncio.sleep(hold_s)
                log("LLMInjectHold", event="end", hold_s=hold_s)
            q.put_nowait(("chunk", chunk))
    except asyncio.CancelledError:
        raise
    except BaseException as exc:  # noqa: BLE001 - 把真实异常交给生成管线
        q.put_nowait(("error", exc))
    finally:
        q.put_nowait(("end", END))


async def _fastfail_llm_chunks(make_iter, *, cap_s, hold_s, fast_fail, phrase,
                               still_phrase, log, reissue_cap_s=None):
    """带首 chunk 墙钟看门狗的 LLM 生成。正常轮原样转发；超时走降级过渡语。

    重发请求用更宽松但仍有界的 reissue_cap_s：此刻过渡语已经播出，用户不再
    处于死寂，若仍套首字 cap 会把「LM Studio 偶发 ttft=1.9s 但能给出完整回答」
    误判成二次卡死，砍成只有过渡语（违反卡面「工具读数仍要播报」）。
    """
    import contextlib

    if reissue_cap_s is None:
        reissue_cap_s = min(5.0, max(cap_s * 3.0, 2.0))

    for attempt in (0, 1):
        h = hold_s if attempt == 0 else 0.0
        attempt_cap = cap_s if attempt == 0 else reissue_cap_s
        watch = fast_fail  # 两次 attempt 都受有界墙钟约束，绝不回到 16s 静默重试
        gen = make_iter()
        q: asyncio.Queue = asyncio.Queue()
        END = object()
        task = asyncio.create_task(_pump_to_queue(gen, q, END, h, log))
        try:
            if watch:
                try:
                    first = await asyncio.wait_for(q.get(), timeout=attempt_cap)
                except asyncio.TimeoutError:
                    task.cancel()  # 立即放弃挂死的 stream，不等 16s、不静默重试
                    if attempt == 0:
                        log("LLMDegrade", event="fast_fail", cap_s=cap_s, phrase=phrase)
                        yield phrase
                        yield FlushSentinel()  # 独立 segment，过渡语立刻播出
                        continue               # 重发一次有界请求，后续 segment 播报读数
                    log("LLMDegrade", event="reissue_stalled", cap_s=reissue_cap_s,
                        phrase=still_phrase)
                    yield still_phrase
                    return
            else:
                first = await q.get()  # A/B 对照：无看门狗，复现修复前长尾

            if first[0] == "error":
                raise first[1]
            if first[0] == "end":
                return
            yield first[1]
            while True:
                kind, payload = await q.get()
                if kind == "end":
                    break
                if kind == "error":
                    raise payload
                yield payload
            return
        finally:
            if not task.done():
                task.cancel()
            with contextlib.suppress(BaseException):
                await task
            with contextlib.suppress(BaseException):
                await gen.aclose()

# ---------------------------------------------------------------------------
# 预热与共享单例（进程启动期，不在 job 的 event loop 上）
# ---------------------------------------------------------------------------
_HTTP: httpx.AsyncClient | None = None
_PROMPT_CACHE: str | None = None
_MODELS: dict = {}
_WARMED = False

SHERPA_WS_URL = os.getenv("SHERPA_WS_URL", "").strip()
# PREFLIGHT 抢跑：默认关，且实测无效，勿启用。t_65f84c9c 结论：
# preflight 发的是增长中的稳定前缀，末字「状态」只在 P0 flush 后才出现，
# 任何 pre-flush 前缀都过不了 LiveKit _transcripts_equivalent(前缀, FINAL)，
# 抢跑生成恒被作废重建 → LLM 起点在 commit 之后，与判停窗口重叠实测 0.000s。
# 逐项证据见 var/voice-evidence/t_65f84c9c/REPORT.md；门禁见
# alive/voice/test_step3_preflight.py。放开 V1–V3 闸体是明令禁止的。
ENABLE_PREFLIGHT = os.getenv("SHERPA_PREFLIGHT", "0").strip() == "1"
WARM_LLM = os.getenv("ALIVE_WARM_LLM", "1").strip() == "1"


def _fetch_prompt_sync() -> str:
    """启动期同步取人格（此时没有 event loop，不构成阻塞告警）。"""
    persona = (os.getenv("ALIVE_PERSONA") or "").strip()
    url = f"{VOICE_URL}/api/prompt"
    if persona:
        url = f"{url}?persona={persona}"
    try:
        r = httpx.get(url, timeout=5.0, trust_env=False)
        r.raise_for_status()
        text = r.text.strip()
        if text:
            return text
    except Exception as exc:
        print(f"[alive-agent] prompt prefetch failed: {exc!r}", flush=True)
    name = persona or "角色"
    return f"你是{name}。这是一通实时语音电话。用「我」短句说话。不要说你是 AI。"


async def _fetch_prompt() -> str:
    """job 内取人格：把同步 httpx 丢进线程池（`to_thread`），不上 event loop。

    THREAD executor 每个 job 一个 event loop，共享 AsyncClient 会撞 "attached to a
    different loop"；`to_thread` 既保持每轮取到最新人格，又让 105–145ms 的
    socket/SSL 同步工作不阻塞音频与 turn handling。失败时回退启动期缓存。
    """
    global _PROMPT_CACHE
    try:
        text = await asyncio.to_thread(_fetch_prompt_sync)
        _PROMPT_CACHE = text
        return text
    except Exception as exc:
        print(f"[alive-agent] prompt fetch failed: {exc!r}", flush=True)
    if _PROMPT_CACHE:
        return _PROMPT_CACHE
    name = os.getenv("ALIVE_PERSONA", "角色")
    return f"你是{name}。这是一通实时语音电话。用「我」短句说话。不要说你是 AI。"


def _build_stt():
    # Step2：只要配了 SHERPA_WS_URL 就走 Docker/CPU 流式 STT；
    # 否则完全沿用原有 speaches 批式 / cartesia 分支（回退路径，未删除）。
    if SHERPA_WS_URL:
        from sherpa_stream_stt import SherpaStreamSTT
        return SherpaStreamSTT(ws_url=SHERPA_WS_URL)
    provider = (os.getenv("STT_PROVIDER") or "").strip().lower()
    cartesia_key = (os.getenv("CARTESIA_API_KEY") or "").strip()
    if provider == "cartesia" or (not provider and cartesia_key):
        from livekit.plugins import cartesia

        return cartesia.STT(
            api_key=cartesia_key,
            model=os.getenv("CARTESIA_STT_MODEL", "ink-whisper"),
            language=os.getenv("CARTESIA_STT_LANGUAGE", "zh"),
        )
    api_key = (os.getenv("OPENAI_API_KEY") or os.getenv("LLM_API_KEY") or "").strip()
    return openai.STT(
        # 默认值是插件自带的 gpt-4o-mini-transcribe；自建的 OpenAI 兼容 STT（如 speaches）
        # 只有 whisper 系模型，必须用 OPENAI_STT_MODEL=whisper-1 之类的值覆盖。
        model=os.getenv("OPENAI_STT_MODEL") or "gpt-4o-mini-transcribe",
        api_key=api_key or None,
        base_url=os.getenv("OPENAI_STT_BASE") or os.getenv("LLM_API_BASE") or None,
        language=os.getenv("STT_LANGUAGE", "zh"),
    )


def _build_llm():
    # reasoning_effort="none" is the single biggest latency win: qwen3.8-27b otherwise
    # emits 84-298 characters of reasoning before the first spoken token, which the
    # voice pipeline pays as dead air (measured 1.4-5.9s -> 0.16-0.30s). The livekit
    # openai plugin forwards it as a real request field, so the server honours it.
    # chat_template_kwargs.enable_thinking=false and a "/no_think" prefix both measured
    # ineffective against this server and are deliberately not used.
    return openai.LLM(
        model=os.getenv("LLM_MODEL") or "gpt-4o-mini",
        api_key=os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY"),
        base_url=os.getenv("LLM_API_BASE") or None,
        temperature=0.8,
        reasoning_effort=os.getenv("LLM_REASONING_EFFORT", "none"),  # type: ignore[arg-type]
    )


def _build_tts(control_provider=None):
    provider = (os.getenv("TTS_PROVIDER") or "voxcpm").strip().lower()
    if provider == "openai":
        return openai.TTS(
            api_key=os.getenv("OPENAI_API_KEY") or os.getenv("LLM_API_KEY"),
            base_url=os.getenv("LLM_API_BASE") or None,
            voice=os.getenv("OPENAI_TTS_VOICE", "alloy"),
        )
    from voxcpm_tts import VoxCPMHttpTTS

    return VoxCPMHttpTTS(control_provider=control_provider)


def _build_models() -> dict:
    """构造 STT/LLM 单例：把 httpx2 的 SSL context 构造挪出 event loop。

    注意：TTS 不入单例。`VoxCPMHttpTTS._ensure_session()` 会把 aiohttp session
    绑到首个 job 的 event loop；THREAD executor 每个 job 各自一个 loop，复用会
    撞 "Event loop is closed"。TTS 构造函数本身不建 HTTP client（惰性），
    每轮新建既零成本又保持原语义。
    """
    global _MODELS
    if not _MODELS:
        _MODELS = {"stt": _build_stt(), "llm": _build_llm()}
        _build_tts()  # 启动期构造一次仅作导入/SSL 预热，不作为共享实例
    return _MODELS


def _warm_llm(prompt: str) -> None:
    """启动期发一次真实 completion，让 LM Studio 编译人格 prompt 的 KV cache。

    冷启动首轮 ttft=1.44s 的根因是 LM Studio 首次加载/编译长人格 prompt；
    预热后首轮应回到稳态 ~0.2s。失败只告警，不影响 worker 起。
    """
    base = os.getenv("LLM_API_BASE")
    if not WARM_LLM or not base:
        return
    url = f"{base.rstrip('/')}/chat/completions"
    payload = {
        "model": os.getenv("LLM_MODEL") or "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": prompt + _TOOL_GUIDE},
            {"role": "user", "content": "你好"},
        ],
        "max_tokens": 1,
        "temperature": 0.0,
        "reasoning_effort": "none",
        "stream": False,
    }
    try:
        t0 = time.perf_counter()
        r = httpx.post(url, json=payload, timeout=30.0, trust_env=False)
        print(f"[alive-agent] LLM warmup http={r.status_code} "
              f"{time.perf_counter()-t0:.2f}s", flush=True)
    except Exception as exc:
        print(f"[alive-agent] LLM warmup failed: {exc!r}", flush=True)


def _prewarm_ffi() -> None:
    """启动期构造一个一次性 APM，把 FFI client 的一次性初始化挪出 event loop。

    APM 本身保持每 session 新建（不改语义），只是 FFI 已热，避免 105ms 首建阻塞。
    """
    try:
        import livekit.rtc as rtc
        apm = rtc.AudioProcessingModule(auto_gain_control=True)
        del apm
        gc.collect()
    except Exception as exc:
        print(f"[alive-agent] APM prewarm failed: {exc!r}", flush=True)


def _prewarm() -> None:
    """进程/线程启动期执行（此时没有 job event loop）。幂等。"""
    global _PROMPT_CACHE, _WARMED
    if _WARMED:
        return
    if _PROMPT_CACHE is None:
        _PROMPT_CACHE = _fetch_prompt_sync()
    _build_models()          # httpx2 SSL context 在这里构造，不再落在 entrypoint 的 loop 上
    _prewarm_ffi()           # FFI 一次性初始化，不落在 session.start 的 loop 上
    _warm_llm(_PROMPT_CACHE) # LM Studio prompt cache 编译
    try:
        gc.freeze()           # 已热对象进永久代，削减通话期 GC 停顿（145ms 那次 gc_time=0.134）
    except Exception:
        pass
    _WARMED = True
    print(f"[alive-agent] prewarm done: stt={SHERPA_WS_URL or 'batch'} "
          f"prompt_chars={len(_PROMPT_CACHE)} preflight={ENABLE_PREFLIGHT}", flush=True)


def _setup_fnc(proc) -> None:
    """AgentServer.setup_fnc：job executor 初始化时（无 event loop）再保底预热一次。"""
    _prewarm()


try:
    from energy_vad import EnergyVAD
    _has_energy_vad = True
except Exception:
    _has_energy_vad = False


def _install_wide_accepted_sources_patch() -> None:
    """放宽 _ParticipantAudioInputStream 接收源，避免部分客户端 SOURCE_UNKNOWN 丢音频帧"""
    try:
        from livekit.agents.voice.room_io import _input as _input_mod
        import livekit.rtc as rtc
        if getattr(_input_mod._ParticipantAudioInputStream.__init__, "_wide_sources_patched", False):
            return

        def wide_init(self, room, *, sample_rate, num_channels, noise_cancellation,
                      auto_gain_control=True, pre_connect_audio_handler=None, frame_size_ms=50):
            from livekit.agents.voice.room_io._input import _ParticipantInputStream
            from livekit.agents.voice.io import AudioInput
            _ParticipantInputStream.__init__(
                self,
                room=room,
                track_source=[
                    rtc.TrackSource.SOURCE_MICROPHONE,
                    rtc.TrackSource.SOURCE_UNKNOWN,
                ],
                processor=(
                    noise_cancellation if isinstance(noise_cancellation, rtc.FrameProcessor) else None
                ),
            )
            AudioInput.__init__(self, label="RoomIO")
            if frame_size_ms <= 0:
                raise ValueError("frame_size_ms must be greater than 0")
            self._sample_rate = sample_rate
            self._num_channels = num_channels
            self._frame_size_ms = frame_size_ms
            self._noise_cancellation = noise_cancellation
            self._pre_connect_audio_handler = pre_connect_audio_handler
            self._apm = None
            if auto_gain_control:
                # 保持每 session 一个 APM（不改语义）；FFI 已在启动期预热
                self._apm = rtc.AudioProcessingModule(auto_gain_control=True)
        wide_init._wide_sources_patched = True
        _input_mod._ParticipantAudioInputStream.__init__ = wide_init
    except Exception:
        pass


class AliveVoiceAgent(Agent):
    def __init__(self, instructions: str, emotion=None) -> None:
        vad_instance = (
            EnergyVAD(
                speech_threshold=500,
                silence_threshold=200,
                min_speech_duration=0.3,
                # Step2：真流式 STT 在判停时终句已在手上，0.5s 静音确认成了
                # 最大的固定块。收到 0.35s 连续无声即判停，省约 0.15s。
                # 与 latency_e2e.py 的触发音频预检共用 ALIVE_VAD_MIN_SILENCE：
                # 两处各自硬编码会漂移（漂移时 0.35~0.5s 句中停顿被切两轮）。
                # V1 单轮 commit 由 harness 实测把关。
                min_silence_duration=float(os.getenv("ALIVE_VAD_MIN_SILENCE", "0.35")),
            )
            if _has_energy_vad
            else silero.VAD.load()
        )
        models = _build_models()
        # Emotion is read here (in-memory snapshot closure) so the synth path pays one
        # attribute read per request and never an await, a lock, or a file stat.
        control_provider = (emotion.control_for_speech if emotion is not None else None)
        super().__init__(
            instructions=instructions + _TOOL_GUIDE,
            tools=[inspect_machine, report_mood],
            stt=models["stt"],
            llm=models["llm"],
            tts=_build_tts(control_provider),   # 每轮新建，避免 aiohttp session 跨 event loop
            vad=vad_instance,
        )

    async def llm_node(self, chat_ctx, tools, model_settings):
        """Step3-P3：首 chunk 墙钟看门狗 + 快速失败降级过渡语。

        正常轮（首 chunk 在 LLM_TTFT_TIMEOUT_S 内到达）逐 chunk 原样转发，代码路径
        与 Agent.default.llm_node 完全一致，零回归。单次上游超时时立即 yield 真话
        过渡语并切段播出，再重发一次有界请求把工具读数/完整回答补在后续 segment。
        """
        fault = _read_fault()
        cap_s = fault["cap_s"] or LLM_TTFT_TIMEOUT_S
        # 零参 super() 依赖当前帧第一个参数，嵌套函数里没有 self —— 显式绑定后
        # 再收进闭包，降级重发时才能拿到一条全新的 LLM 请求（async generator）。
        base_llm_node = super().llm_node

        def _make_iter():
            return base_llm_node(chat_ctx, tools, model_settings)

        async for item in _fastfail_llm_chunks(
            _make_iter,
            cap_s=cap_s,
            hold_s=fault["hold_s"],
            fast_fail=fault["fast_fail"],
            phrase=LLM_DEGRADE_PHRASE,
            still_phrase=LLM_STILL_STALLED_PHRASE,
            log=_log_latency,
        ):
            yield item


server = AgentServer(
    job_executor_type=JobExecutorType.THREAD,
    initialize_process_timeout=90.0,
    port=int(os.getenv("LIVEKIT_WORKER_PORT", "8081")),
    setup_fnc=_setup_fnc,
)


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    _install_wide_accepted_sources_patch()
    await ctx.connect()
    instructions = await _fetch_prompt()   # async：不再同步阻塞 event loop
    print(f"[alive-agent] prompt chars={len(instructions)} room={ctx.room.name}", flush=True)
    session = AgentSession(
        turn_handling={
            "interruption": {"enabled": True},
            "preemptive_generation": {"enabled": ENABLE_PREFLIGHT},
        }
    )

    # 分段延迟打点：ttfb/ttft 是框架自己量的，不是估算。写进 agent.log 供 harness 抽取，
    # 也让「每格数字来自日志时间戳」这条验收要求有据可查（卡面 invariant #3）。
    def _on_metrics(event) -> None:
        m = getattr(event, "metrics", event)  # MetricsCollectedEvent 是包装层
        fields: dict[str, object] = {"kind": type(m).__name__}
        for name in ("timestamp", "ttfb", "ttft", "duration", "audio_duration",
                     "characters_count", "completion_tokens", "prompt_tokens",
                     "end_of_utterance_delay", "transcription_delay", "cancelled",
                     "speech_id"):
            value = getattr(m, name, None)
            if value is not None:
                fields[name] = round(value, 4) if isinstance(value, float) else value
        # 指标自带 timestamp 是「本段结束时刻」的 monotonic 时钟，无法与客户端录音对齐；
        # 补一个墙钟才能把「TTS 首块生成」与「客户端真的听到」拆开（playout 段）。
        fields["wall"] = round(time.time(), 4)
        print("[latency] " + json.dumps(fields, ensure_ascii=False), flush=True)

    session.on("metrics_collected", _on_metrics)

    # --- emotion: state source + acoustic channel ---------------------------
    # Constructed per job (per call) from ALIVE_PERSONA, so three VUPs on the same
    # worker never share a state object. control_for_speech() is the only thing the
    # TTS path touches, and it is an attribute read on a plain string.
    emotion = None
    if _build_emotion_runtime is not None:
        try:
            emotion = _build_emotion_runtime()
        except Exception as exc:  # noqa: BLE001
            print(f"[emotion] init failed: {exc!r}", flush=True)

    if emotion is not None:
        def _on_transcript(ev) -> None:
            # `user_input_transcribed` also fires with is_final=False for interim
            # results; only the final text is evidence of what the user meant.
            if not getattr(ev, "is_final", True):
                return
            text = getattr(ev, "transcript", "") or ""
            try:
                emotion.observe_transcript(text)   # pure CPU, ~µs, no I/O
            except Exception as exc:  # noqa: BLE001
                print(f"[emotion] observe failed: {exc!r}", flush=True)

        session.on("user_input_transcribed", _on_transcript)
        emotion.start_writer()

    await session.start(agent=AliveVoiceAgent(instructions, emotion), room=ctx.room)


def main() -> None:
    _prewarm()
    cli.run_app(server)


if __name__ == "__main__":
    main()
