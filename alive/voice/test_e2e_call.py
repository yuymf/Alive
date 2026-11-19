#!/usr/bin/env python3
"""Alive 全双工语音端到端验收（可复跑）。

流程（每一步都打原始响应，失败即非零退出）：
  1. TTS 侧车合成一句"用户话"（POST /v1/audio/speech，24kHz PCM）→ user.wav
  2. 这段 wav 喂 STT（speaches，OpenAI 兼容）→ 拿回中文
  3. 把识别文本喂 LLM（LM Studio qwen3.8-27b）→ 量首 token 时延
  4. LiveKit 真闭环：建房 → dispatch agent → 把 user.wav 当麦克风推上去
     → 订阅 agent 音轨 → 落 out.wav
  5. 自检 out.wav：时长 > 0.5s 且 RMS 非静音（不是全零文件）

用法：
  .venv-voice/bin/python alive/voice/test_e2e_call.py \
      --voxcpm-url http://127.0.0.1:8801 \
      --livekit-url ws://127.0.0.1:7880 \
      --stt-base http://10.89.22.4:8000/v1 \
      --llm-base http://localhost:1234/v1 \
      --out out.wav
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import soxr

CALLER_ID = "e2e-caller"
USER_TEXT = "你好，听得到吗？"


def wav_bytes(pcm: np.ndarray, sr: int) -> bytes:
    """int16 mono → WAV container (stdlib wave, no extra deps)."""
    import io
    import wave

    assert pcm.dtype == np.int16 and pcm.ndim == 1
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


async def synth(pcm_url: str, text: str) -> tuple[np.ndarray, int]:
    import aiohttp

    async with aiohttp.ClientSession() as s:
        async with s.post(
            f"{pcm_url}/v1/audio/speech",
            json={"input": text, "voice": "default", "response_format": "pcm"},
            timeout=aiohttp.ClientTimeout(total=900),
        ) as r:
            body = await r.read()
            print(f"[1] TTS POST {pcm_url}/v1/audio/speech → http={r.status} bytes={len(body)}")
            if r.status != 200:
                raise SystemExit(f"TTS 失败: {r.status} {body[:300]!r}")
    pcm = np.frombuffer(body, dtype=np.int16).copy()
    return pcm, 24000


async def transcribe(stt_base: str, wav: bytes, language: str) -> str:
    import aiohttp

    form = aiohttp.FormData()
    form.add_field("file", wav, filename="user.wav", content_type="audio/wav")
    form.add_field("model", os.environ.get("OPENAI_STT_MODEL", "whisper-1"))
    form.add_field("language", language)
    async with aiohttp.ClientSession() as s:
        async with s.post(
            f"{stt_base}/audio/transcriptions", data=form, timeout=aiohttp.ClientTimeout(total=180)
        ) as r:
            raw = await r.text()
            print(f"[2] STT POST {stt_base}/audio/transcriptions → http={r.status} body={raw[:400]}")
            if r.status != 200:
                raise SystemExit(f"STT 失败: {r.status}")
    return (json.loads(raw).get("text") or "").strip()


async def llm_first_token(llm_base: str, api_key: str, model: str, text: str) -> tuple[str, float]:
    import aiohttp

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": text}],
        "stream": True,
        "max_tokens": 64,
        "temperature": 0.7,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    t0 = time.perf_counter()
    first = None
    first_content = None
    chunks: list[str] = []
    async with aiohttp.ClientSession() as s:
        async with s.post(
            f"{llm_base}/chat/completions",
            json=payload,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=180),
        ) as r:
            if r.status != 200:
                body = await r.text()
                raise SystemExit(f"LLM 失败: {r.status} {body[:300]}")
            print(f"[3] LLM POST {llm_base}/chat/completions model={model} → http={r.status}")
            async for line in r.content:
                line = line.strip()
                if not line.startswith(b"data:"):
                    continue
                data = line[5:].strip()
                if data == b"[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                delta = (obj.get("choices") or [{}])[0].get("delta") or {}
                piece = delta.get("content") or ""
                reasoning = delta.get("reasoning_content") or delta.get("reasoning") or ""
                # qwen3.x 先在 reasoning_content 里吐 token；"首 token" 要算第一个任何字段非空的 delta，
                # 否则量到的是"首句正文"，不是首 token。
                if (piece or reasoning) and first is None:
                    first = (time.perf_counter() - t0) * 1000
                if piece:
                    if first_content is None:
                        first_content = (time.perf_counter() - t0) * 1000
                    chunks.append(piece)
                    if len("".join(chunks)) > 40:
                        break
    reply = "".join(chunks).strip()
    fc = f"{first_content:.0f}ms" if first_content is not None else "n/a"
    print(f"[3] LLM 首 token(任一 delta)={first:.0f}ms 首正文 token={fc} 回复={reply[:80]!r}")
    return reply, first or -1.0


def to_48k(pcm24: np.ndarray) -> np.ndarray:
    x = pcm24.astype(np.float32) / 32768.0
    y = soxr.resample(x, 24000, 48000, quality="HQ")
    return np.clip(np.rint(y * 32768.0), -32768, 32767).astype(np.int16)


async def livekit_roundtrip(cfg, user48: np.ndarray) -> np.ndarray:
    from livekit import api, rtc

    room_name = f"e2e-{uuid.uuid4().hex[:8]}"
    http_url = cfg.livekit_url.replace("ws://", "http://").replace("wss://", "https://")

    lk = api.LiveKitAPI(url=http_url, api_key=cfg.api_key, api_secret=cfg.api_secret)
    await lk.room.create_room(api.CreateRoomRequest(name=room_name))
    disp = await lk.agent_dispatch.create_dispatch(
        api.CreateAgentDispatchRequest(room=room_name, agent_name=cfg.agent_name)
    )
    print(f"[4] room={room_name} dispatch_id={disp.id} agent_name={cfg.agent_name}")
    await lk.aclose()

    token = (
        api.AccessToken(cfg.api_key, cfg.api_secret)
        .with_identity(CALLER_ID)
        .with_name(CALLER_ID)
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )

    recorded: list[np.ndarray] = []
    state = {"last_voice": 0.0, "voiced": 0, "agent": None}
    agent_joined = asyncio.Event()
    agent_track = asyncio.Event()

    room = rtc.Room()

    @room.on("participant_connected")
    def _joined(participant):
        if participant.identity != CALLER_ID:
            state["agent"] = participant.identity
            agent_joined.set()
            print(f"[4] agent joined: identity={participant.identity}")

    @room.on("track_subscribed")
    def _sub(track, publication, participant):
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        if participant.identity == CALLER_ID:
            return
        print(f"[4] subscribed agent audio track: {participant.identity}/{track.sid}")
        agent_track.set()
        asyncio.create_task(_consume(track))

    async def _consume(track):
        stream = rtc.AudioStream(track, sample_rate=48000, num_channels=1)
        try:
            async for ev in stream:
                arr = np.frombuffer(ev.frame.data, dtype=np.int16).copy()
                if not arr.size:
                    continue
                recorded.append(arr)
                # agent 空闲时也会发全零音频帧，只有真有声音才更新"最后说话时刻"
                if float(np.sqrt(np.mean(arr.astype(np.float64) ** 2))) > 50:
                    state["voiced"] += arr.size
                    state["last_voice"] = time.time()
        finally:
            await stream.aclose()

    await room.connect(cfg.livekit_url, token)
    print(f"[4] caller connected to {cfg.livekit_url} room={room_name}")
    # agent 常常比 caller 先进房（dispatch 走的是另一条路），此时 participant_connected 不会补发
    for ident in list(room.remote_participants.keys()):
        if ident != CALLER_ID:
            state["agent"] = ident
            agent_joined.set()
            print(f"[4] agent 已在房: identity={ident}")

    source = rtc.AudioSource(48000, 1)
    mic = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(
        mic, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )

    try:
        await asyncio.wait_for(agent_joined.wait(), timeout=45)
    except asyncio.TimeoutError:
        raise SystemExit("[4] 45s 内 agent 没进房（dispatch 没被消费？看 agent 日志）")

    # agent 已经进房 ≠ 它的麦克风输入流已挂上（session.start 之后才 attach）。
    # 等到 agent 的音频轨被订阅（= session 已起）再推话，否则头 1-2 秒语音会被整段吞掉。
    try:
        await asyncio.wait_for(agent_track.wait(), timeout=25)
        print("[4] agent 音频轨已就绪，等 1.5s 让输入流挂稳")
        await asyncio.sleep(1.5)
    except asyncio.TimeoutError:
        print("[4] 没等到 agent 音频轨，退化为固定等 6s 后推流")
        await asyncio.sleep(6)

    # 推 20ms 一帧的"麦克风"音频，按实时节奏；末尾补 3s 数字静音让 VAD 能判 end-of-speech。
    step = 960  # 20ms @48k
    pad = np.zeros(48000 * 3, dtype=np.int16)
    stream_in = np.concatenate([user48, pad])
    t0 = time.perf_counter()
    for i in range(0, len(stream_in), step):
        chunk = stream_in[i : i + step]
        if chunk.size < step:
            chunk = np.pad(chunk, (0, step - chunk.size))
        await source.capture_frame(
            rtc.AudioFrame(
                data=chunk.tobytes(),
                sample_rate=48000,
                num_channels=1,
                samples_per_channel=step,
            )
        )
        target = t0 + (i + step) / 48000
        delay = target - time.perf_counter()
        if delay > 0:
            await asyncio.sleep(delay)
    print(f"[4] 已推入 {len(user48)/48000:.2f}s 用户语音 + 3.0s 静音，开始收 agent 音频…")

    deadline = time.time() + cfg.record_timeout
    while time.time() < deadline:
        # 收到过 ≥0.1s 真人声、且随后静音超过 2.5s → agent 这一轮说完了
        if state["voiced"] > 4800 and time.time() - state["last_voice"] > 2.5:
            break
        await asyncio.sleep(0.2)
    total = sum(a.size for a in recorded) / 48000
    print(f"[4] 收到 agent 音频 {total:.2f}s（participants={list(room.remote_participants)}）")

    await source.aclose()
    await room.disconnect()
    if not recorded:
        return np.zeros(0, dtype=np.int16)
    return np.concatenate(recorded)


def trim_silence(pcm: np.ndarray, sr: int = 48000, thresh: int = 50, margin: float = 0.2) -> np.ndarray:
    """剪掉首尾静音：agent 从进房到开口这段时间录到的全零不该留在交付物里。"""
    if pcm.size == 0:
        return pcm
    loud = np.nonzero(np.abs(pcm) > thresh)[0]
    if loud.size == 0:
        return pcm
    m = int(margin * sr)
    return pcm[max(0, loud[0] - m) : min(pcm.size, loud[-1] + m)]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--voxcpm-url", default=os.environ.get("VOXCPM_URL", "http://127.0.0.1:8801"))
    p.add_argument("--livekit-url", default=os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880"))
    p.add_argument("--api-key", default=os.environ.get("LIVEKIT_API_KEY", "devkey"))
    p.add_argument("--api-secret", default=os.environ.get("LIVEKIT_API_SECRET", "secret"))
    p.add_argument("--agent-name", default=os.environ.get("AGENT_NAME", "alive-voice"))
    p.add_argument("--stt-base", default=os.environ.get("OPENAI_STT_BASE", "http://10.89.22.4:8000/v1"))
    p.add_argument("--stt-language", default=os.environ.get("STT_LANGUAGE", "zh"))
    p.add_argument("--llm-base", default=os.environ.get("LLM_API_BASE", "http://localhost:1234/v1"))
    p.add_argument("--llm-key", default=os.environ.get("LLM_API_KEY", ""))
    p.add_argument("--llm-model", default=os.environ.get("LLM_MODEL", "qwen3.8-27b"))
    p.add_argument("--text", default=USER_TEXT)
    p.add_argument("--out", default="out.wav")
    p.add_argument("--user-wav", default="user.wav")
    p.add_argument("--record-timeout", type=float, default=90.0)
    p.add_argument("--skip-services", action="store_true", help="只跑 LiveKit 闭环（复用已有 user.wav）")
    cfg = p.parse_args()

    workdir = Path(os.environ.get("VOICE_E2E_DIR") or os.getcwd())
    workdir.mkdir(parents=True, exist_ok=True)
    user_wav_path = workdir / cfg.user_wav
    out_path = workdir / cfg.out

    rc = 0
    report: dict[str, object] = {}

    if cfg.skip_services and user_wav_path.exists():
        import wave

        with wave.open(str(user_wav_path), "rb") as w:
            pcm24 = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).copy()
        print(f"[1] 复用已有 {user_wav_path} ({pcm24.size/24000:.2f}s)")
    else:
        pcm24, sr = asyncio.run(synth(cfg.voxcpm_url, cfg.text))
        report["tts_bytes"] = pcm24.size * 2
        report["tts_seconds"] = round(pcm24.size / sr, 3)
        dur = pcm24.size / sr
        expect = max(0.4, len(cfg.text) * 0.2)
        print(f"[1] TTS: {sr}Hz {dur:.2f}s；文本 {len(cfg.text)} 字，预期≈{expect:.2f}s，偏差 {abs(dur-expect)/expect*100:.1f}%")
        user_wav_path.write_bytes(wav_bytes(pcm24, sr))
        print(f"[1] 落盘 {user_wav_path}")

        text = asyncio.run(transcribe(cfg.stt_base, user_wav_path.read_bytes(), cfg.stt_language))
        report["stt_text"] = text
        if not text:
            print("[2] STT 返回空文本 ✗")
            rc |= 2
        else:
            print(f"[2] STT 识别: {text!r}")

        reply, ttft = asyncio.run(llm_first_token(cfg.llm_base, cfg.llm_key, cfg.llm_model, text or cfg.text))
        report["llm_first_token_ms"] = round(ttft, 1)
        report["llm_reply"] = reply
        if not (0 <= ttft < 1500):
            print(f"[3] LLM 首 token {ttft:.0f}ms 不达标（<1500ms）✗")
            rc |= 4

    user48 = to_48k(pcm24)
    agent_pcm = asyncio.run(livekit_roundtrip(cfg, user48))
    if agent_pcm.size == 0:
        print("[4] 没收到 agent 音频 ✗")
        return rc | 8
    raw_seconds = agent_pcm.size / 48000
    agent_pcm = trim_silence(agent_pcm)
    out_path.write_bytes(wav_bytes(agent_pcm, 48000))
    seconds = agent_pcm.size / 48000
    rms = float(np.sqrt(np.mean(agent_pcm.astype(np.float64) ** 2)))
    peak = int(np.abs(agent_pcm).max())
    report["out_wav"] = str(out_path)
    report["raw_seconds"] = round(raw_seconds, 3)
    report["out_seconds"] = round(seconds, 3)
    report["out_rms"] = round(rms, 1)
    report["out_peak"] = peak
    print(f"[5] 落盘 {out_path} 原始 {raw_seconds:.2f}s → 剪静音后 {seconds:.2f}s "
          f"RMS={rms:.1f} peak={peak} (48kHz mono s16)")

    if seconds <= 0.5 or rms < 100:
        print("[5] out.wav 不合格：时长或 RMS 不达标 ✗")
        rc |= 8

    print("REPORT " + json.dumps(report, ensure_ascii=False))
    print("RESULT " + ("PASS" if rc == 0 else f"FAIL rc={rc}"))
    return rc


if __name__ == "__main__":
    sys.exit(main())
