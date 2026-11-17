#!/usr/bin/env python3
"""端到端首字延迟 harness（可复跑，一次进程跑 N 轮）。

口径（与卡面 invariant #1 逐字对齐）：
  t_speech_end  = 触发话术最后一个有声采样被推进麦克风的墙钟时刻
  t_first_audio = 收到 agent 音轨第一帧 rms>50 的墙钟时刻
  → 端到端首字 = t_first_audio - t_speech_end

**有效性判据（不满足则该轮作废，不计入中位数）**：
  V1. agent.log 里本轮只出现 **一次** `user turn committed`（触发话术没被 VAD 切成两轮）
  V2. 该次 commit 的 transcript 覆盖触发话术 ≥80% 字符（STT 真的听全了）
  V3. t_first_audio > t_speech_end（agent 没抢在用户说完之前开口）
  三条任一不过 → 该轮标 invalid，理由写进 json，且不参与中位数。

预检：合成出的触发音频本身若含 >0.5s 的静音谷（EnergyVAD min_silence=0.5s 会切轮），
先重渲染，最多 RENDER_TRIES 次；仍不行就如实报「触发素材本身会被切轮」。

用法：
  .venv-voice/bin/python latency_e2e.py --out-dir <dir> --tag after --runs 5
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import statistics
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import soxr
from livekit import rtc

CALLER_ID = "e2e-latency"
TRIGGER_TEXT = "帮我查一下这台机器的显卡现在忙不忙，顺便看看磁盘状态"
# 每个 worker 写自己的日志：改后版 ~/.alive/logs/agent.log，基线版 agent-baseline.log。
# 用 --agent-log 指定，默认取环境变量 ALIVE_AGENT_LOG。
AGENT_LOG = Path(os.path.expanduser(
    os.environ.get("ALIVE_AGENT_LOG") or "~/.alive/logs/agent.log"))
STT_BASE = os.environ.get("OPENAI_STT_BASE", "http://10.89.22.4:8000/v1")
STT_MODEL = os.environ.get("OPENAI_STT_MODEL", "whisper-1")
ANSI = re.compile(r"\x1b\[[0-9;]*m")

# 与 agent.py 里 EnergyVAD(...) 的参数保持一致
VAD_SILENCE_THRESHOLD = 200
VAD_MIN_SILENCE = 0.5
RENDER_TRIES = 8


def wav_bytes(pcm: np.ndarray, sr: int) -> bytes:
    import io
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


async def synth(url: str, text: str) -> np.ndarray:
    import aiohttp
    async with aiohttp.ClientSession() as s:
        async with s.post(
            f"{url}/v1/audio/speech",
            json={"input": text, "voice": "default", "response_format": "pcm"},
            timeout=aiohttp.ClientTimeout(total=900),
        ) as r:
            body = await r.read()
            if r.status != 200:
                raise SystemExit(f"TTS 失败: {r.status} {body[:200]!r}")
    return np.frombuffer(body, dtype=np.int16).copy()


def to_48k(pcm24: np.ndarray) -> np.ndarray:
    x = pcm24.astype(np.float32) / 32768.0
    y = soxr.resample(x, 24000, 48000, quality="HQ")
    return np.clip(np.rint(y * 32768.0), -32768, 32767).astype(np.int16)


def vad_split_gaps(pcm: np.ndarray, sr: int = 24000) -> list[tuple[float, float]]:
    """触发音频里会被 EnergyVAD 判成「说完了」的静音谷。"""
    n = sr * 20 // 1000
    frames = pcm[: len(pcm) // n * n].reshape(-1, n).astype(np.float64)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    below = rms < VAD_SILENCE_THRESHOLD
    gaps, start = [], None
    for i, b in enumerate(below):
        if b and start is None:
            start = i
        elif not b and start is not None:
            if (i - start) * 0.02 >= VAD_MIN_SILENCE:
                gaps.append((start * 0.02, i * 0.02))
            start = None
    if start is not None and (len(below) - start) * 0.02 >= VAD_MIN_SILENCE:
        gaps.append((start * 0.02, len(below) * 0.02))
    return gaps


def stt_wav(wav: bytes, timeout: float = 120) -> str:
    import urllib.request
    boundary = "----aliveboundary"
    parts = []
    for name, value in (("model", STT_MODEL), ("language", "zh"), ("response_format", "json")):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                 f"filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n")
    body = b"".join(p.encode() for p in parts) + wav + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{STT_BASE}/audio/transcriptions", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode()).get("text", "")


async def push_pcm(source, pcm48: np.ndarray, *, t_wall0: float, events: list, label: str,
                   mark_last_speech_at: int | None = None) -> None:
    step = 960
    t0 = time.perf_counter()
    events.append({"t": round(time.time() - t_wall0, 3), "ev": f"PUSH_START:{label}"})
    for i in range(0, len(pcm48), step):
        chunk = pcm48[i:i + step]
        if chunk.size < step:
            chunk = np.pad(chunk, (0, step - chunk.size))
        await source.capture_frame(
            rtc.AudioFrame(data=chunk.tobytes(), sample_rate=48000, num_channels=1,
                           samples_per_channel=step)
        )
        if mark_last_speech_at is not None and i + step >= mark_last_speech_at:
            events.append({"t": round(time.time() - t_wall0, 3), "ev": "PUSH_LAST_SPEECH"})
            mark_last_speech_at = None
        target = t0 + (i + step) / 48000
        delay = target - time.perf_counter()
        if delay > 0:
            await asyncio.sleep(delay)
    events.append({"t": round(time.time() - t_wall0, 3), "ev": f"PUSH_END:{label}"})


def parse_log_window(offset: int) -> dict:
    """读本轮 agent.log 窗口，抽 transcript / commit / tool 时刻。"""
    marks: dict = {"transcripts": [], "commits": [], "tool_starts": [], "tool_dones": [],
                   "assistant_texts": []}
    try:
        with AGENT_LOG.open("r", encoding="utf-8", errors="replace") as f:
            f.seek(offset)
            for raw in f:
                line = ANSI.sub("", raw)
                if "received user transcript" in line:
                    try:
                        payload = json.loads(line.split("received user transcript ", 1)[1])
                    except Exception:
                        continue
                    marks["transcripts"].append({
                        "ts": line.split(" - ")[0],
                        "text": payload.get("lk.pii.user_transcript", ""),
                        "delay": payload.get("transcript_delay"),
                    })
                elif "user turn committed" in line:
                    marks["commits"].append(line.split(" - ")[0])
                elif "executing tool" in line:
                    marks["tool_starts"].append(line.split(" - ")[0])
                elif "tools execution completed" in line:
                    marks["tool_dones"].append(line.split(" - ")[0])
                elif "conversation_item_added" in line and '"role": "assistant"' in line:
                    try:
                        marks["assistant_texts"].append(json.loads(
                            line.split("conversation_item_added ", 1)[1]).get("lk.pii.text", ""))
                    except Exception:
                        pass
    except Exception as exc:  # noqa: BLE001
        marks["error"] = repr(exc)
    return marks


def char_coverage(src: str, got: str) -> float:
    g = set(got)
    return sum(1 for ch in src if ch in g) / len(src)


async def one_run(cfg, trigger48: np.ndarray) -> dict:
    from livekit import api, rtc

    t_wall0 = time.time()
    events: list = []
    room_name = f"lat-{uuid.uuid4().hex[:8]}"
    http_url = cfg.livekit_url.replace("ws://", "http://").replace("wss://", "https://")

    lk = api.LiveKitAPI(url=http_url, api_key=cfg.api_key, api_secret=cfg.api_secret)
    await lk.room.create_room(api.CreateRoomRequest(name=room_name))
    await lk.agent_dispatch.create_dispatch(
        api.CreateAgentDispatchRequest(room=room_name, agent_name=cfg.agent_name)
    )
    await lk.aclose()
    events.append({"t": round(time.time() - t_wall0, 3), "ev": "DISPATCH"})

    token = (
        api.AccessToken(cfg.api_key, cfg.api_secret)
        .with_identity(CALLER_ID).with_name(CALLER_ID)
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )

    recorded: list[tuple[float, np.ndarray]] = []
    agent_track = asyncio.Event()
    first_audio: dict = {"t": None}
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
                now = time.time() - t_wall0
                recorded.append((now, arr))
                if first_audio["t"] is None:
                    rms = float(np.sqrt(np.mean(arr.astype(np.float64) ** 2)))
                    if rms > 50:
                        first_audio["t"] = now
                        events.append({"t": round(now, 3), "ev": "AGENT_FIRST_VOICE"})
        finally:
            await stream.aclose()

    await room.connect(cfg.livekit_url, token)
    for ident in list(room.remote_participants.keys()):
        if ident != CALLER_ID:
            agent_track.set()

    source = rtc.AudioSource(48000, 1)
    mic = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(
        mic, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )

    try:
        await asyncio.wait_for(agent_track.wait(), timeout=25)
    except asyncio.TimeoutError:
        print("[call] WARN 没等到 agent 音轨", flush=True)
        await asyncio.sleep(6)
    await asyncio.sleep(1.5)

    log_offset = AGENT_LOG.stat().st_size if AGENT_LOG.exists() else 0

    tail = np.zeros(int(48000 * 1.2), dtype=np.int16)
    await push_pcm(source, np.concatenate([trigger48, tail]), t_wall0=t_wall0, events=events,
                   label="trigger", mark_last_speech_at=len(trigger48) - 1)

    for _ in range(400):
        if first_audio["t"] is not None:
            break
        await asyncio.sleep(0.1)
    await asyncio.sleep(cfg.after_first_voice if first_audio["t"] else 8.0)
    events.append({"t": round(time.time() - t_wall0, 3), "ev": "RECORD_END"})

    await source.aclose()
    await room.disconnect()

    pcm = np.concatenate([a for _, a in recorded]) if recorded else np.zeros(0, dtype=np.int16)
    head_pcm = np.zeros(0, dtype=np.int16)
    if first_audio["t"] is not None and recorded:
        head_pcm = np.concatenate([a for t, a in recorded if t >= first_audio["t"]])

    marks = parse_log_window(log_offset)
    push_last = next((e["t"] for e in events if e["ev"] == "PUSH_LAST_SPEECH"), None)
    e2e = (first_audio["t"] - push_last) if (first_audio["t"] and push_last) else None
    return {
        "room": room_name,
        "t_wall0_epoch": round(t_wall0, 3),
        "events": events,
        "pcm": pcm,
        "head_pcm": head_pcm,
        "t_speech_end": push_last,
        "t_speech_end_epoch": round(t_wall0 + push_last, 3) if push_last else None,
        "t_first_audio": first_audio["t"],
        "t_first_audio_epoch": round(t_wall0 + first_audio["t"], 3) if first_audio["t"] else None,
        "e2e_first_audio_s": round(e2e, 3) if e2e is not None else None,
        "log_marks": marks,
    }


def validate(res: dict) -> tuple[bool, list[str]]:
    reasons = []
    marks = res["log_marks"]
    commits = marks.get("commits", [])
    transcripts = marks.get("transcripts", [])
    if len(commits) != 1:
        reasons.append(f"V1: {len(commits)} 次 user turn committed（触发话术被切成 {len(commits)} 轮）")
    if not transcripts:
        reasons.append("V2: 没抓到 transcript")
    else:
        cov = max((char_coverage(TRIGGER_TEXT, t["text"]) for t in transcripts), default=0.0)
        res["transcript_coverage"] = round(cov, 3)
        if cov < 0.8:
            reasons.append(f"V2: transcript 只覆盖触发话术 {cov:.0%}")
    if res["e2e_first_audio_s"] is None:
        reasons.append("V3: 没测到首帧")
    elif res["e2e_first_audio_s"] <= 0:
        reasons.append(f"V3: 首帧({res['t_first_audio']:.2f}s)早于用户说完({res['t_speech_end']:.2f}s)"
                       " — agent 抢话，口径不成立")
    return (not reasons), reasons


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--voxcpm-url", default=os.environ.get("VOXCPM_URL", "http://127.0.0.1:8801"))
    p.add_argument("--livekit-url", default=os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880"))
    p.add_argument("--api-key", default=os.environ.get("LIVEKIT_API_KEY", "devkey"))
    p.add_argument("--api-secret", default=os.environ.get("LIVEKIT_API_SECRET", "secret"))
    p.add_argument("--agent-name", default=os.environ.get("AGENT_NAME", "alive-voice"))
    p.add_argument("--agent-log", default=None,
                   help="该 worker 的日志路径（默认 ~/.alive/logs/agent.log）")
    p.add_argument("--out-dir", required=True)
    p.add_argument("--tag", default="run")
    p.add_argument("--runs", type=int, default=1)
    p.add_argument("--max-attempts", type=int, default=12,
                   help="最多跑几轮（含作废轮），凑够 --runs 个有效样本为止")
    p.add_argument("--after-first-voice", type=float, default=6.0)
    cfg = p.parse_args()

    global AGENT_LOG
    if cfg.agent_log:
        AGENT_LOG = Path(os.path.expanduser(cfg.agent_log))
    print(f"[harness] agent_name={cfg.agent_name}  agent_log={AGENT_LOG}", flush=True)

    out_dir = Path(cfg.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 预检：触发音频本身不能被 EnergyVAD 切轮，否则每轮都注定 V1 失败
    trigger24 = None
    for attempt in range(1, RENDER_TRIES + 1):
        cand = asyncio.run(synth(cfg.voxcpm_url, TRIGGER_TEXT))
        gaps = vad_split_gaps(cand)
        if not gaps:
            trigger24 = cand
            print(f"[tts] 触发音频 {len(cand)/24000:.2f}s（第 {attempt} 次渲染，无 >{VAD_MIN_SILENCE}s 静音谷）",
                  flush=True)
            break
        print(f"[tts] 第 {attempt} 次渲染含静音谷 {gaps} → 重渲染", flush=True)
    if trigger24 is None:
        print(f"[tts] !! {RENDER_TRIES} 次渲染都含静音谷：触发素材本身会被 EnergyVAD 切轮", flush=True)
        trigger24 = cand
    trigger48 = to_48k(trigger24)

    summary, valid_e2es = [], []
    attempt = 0
    while len(valid_e2es) < cfg.runs and attempt < cfg.max_attempts:
        attempt += 1
        tag = f"{cfg.tag}{attempt}"
        res = asyncio.run(one_run(cfg, trigger48))
        pcm = res.pop("pcm")
        head_pcm = res.pop("head_pcm")
        if pcm.size == 0:
            print(f"[rec] {tag} 没收到 agent 音频", flush=True)
            summary.append({"tag": tag, "valid": False, "reasons": ["没收到 agent 音频"]})
            continue

        wav_path = out_dir / f"latency_{tag}.wav"
        wav_path.write_bytes(wav_bytes(pcm, 48000))
        res["out"] = str(wav_path)
        res["audio_seconds"] = round(pcm.size / 48000, 2)
        if head_pcm.size:
            head_path = out_dir / f"latency_{tag}_first6s.wav"
            head_path.write_bytes(wav_bytes(head_pcm[: int(6.0 * 48000)], 48000))
            try:
                res["first_utterance_stt"] = stt_wav(head_path.read_bytes())
            except Exception as exc:  # noqa: BLE001
                res["first_utterance_stt"] = f"<stt failed: {exc!r}>"
            res["first6s_wav"] = str(head_path)

        ok, reasons = validate(res)
        res["valid"] = ok
        res["invalid_reasons"] = reasons
        (out_dir / f"latency_{tag}.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))

        tr = (res["log_marks"].get("transcripts") or [{}])
        summary.append({
            "tag": tag, "valid": ok, "reasons": reasons,
            "e2e": res["e2e_first_audio_s"],
            "commits": len(res["log_marks"].get("commits", [])),
            "transcript_coverage": res.get("transcript_coverage"),
            "transcripts": [t.get("text") for t in tr],
            "transcript_delays": [t.get("delay") for t in tr],
            "tool_starts": res["log_marks"].get("tool_starts", []),
            "first_utterance": res.get("first_utterance_stt"),
            "assistant_texts": res["log_marks"].get("assistant_texts", []),
        })
        if ok:
            valid_e2es.append(res["e2e_first_audio_s"])
        status = "VALID" if ok else "作废"
        print(f"[{status}] {tag} e2e={res['e2e_first_audio_s']}s "
              f"commits={len(res['log_marks'].get('commits', []))} "
              f"cov={res.get('transcript_coverage')} "
              f"first_utt={res.get('first_utterance_stt')!r}"
              + ("" if ok else f"  理由={reasons}"), flush=True)
        time.sleep(1.0)

    print("\n[summary] " + json.dumps(summary, ensure_ascii=False), flush=True)
    if valid_e2es:
        print(f"[summary] 有效样本 n={len(valid_e2es)}/{len(summary)}  "
              f"中位 {statistics.median(valid_e2es):.3f}s  "
              f"min {min(valid_e2es):.3f}  max {max(valid_e2es):.3f}  原始 {valid_e2es}", flush=True)
    (out_dir / f"summary_{cfg.tag}.json").write_text(json.dumps({
        "tag": cfg.tag, "attempts": len(summary), "valid": len(valid_e2es),
        "median": statistics.median(valid_e2es) if valid_e2es else None,
        "raw": valid_e2es, "runs": summary,
    }, ensure_ascii=False, indent=2))
    return 0 if len(valid_e2es) >= cfg.runs else 8


if __name__ == "__main__":
    sys.exit(main())
