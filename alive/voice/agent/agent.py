#!/usr/bin/env python3
"""Alive LiveKit worker: STT → 人格 LLM → VoxCPM TTS."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx
from dotenv import load_dotenv
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, JobExecutorType, cli
from livekit.plugins import openai, silero

from work_tools import inspect_machine  # Step1-B: 真 @function_tool（后台长活与 session 解耦）

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
)


def _fetch_prompt() -> str:
    try:
        resp = httpx.get(f"{VOICE_URL}/api/prompt", timeout=5.0)
        resp.raise_for_status()
        text = resp.text.strip()
        if text:
            return text
    except Exception as exc:
        print(f"[alive-agent] prompt fetch failed: {exc!r}", flush=True)
    name = os.getenv("ALIVE_PERSONA", "角色")
    return f"你是{name}。这是一通实时语音电话。用「我」短句说话。不要说你是 AI。"


def _build_stt():
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


def _build_tts():
    provider = (os.getenv("TTS_PROVIDER") or "voxcpm").strip().lower()
    if provider == "openai":
        return openai.TTS(
            api_key=os.getenv("OPENAI_API_KEY") or os.getenv("LLM_API_KEY"),
            base_url=os.getenv("LLM_API_BASE") or None,
            voice=os.getenv("OPENAI_TTS_VOICE", "alloy"),
        )
    from voxcpm_tts import VoxCPMHttpTTS

    return VoxCPMHttpTTS()


try:
    from energy_vad import EnergyVAD
    _has_energy_vad = True
except Exception as e:
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
                self._apm = rtc.AudioProcessingModule(auto_gain_control=True)
        wide_init._wide_sources_patched = True
        _input_mod._ParticipantAudioInputStream.__init__ = wide_init
    except Exception:
        pass


class AliveVoiceAgent(Agent):
    def __init__(self, instructions: str) -> None:
        vad_instance = (
            EnergyVAD(
                speech_threshold=500,
                silence_threshold=200,
                min_speech_duration=0.3,
                min_silence_duration=0.5,
            )
            if _has_energy_vad
            else silero.VAD.load()
        )
        super().__init__(
            instructions=instructions + _TOOL_GUIDE,
            tools=[inspect_machine],
            stt=_build_stt(),
            llm=_build_llm(),
            tts=_build_tts(),
            vad=vad_instance,
        )


server = AgentServer(
    job_executor_type=JobExecutorType.THREAD,
    initialize_process_timeout=90.0,
    port=int(os.getenv("LIVEKIT_WORKER_PORT", "8081")),
)


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    _install_wide_accepted_sources_patch()
    await ctx.connect()
    instructions = _fetch_prompt()
    print(f"[alive-agent] prompt chars={len(instructions)} room={ctx.room.name}", flush=True)
    session = AgentSession(
        turn_handling={
            "interruption": {"enabled": True},
            "preemptive_generation": {"enabled": False},
        }
    )

    # 分段延迟打点：ttfb/ttft 是框架自己量的，不是估算。写进 agent.log 供 harness 抽取，
    # 也让「每格数字来自日志时间戳」这条验收要求有据可查（卡面 invariant #2）。
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
    await session.start(agent=AliveVoiceAgent(instructions), room=ctx.room)


def main() -> None:
    cli.run_app(server)


if __name__ == "__main__":
    main()
