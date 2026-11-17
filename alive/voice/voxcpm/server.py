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
from fractions import Fraction
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


def _downmix_to_mono(audio: np.ndarray) -> np.ndarray:
    """Take channel 0 of a multi-channel buffer; VoxCPM voice prompts are mono today."""
    if audio.ndim > 1:
        return audio[:, 0]
    return audio


def _resample_int16(audio: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    """Resample int16 PCM by a real filter, never by decimation.

    soxr is the fast path (small wheel, HQ filter); scipy's polyphase resampler is the
    fallback for boxes that already ship scipy. If neither is importable we raise instead
    of returning audio at the wrong rate: a silent 48k stream played as 24k shifts pitch
    down an octave, which is worse than a visible 500.
    """
    x = audio.astype(np.float32) / 32768.0
    try:
        import soxr
    except ImportError:
        soxr = None
    if soxr is not None:
        y = soxr.resample(x, src_sr, dst_sr, quality="HQ")
    else:
        try:
            from scipy.signal import resample_poly
        except ImportError as exc:  # pragma: no cover - depends on host packages
            raise RuntimeError(
                f"重采样不可用：模型输出 {src_sr}Hz，下游固定 {dst_sr}Hz。请 pip install soxr（或 scipy）。"
            ) from exc
        ratio = Fraction(dst_sr, src_sr)
        y = resample_poly(x, ratio.numerator, ratio.denominator)
    # Resamplers overshoot ±1.0 on transients; saturate instead of letting int16 wrap.
    return np.clip(np.rint(y * 32768.0), -32768, 32767).astype(np.int16)


def _pcm_at_target_rate(audio: np.ndarray, file_sr: int) -> np.ndarray:
    """Return mono int16 PCM at SAMPLE_RATE, converting for real when the model emits 48k."""
    audio = _downmix_to_mono(audio)  # downmix before resampling: per-channel filters cost 2x
    if file_sr == SAMPLE_RATE:
        return audio  # zero-copy passthrough; no resample, no re-quantise
    return _resample_int16(np.ascontiguousarray(audio), file_sr, SAMPLE_RATE)


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
    return _pcm_at_target_rate(audio, file_sr).tobytes()


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
