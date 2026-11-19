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
import threading
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
# One GPU, one model instance: concurrent generate() calls interleave their KV/VAE
# state and produce garbled audio. Streaming made concurrency real (the sync endpoint
# runs in FastAPI's threadpool), so the serialisation has to be explicit.
_MODEL_LOCK = threading.Lock()


class SpeechIn(BaseModel):
    input: str | None = None
    text: str | None = None
    voice: str = "default"
    response_format: str = "pcm"
    # VoxCPM2 style/emotion control, e.g. "开心，语速稍快，音调上扬"。
    # Upstream turns this into a `(control)text` prefix — see _final_text.
    control: str | None = None


class VoiceIn(BaseModel):
    name: str
    wav_path: str
    prompt_text: str = ""


def _text(body: SpeechIn) -> str:
    return (body.input or body.text or "").strip()


def _final_text(text: str, control: str | None) -> str:
    """Prefix the control instruction the way upstream's CLI does.

    VoxCPM2 has no emotion/style *argument* on ``_generate()``; the only supported
    channel is a ``(instruction)`` prefix on the text itself (``cli.py:build_final_text``).
    Doing it here rather than in the caller keeps every entry point (stream / sync /
    mock) on one implementation, so the A/B md5 difference can't come from a caller
    that forgot the prefix.
    """
    control = (control or "").strip()
    return f"({control}){text}" if control else text


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


class _StreamResampler:
    """Streaming 48k->24k converter.

    Resampling each chunk independently restarts the filter at every chunk boundary,
    which is audible as a click every ~100ms. ``soxr.ResampleStream`` carries the
    filter state across chunks so the concatenated result matches a one-shot
    ``soxr.resample``. The last chunk must be flushed with ``last=True`` to drain
    the filter's lookahead, otherwise the tail of every utterance is cut.
    """

    def __init__(self, src_sr: int, dst_sr: int) -> None:
        self._identity = src_sr == dst_sr
        self._soxr = None
        if not self._identity:
            import soxr  # ImportError here is intentional: no filter means wrong pitch

            self._soxr = soxr.ResampleStream(src_sr, dst_sr, 1, dtype="float32", quality="HQ")

    def push(self, audio: np.ndarray, *, last: bool = False) -> np.ndarray:
        if self._identity:
            return audio
        x = np.ascontiguousarray(audio, dtype=np.float32) / 32768.0
        y = self._soxr.resample_chunk(x, last=last)
        return np.clip(np.rint(y * 32768.0), -32768, 32767).astype(np.int16)


def _pcm_at_target_rate(audio: np.ndarray, file_sr: int) -> np.ndarray:
    """Return mono int16 PCM at SAMPLE_RATE, converting for real when the model emits 48k."""
    audio = _downmix_to_mono(audio)  # downmix before resampling: per-channel filters cost 2x
    if file_sr == SAMPLE_RATE:
        return audio  # zero-copy passthrough; no resample, no re-quantise
    return _resample_int16(np.ascontiguousarray(audio), file_sr, SAMPLE_RATE)


def _voice_kwargs(voice: str, *, reference_only: bool = False) -> dict:
    """Voice-conditioning kwargs.

    ``reference_only=True`` is forced whenever a control instruction is used: upstream
    ``cli.py:119-125`` refuses ``--control`` together with ``--prompt-text``, because a
    continuation prompt ("say exactly this next") and a style instruction ("say it
    happily") contradict each other. Reference-only mode still clones the timbre
    (``reference_wav_path`` is structurally isolated via ref_audio tokens), it just
    drops the "continue this transcript" half.
    """
    wav_path, prompt_path = _voice_paths(voice)
    kwargs: dict = {}
    if wav_path.exists():
        kwargs["reference_wav_path"] = str(wav_path)
        if not reference_only and prompt_path.exists():
            prompt = prompt_path.read_text(encoding="utf-8").strip()
            if prompt:
                kwargs["prompt_wav_path"] = str(wav_path)
                kwargs["prompt_text"] = prompt
    return kwargs


# build_prompt_cache() re-encodes the reference wav through the AudioVAE: 1.5s cold,
# ~0.11s warm. Cached per voice so only the first utterance of a call pays it; the
# key carries the wav mtime so re-registering a voice invalidates the entry.
_prompt_cache: dict[str, tuple[tuple[float, int, bool], object]] = {}
_prompt_cache_lock = threading.Lock()


def _cached_prompt_cache(model, voice: str, *, reference_only: bool = False):
    wav_path, _ = _voice_paths(voice)
    if not wav_path.exists():
        return None
    try:
        stat = wav_path.stat()
    except OSError:
        return None
    # Key carries the mode: reference-only and ref+continuation are different caches
    # (different encoded feats), and a call can flip between them per-utterance.
    key = (stat.st_mtime, stat.st_size, reference_only)
    with _prompt_cache_lock:
        hit = _prompt_cache.get(voice)
        if hit and hit[0] == key:
            return hit[1]
    kwargs = _voice_kwargs(voice, reference_only=reference_only)
    cache = model.tts_model.build_prompt_cache(
        prompt_text=kwargs.get("prompt_text"),
        prompt_wav_path=kwargs.get("prompt_wav_path"),
        reference_wav_path=kwargs.get("reference_wav_path"),
    )
    with _prompt_cache_lock:
        _prompt_cache[voice] = (key, cache)
    return cache


def _model_sample_rate(model) -> int:
    return int(getattr(getattr(model, "tts_model", None), "sample_rate", SAMPLE_RATE))


def _synthesize(text: str, voice: str, control: str | None = None) -> bytes:
    if not text:
        raise HTTPException(status_code=400, detail="input 不能为空")
    model = _load_model()
    if model == "mock":
        seconds = max(0.4, min(8.0, len(text) * 0.08))
        n = int(SAMPLE_RATE * seconds)
        pcm = np.zeros(n, dtype=np.int16)
        if control:
            # Mock must still distinguish controls, otherwise every A/B md5 check
            # would "pass" by accident on silence. A control-dependent tone beats a
            # zero buffer: it proves the plumbing, nothing about the real model.
            # Derived from codepoints, NOT hash(): Python randomises str hashing per
            # process, so two different controls could map to the same tone and make
            # this assertion flaky ~1/7 of the time.
            tone = 220.0 + 30.0 * (sum(ord(c) for c in control) % 7)
            t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
            pcm = (8000 * np.sin(2 * np.pi * tone * t)).astype(np.int16)
        return pcm.tobytes()

    control = (control or "").strip() or None
    kwargs = _voice_kwargs(voice, reference_only=bool(control))
    with _MODEL_LOCK:
        wav = model.generate(text=_final_text(text, control), **kwargs)
    sr = _model_sample_rate(model)
    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    audio, file_sr = sf.read(buf, dtype="int16")
    return _pcm_at_target_rate(audio, file_sr).tobytes()


def _stream_pcm(text: str, voice: str, control: str | None = None):
    """Yield int16 PCM at SAMPLE_RATE as the model produces it.

    ``generate_streaming`` yields one decoded chunk per autoregressive step (~100ms of
    audio each): first chunk arrives in 60-120ms, whereas the whole utterance needs
    RTF x duration (2-5s). That gap is the entire point of this endpoint, so every
    chunk is forwarded the moment it exists — no batching, no accumulate-then-slice.

    ``retry_badcase_ratio_threshold`` is *not* only about retries: the library feeds it
    into ``max_len = tokens * threshold + 10`` on every call. Non-streaming relies on
    the retry to recover from a runaway utterance; streaming cannot retry (the library
    forces ``retry_badcase=False``), so the cap is the only thing standing between us
    and a 9-second "啊啊啊啊" — the default 6.0 allows 2-3x the normal length. 3.0 still
    leaves ~2x headroom over normal speech (0.13-0.37 s/char) and measured 0/10 badcases
    across four transition phrases.
    """
    if not text:
        raise HTTPException(status_code=400, detail="input 不能为空")
    model = _load_model()
    control = (control or "").strip() or None
    if model == "mock":
        seconds = max(0.4, min(8.0, len(text) * 0.08))
        step = SAMPLE_RATE // 10
        # Same reasoning as the sync mock: silence for every control would let an A/B
        # byte-comparison pass while the streaming path (the one the worker uses)
        # ignored `control` entirely.
        phase = float(sum(ord(c) for c in (control or "")) % 7) * 30.0
        n = int(SAMPLE_RATE * seconds)
        t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
        wave_pcm = (8000 * np.sin(2 * np.pi * (220.0 + phase) * t)).astype(np.int16)
        for i in range(0, n, step):
            yield wave_pcm[i:i + step].tobytes()
        return

    # Continuation (prompt_text) and control are mutually exclusive upstream, so a
    # styled utterance drops to reference-only cloning. The prompt cache is keyed by
    # mode, so switching costs one re-encode, not one per chunk.
    cache = _cached_prompt_cache(model, voice, reference_only=bool(control))
    src_sr = _model_sample_rate(model)
    resampler = _StreamResampler(src_sr, SAMPLE_RATE)
    ratio_cap = float(os.getenv("VOXCPM_STREAM_RATIO_CAP", "3.0"))

    with _MODEL_LOCK:
        gen = model.tts_model.generate_with_prompt_cache_streaming(
            target_text=_final_text(text, control),
            prompt_cache=cache,
            min_len=2,
            max_len=4096,
            inference_timesteps=10,
            cfg_value=2.0,
            retry_badcase=False,
            retry_badcase_ratio_threshold=ratio_cap,
        )
        try:
            for item in gen:
                chunk = item[0] if isinstance(item, tuple) else item
                audio = np.asarray(chunk.reshape(-1).cpu().numpy(), dtype=np.float32)
                if audio.size == 0:
                    continue
                pcm = resampler.push((audio * 32768.0).astype(np.int16), last=False)
                if pcm.size:
                    yield pcm.tobytes()
            tail = resampler.push(np.zeros(0, dtype=np.int16), last=True)
            if tail.size:
                yield tail.tobytes()
        finally:
            gen.close()


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
    pcm = _synthesize(_text(body), body.voice, body.control)
    return Response(content=pcm, media_type="application/octet-stream")


@app.post("/v1/audio/speech/stream")
def speech_stream(body: SpeechIn):
    pcm_iter = _stream_pcm(_text(body), body.voice, body.control)
    return StreamingResponse(pcm_iter, media_type="application/octet-stream")


def main() -> None:
    import uvicorn

    host = os.getenv("VOXCPM_HOST", "127.0.0.1")
    port = int(os.getenv("VOXCPM_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
