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


class AliveVoiceAgent(Agent):
    def __init__(self, instructions: str) -> None:
        super().__init__(
            instructions=instructions,
            stt=_build_stt(),
            llm=_build_llm(),
            tts=_build_tts(),
            vad=silero.VAD.load(),
        )


server = AgentServer(
    job_executor_type=JobExecutorType.THREAD,
    initialize_process_timeout=90.0,
    port=int(os.getenv("LIVEKIT_WORKER_PORT", "8081")),
)


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    instructions = _fetch_prompt()
    print(f"[alive-agent] prompt chars={len(instructions)} room={ctx.room.name}", flush=True)
    session = AgentSession()
    await session.start(agent=AliveVoiceAgent(instructions), room=ctx.room)


def main() -> None:
    cli.run_app(server)


if __name__ == "__main__":
    main()
