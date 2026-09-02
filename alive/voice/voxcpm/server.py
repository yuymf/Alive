#!/usr/bin/env python3
"""Thin VoxCPM HTTP server for Alive.

GET  /health
GET  /v1/voices
POST /v1/voices          { "name", "wav_path", "prompt_text" }
POST /v1/audio/speech    { "input"|"text", "voice" } → raw PCM s16le 24kHz
POST /v1/audio/speech/stream  same, chunked PCM

VOXCPM_MOCK=1 returns silence so CI / machines without GPU can still wire the stack.
"""

from __future__ import annotations

import io
import os
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

SAMPLE_RATE = 24000
HOME = Path(os.environ.get("ALIVE_HOME") or (Path.home() / ".alive"))
VOICE_DIR = Path(os.environ.get("VOXCPM_VOICE_DIR") or (HOME / "voices"))
VOICE_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Alive VoxCPM")
_model = None


class SpeechIn(BaseModel):
    input: str | None = None
    text: str | None = None
    voice: str = "default"
    response_format: str = "pcm"


class VoiceIn(BaseModel):
    name: str
    wav_path: str
    prompt_text: str = ""


def _text(body: SpeechIn) -> str:
    return (body.input or body.text or "").strip()


def _voice_paths(name: str) -> tuple[Path, Path]:
    folder = VOICE_DIR / name
    return folder / "ref.wav", folder / "prompt.txt"


def _load_model():
    global _model
    if _model is not None:
        return _model
    if os.getenv("VOXCPM_MOCK") == "1":
        _model = "mock"
        return _model
    try:
        from voxcpm import VoxCPM
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="未安装 voxcpm。GPU 机器上: pip install voxcpm。或 VOXCPM_MOCK=1 做联调。",
        ) from exc
    model_id = os.getenv("VOXCPM_MODEL", "openbmb/VoxCPM2")
    _model = VoxCPM.from_pretrained(model_id, load_denoiser=False)
    return _model


def _synthesize(text: str, voice: str) -> bytes:
    if not text:
        raise HTTPException(status_code=400, detail="input 不能为空")
    model = _load_model()
    if model == "mock":
        seconds = max(0.4, min(8.0, len(text) * 0.08))
        n = int(SAMPLE_RATE * seconds)
        pcm = np.zeros(n, dtype=np.int16)
        return pcm.tobytes()

    wav_path, prompt_path = _voice_paths(voice)
    kwargs = {"text": text}
    if wav_path.exists():
        kwargs["reference_wav_path"] = str(wav_path)
        if prompt_path.exists():
            prompt = prompt_path.read_text(encoding="utf-8").strip()
            if prompt:
                kwargs["prompt_wav_path"] = str(wav_path)
                kwargs["prompt_text"] = prompt
    wav = model.generate(**kwargs)
    sr = getattr(getattr(model, "tts_model", None), "sample_rate", SAMPLE_RATE)
    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    audio, file_sr = sf.read(buf, dtype="int16")
    if file_sr != SAMPLE_RATE:
        # keep it simple: most VoxCPM builds already emit 24k
        pass
    if audio.ndim > 1:
        audio = audio[:, 0]
    return audio.astype(np.int16).tobytes()


@app.get("/health")
def health():
    return {
        "ok": True,
        "mock": os.getenv("VOXCPM_MOCK") == "1",
        "voices": [p.name for p in VOICE_DIR.iterdir() if p.is_dir()] if VOICE_DIR.exists() else [],
    }


@app.get("/v1/models")
def models():
    return {"data": [{"id": "voxcpm"}]}


@app.get("/v1/voices")
def list_voices():
    names = [p.name for p in VOICE_DIR.iterdir() if p.is_dir()] if VOICE_DIR.exists() else []
    return {"voices": names or ["default"]}


@app.post("/v1/voices")
def register_voice(body: VoiceIn):
    src = Path(body.wav_path).expanduser()
    if not src.exists():
        raise HTTPException(status_code=400, detail=f"找不到 wav: {src}")
    dest_wav, dest_txt = _voice_paths(body.name)
    dest_wav.parent.mkdir(parents=True, exist_ok=True)
    dest_wav.write_bytes(src.read_bytes())
    dest_txt.write_text(body.prompt_text or "", encoding="utf-8")
    return {"ok": True, "voice": body.name, "wav": str(dest_wav)}


@app.post("/v1/audio/speech")
def speech(body: SpeechIn):
    pcm = _synthesize(_text(body), body.voice)
    return Response(content=pcm, media_type="application/octet-stream")


@app.post("/v1/audio/speech/stream")
def speech_stream(body: SpeechIn):
    pcm = _synthesize(_text(body), body.voice)

    def chunks():
        step = 4096
        for i in range(0, len(pcm), step):
            yield pcm[i : i + step]

    return StreamingResponse(chunks(), media_type="application/octet-stream")


def main() -> None:
    import uvicorn

    host = os.getenv("VOXCPM_HOST", "127.0.0.1")
    port = int(os.getenv("VOXCPM_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
