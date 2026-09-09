#!/usr/bin/env python3
"""Alive LiveKit worker: STT → 人格 LLM → VoxCPM TTS."""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx
from dotenv import load_dotenv
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, JobExecutorType, cli
from livekit.plugins import openai, silero

for name in (".env",):
    home = os.environ.get("ALIVE_HOME") or str(Path.home() / ".alive")
    env_file = Path(home) / name
    if env_file.exists():
        load_dotenv(env_file, override=False)
        break

AGENT_NAME = os.getenv("AGENT_NAME", "alive-voice").strip() or "alive-voice"
VOICE_URL = os.getenv("ALIVE_VOICE_URL", "http://127.0.0.1:8766").rstrip("/")


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
        api_key=api_key or None,
        base_url=os.getenv("OPENAI_STT_BASE") or os.getenv("LLM_API_BASE") or None,
        language=os.getenv("STT_LANGUAGE", "zh"),
    )


def _build_llm():
    return openai.LLM(
        model=os.getenv("LLM_MODEL") or "gpt-4o-mini",
        api_key=os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY"),
        base_url=os.getenv("LLM_API_BASE") or None,
        temperature=0.8,
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
            instructions=instructions,
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
    await session.start(agent=AliveVoiceAgent(instructions), room=ctx.room)


def main() -> None:
    cli.run_app(server)


if __name__ == "__main__":
    main()
