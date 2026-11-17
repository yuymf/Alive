#!/usr/bin/env python3
"""Step1-B 真实通话录制（可复跑）：边聊边干 + 打断只掐嘴不掐活。

两条对照（同一份 agent、同一句触发话术）：
  --mode no_interrupt   推一句触发话术后就不再推音频，录到后台结果播报完。
  --mode with_interrupt 在 --interrupt-at 秒推第二段用户语音（真打断），
                        之后静音，录到「打断 → 静音 → 若干秒后主动播报结果」。

流程：TTS 合成用户话 → LiveKit 建房/dispatch → 推麦克风 → 订阅 agent 音轨
     → 落 wav + 打带时间戳的事件日志（工具 BG_START/BG_DONE 从 agent.log 抓）。

用法（复用 Step1-A 已起的三件套）：
  VOICE_E2E_DIR=<录落盘目录> .venv-voice/bin/python alive/voice/test_e2e_step1b.py \
      --mode with_interrupt --interrupt-at 3.0 --out with_interrupt.wav
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
from livekit import rtc

CALLER_ID = "e2e-step1b"
# 触发话术：必须让 qwen emit tool_call（POC 已证 "查GPU和磁盘状态" 会触发）
TRIGGER_TEXT = "帮我查一下这台机器的显卡现在忙不忙，顺便看看磁盘状态"
# 打断话术：一句能被 VAD 判为 start_of_speech 的用户插话
INTERRUPT_TEXT = "等等，先别说这个，我插一句"


def wav_bytes(pcm: np.ndarray, sr: int) -> bytes:
    import io
    import wave
    assert pcm.dtype == np.int16 and pcm.ndim == 1
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


async def synth(pcm_url: str, text: str) -> np.ndarray:
    import aiohttp
    async with aiohttp.ClientSession() as s:
        async with s.post(
            f"{pcm_url}/v1/audio/speech",
            json={"input": text, "voice": "default", "response_format": "pcm"},
            timeout=aiohttp.ClientTimeout(total=900),
        ) as r:
            body = await r.read()
            print(f"[tts] {text[:20]!r} → http={r.status} bytes={len(body)}", flush=True)
            if r.status != 200:
                raise SystemExit(f"TTS 失败: {r.status} {body[:200]!r}")
    return np.frombuffer(body, dtype=np.int16).copy()


def to_48k(pcm24: np.ndarray) -> np.ndarray:
    x = pcm24.astype(np.float32) / 32768.0
    y = soxr.resample(x, 24000, 48000, quality="HQ")
    return np.clip(np.rint(y * 32768.0), -32768, 32767).astype(np.int16)


def _compress_intervals(times: list[float], gap: float = 2.5) -> list[list[float]]:
    """把逐帧 voiced 时刻压成「说话轮次」。

    gap 取 2.5s 是刻意的：假流式 TTS 会把一句话拆成多个 chunk，chunk 间只有
    0.3~0.5s 静音；只有 ≥2.5s 的静音才代表「一轮说完、下一轮还在合成」。
    这样过渡语不会被误拆成两段，early-stop 判据才能区分过渡语 vs 结果播报。
    """
    intervals: list[list[float]] = []
    for t in times:
        if intervals and t - intervals[-1][1] <= gap:
            intervals[-1][1] = t
        else:
            intervals.append([t, t])
    return intervals


async def push_pcm(source, pcm48: np.ndarray, *, t_start_wall: float,
                   timeline: list, label: str) -> None:
    """按实时节奏把 20ms 帧推进麦克风；timeline 记真实推流时刻。"""
    step = 960
    t0 = time.perf_counter()
    timeline.append({"t": round(time.time() - t_start_wall, 3), "ev": f"PUSH_START:{label}"})
    for i in range(0, len(pcm48), step):
        chunk = pcm48[i : i + step]
        if chunk.size < step:
            chunk = np.pad(chunk, (0, step - chunk.size))
        await source.capture_frame(
            rtc.AudioFrame(
                data=chunk.tobytes(), sample_rate=48000, num_channels=1,
                samples_per_channel=step,
            )
        )
        target = t0 + (i + step) / 48000
        delay = target - time.perf_counter()
        if delay > 0:
            await asyncio.sleep(delay)
    timeline.append({"t": round(time.time() - t_start_wall, 3), "ev": f"PUSH_END:{label}"})


async def record_call(cfg, trigger48: np.ndarray, interrupt48: np.ndarray) -> tuple[np.ndarray, dict]:
    from livekit import api, rtc

    t_start_wall = time.time()
    timeline: list = []
    room_name = f"step1b-{cfg.mode}-{uuid.uuid4().hex[:8]}"
    http_url = cfg.livekit_url.replace("ws://", "http://").replace("wss://", "https://")

    lk = api.LiveKitAPI(url=http_url, api_key=cfg.api_key, api_secret=cfg.api_secret)
    await lk.room.create_room(api.CreateRoomRequest(name=room_name))
    disp = await lk.agent_dispatch.create_dispatch(
        api.CreateAgentDispatchRequest(room=room_name, agent_name=cfg.agent_name)
    )
    timeline.append({"t": round(time.time() - t_start_wall, 3), "ev": "DISPATCH"})
    print(f"[call] room={room_name} dispatch={disp.id} mode={cfg.mode}", flush=True)
    await lk.aclose()

    token = (
        api.AccessToken(cfg.api_key, cfg.api_secret)
        .with_identity(CALLER_ID).with_name(CALLER_ID)
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )

    recorded: list[np.ndarray] = []
    voiced_windows: list = []  # 记录每段 agent 说话（用于区分过渡语 / 结果播报）
    state = {"last_voice": 0.0}
    agent_track = asyncio.Event()
    first_voice_evt = asyncio.Event()  # agent 首次开口（打断锚点，避开首帧抖动）
    room = rtc.Room()

    @room.on("track_subscribed")
    def _sub(track, publication, participant):
        if track.kind != rtc.TrackKind.KIND_AUDIO or participant.identity == CALLER_ID:
            return
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
                rms = float(np.sqrt(np.mean(arr.astype(np.float64) ** 2)))
                now = time.time() - t_start_wall
                if rms > 50:
                    state["last_voice"] = now
                    voiced_windows.append(round(now, 3))
                    if not first_voice_evt.is_set():
                        first_voice_evt.set()
                        timeline.append({"t": round(now, 3), "ev": "AGENT_FIRST_VOICE"})
        finally:
            await stream.aclose()

    await room.connect(cfg.livekit_url, token)
    for ident in list(room.remote_participants.keys()):
        if ident != CALLER_ID:
            agent_track.set()  # agent 常常先进房

    source = rtc.AudioSource(48000, 1)
    mic = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(
        mic, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )

    try:
        await asyncio.wait_for(agent_track.wait(), timeout=25)
    except asyncio.TimeoutError:
        print("[call] WARN 没等到 agent 音轨，退化固定等 6s", flush=True)
        await asyncio.sleep(6)
    await asyncio.sleep(1.5)  # 让输入流挂稳（Step1-A 实测必要）

    # 主时间线：推触发话术（末尾补 1.2s 静音让 VAD end-of-turn，别拖太长）
    trigger_with_tail = np.concatenate([trigger48, np.zeros(int(48000 * 1.2), dtype=np.int16)])
    push_task = asyncio.create_task(
        push_pcm(source, trigger_with_tail, t_start_wall=t_start_wall,
                 timeline=timeline, label="trigger")
    )

    # 打断版：等 agent 首次开口（过渡语），再 +N 秒推第二段用户语音打断。
    # 锚在「首次开口」而非 DISPATCH，才能鲁棒于假流式首帧延迟；+N 要越过
    # AEC warmup（进房后前 3s 禁用打断），实测落在过渡语播放窗内。
    if cfg.mode == "with_interrupt":
        async def _interrupt_after_voice() -> None:
            await first_voice_evt.wait()
            await asyncio.sleep(cfg.interrupt_after_voice)
            timeline.append({"t": round(time.time() - t_start_wall, 3),
                             "ev": f"INTERRUPT_FIRE@first_voice+{cfg.interrupt_after_voice}s"})
            print(f"[call] >>> 打断：推入插话 {INTERRUPT_TEXT!r}", flush=True)
            tail = np.zeros(int(48000 * 0.8), dtype=np.int16)
            await push_pcm(source, np.concatenate([interrupt48, tail]),
                           t_start_wall=t_start_wall, timeline=timeline, label="interrupt")
        asyncio.create_task(_interrupt_after_voice())

    await push_task

    # 录制窗口固定录满，不提前收尾：结果播报要等当前 turn 播完才 say，
    # 再经假流式 TTS 整段合成，任何「两段语音即收」的 early-stop 都可能把
    # 打断后的短应答（如「嗯，你说」0.8s）误判为结果播报而提前 disconnect。
    # 固定窗口让两条录制对称、可复跑，波形里「打断→静音→结果播报」完整保留。
    await asyncio.sleep(cfg.record_seconds)
    timeline.append({"t": round(time.time() - t_start_wall, 3), "ev": "RECORD_END"})

    await source.aclose()
    await room.disconnect()
    pcm = np.concatenate(recorded) if recorded else np.zeros(0, dtype=np.int16)
    intervals = _compress_intervals(voiced_windows)
    talk = [{"start": a, "end": round(b, 3)} for a, b in intervals if b - a > 0.15]
    return pcm, {"timeline": timeline, "agent_talk_intervals": talk, "room": room_name}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--voxcpm-url", default=os.environ.get("VOXCPM_URL", "http://127.0.0.1:8801"))
    p.add_argument("--livekit-url", default=os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880"))
    p.add_argument("--api-key", default=os.environ.get("LIVEKIT_API_KEY", "devkey"))
    p.add_argument("--api-secret", default=os.environ.get("LIVEKIT_API_SECRET", "secret"))
    p.add_argument("--agent-name", default=os.environ.get("AGENT_NAME", "alive-voice"))
    p.add_argument("--mode", choices=["no_interrupt", "with_interrupt"], required=True)
    p.add_argument("--interrupt-after-voice", type=float, default=3.2,
                   help="agent 首次开口后多少秒推打断语音（避开 AEC warmup + 落在过渡语窗内）")
    p.add_argument("--record-seconds", type=float, default=90.0,
                   help="固定录制窗口（过渡语假流式 13s + 15s 后台活 + 打断轮次 + 结果播报合成 ~9s + 余量）")
    p.add_argument("--out", required=True)
    cfg = p.parse_args()

    workdir = Path(os.environ.get("VOICE_E2E_DIR") or os.getcwd())
    workdir.mkdir(parents=True, exist_ok=True)
    out_path = workdir / cfg.out

    trigger24 = asyncio.run(synth(cfg.voxcpm_url, TRIGGER_TEXT))
    interrupt24 = asyncio.run(synth(cfg.voxcpm_url, INTERRUPT_TEXT))
    print(f"[tts] trigger={len(trigger24)/24000:.2f}s interrupt={len(interrupt24)/24000:.2f}s", flush=True)

    pcm, meta = asyncio.run(record_call(cfg, to_48k(trigger24), to_48k(interrupt24)))
    if pcm.size == 0:
        print("[rec] 没收到 agent 音频", flush=True)
        return 8

    # 只裁首尾静音，保留中间静音段（chief 要抽波形看「打断→静音→播报」）
    loud = np.nonzero(np.abs(pcm) > 50)[0]
    if loud.size:
        m = int(0.2 * 48000)
        pcm = pcm[max(0, loud[0] - m): min(pcm.size, loud[-1] + m)]
    out_path.write_bytes(wav_bytes(pcm, 48000))
    rms = float(np.sqrt(np.mean(pcm.astype(np.float64) ** 2)))
    meta.update({"mode": cfg.mode, "interrupt_after_voice": cfg.interrupt_after_voice,
                 "out": str(out_path), "seconds": round(pcm.size / 48000, 2),
                 "rms": round(rms, 1), "peak": int(np.abs(pcm).max())})
    (workdir / (Path(cfg.out).stem + ".timeline.json")).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2))
    print("[rec] " + json.dumps({k: meta[k] for k in ("mode", "out", "seconds", "rms", "peak")}, ensure_ascii=False), flush=True)
    print("[rec] agent 说话区间: " + json.dumps(meta["agent_talk_intervals"]), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
