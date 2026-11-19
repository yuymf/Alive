"""Regression tests for the 48kHz -> 24kHz conversion in the VoxCPM sidecar.

VoxCPM2's AudioVAE V2 declares ``out_sample_rate = 48000`` while the LiveKit
``output_emitter`` is initialised at 24kHz. Any code path that forwards 48kHz PCM
as "24kHz" plays it at half speed with the pitch an octave down, which is the bug
these tests pin.

Run:
    .venv/bin/python -m pytest alive/voice/voxcpm/test_sample_rate.py -q
"""

from __future__ import annotations

import atexit
import importlib.util
import os
import shutil
import sys
import tempfile
from fractions import Fraction
from pathlib import Path

import numpy as np

_TMP = tempfile.mkdtemp(prefix="voxcpm-test-")
atexit.register(shutil.rmtree, _TMP, True)
# server.py creates VOICE_DIR on import; point it at the sandbox so tests never touch ~/.alive
os.environ["ALIVE_HOME"] = _TMP
os.environ["VOXCPM_VOICE_DIR"] = os.path.join(_TMP, "voices")

_SERVER_PY = Path(__file__).with_name("server.py")
_spec = importlib.util.spec_from_file_location("voxcpm_server_under_test", _SERVER_PY)
assert _spec and _spec.loader
server = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = server
_spec.loader.exec_module(server)

SAMPLE_RATE = server.SAMPLE_RATE
NYQUIST_OUT = SAMPLE_RATE / 2


def _tone(freq: float, sr: int, seconds: float = 1.0, amp: float = 0.5) -> np.ndarray:
    t = np.arange(int(sr * seconds)) / sr
    return (amp * np.sin(2 * np.pi * freq * t) * 32767.0).astype(np.int16)


def _peak_freq(pcm: np.ndarray, sr: int) -> float:
    x = pcm.astype(np.float64) / 32768.0
    window = np.hanning(len(x))
    spectrum = np.abs(np.fft.rfft(x * window))
    freqs = np.fft.rfftfreq(len(x), 1.0 / sr)
    return float(freqs[int(np.argmax(spectrum))])


def _duration_s(pcm: np.ndarray, sr: int) -> float:
    return len(pcm) / sr


# --- the bug itself -------------------------------------------------------


def test_48k_input_becomes_24k_output_with_matching_duration():
    inp = _tone(440.0, 48000)
    out = server._pcm_at_target_rate(inp, 48000)

    assert out.dtype == np.int16
    assert out.ndim == 1
    # duration, not byte count: a passthrough keeps 48000 samples which plays as 2.0s at 24kHz
    expected = _duration_s(inp, 48000)
    got = _duration_s(out, SAMPLE_RATE)
    err = abs(got - expected) / expected
    assert err < 0.01, f"duration error {err:.2%}: {len(out)} samples at {SAMPLE_RATE}Hz vs {expected:.3f}s"


def test_440hz_tone_keeps_its_pitch_after_conversion():
    out = server._pcm_at_target_rate(_tone(440.0, 48000), 48000)
    peak = _peak_freq(out, SAMPLE_RATE)
    assert abs(peak - 440.0) < 5.0, f"peak {peak:.1f}Hz, expected 440Hz (an octave down = 220Hz)"


def test_conversion_filters_instead_of_decimating():
    # 20kHz is above the 12kHz output Nyquist: a real low-pass kills it, naive
    # "keep every 2nd sample" would alias it to 4kHz at full amplitude.
    out = server._pcm_at_target_rate(_tone(20000.0, 48000, amp=0.5), 48000)
    x = out.astype(np.float64) / 32768.0
    spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x)))) / (len(x) / 4)
    freqs = np.fft.rfftfreq(len(x), 1.0 / SAMPLE_RATE)
    alias_band = spectrum[(freqs > 3500) & (freqs < 4500)].max()
    assert alias_band < 0.05, f"4kHz alias image at {alias_band:.3f} of full scale: decimation, not resampling"


def test_amplitude_is_preserved():
    out = server._pcm_at_target_rate(_tone(440.0, 48000, amp=0.5), 48000)
    peak = float(np.abs(out).max()) / 32768.0
    assert abs(peak - 0.5) < 0.03, f"peak amplitude {peak:.3f}, expected ~0.5"


# --- boundaries -----------------------------------------------------------


def test_passthrough_at_24k_is_zero_copy_and_byte_identical():
    inp = _tone(440.0, 24000)
    out = server._pcm_at_target_rate(inp, 24000)

    assert out is inp, "24kHz input must not be copied or re-quantised"
    assert out.tobytes() == inp.tobytes()


def test_stereo_is_downmixed_before_resampling():
    left = _tone(440.0, 48000)
    stereo = np.stack([left, left], axis=1)
    out = server._pcm_at_target_rate(stereo, 48000)

    assert out.ndim == 1
    assert abs(_duration_s(out, SAMPLE_RATE) - 1.0) < 0.01
    assert abs(_peak_freq(out, SAMPLE_RATE) - 440.0) < 5.0


def test_scipy_fallback_matches_soxr_path(monkeypatch):
    inp = _tone(440.0, 48000)
    expected_len = len(server._pcm_at_target_rate(inp, 48000))

    # `sys.modules[name] = None` makes `import name` raise ImportError, forcing the fallback
    monkeypatch.setitem(sys.modules, "soxr", None)
    out = server._pcm_at_target_rate(inp, 48000)

    assert abs(len(out) - expected_len) <= 2, f"{len(out)} vs {expected_len} samples"
    assert abs(_peak_freq(out, SAMPLE_RATE) - 440.0) < 5.0
    ratio = Fraction(SAMPLE_RATE, 48000)
    assert (ratio.numerator, ratio.denominator) == (1, 2)


# --- the reverse control: this assertion must be able to fail -------------


def test_duration_criterion_rejects_the_old_passthrough(monkeypatch):
    """Reintroduce the old `pass` stub in memory and prove the duration test goes red."""
    monkeypatch.setattr(server, "_resample_int16", lambda audio, src_sr, dst_sr: audio)
    inp = _tone(440.0, 48000)
    buggy = server._pcm_at_target_rate(inp, 48000)

    expected = _duration_s(inp, 48000)
    got = _duration_s(buggy, SAMPLE_RATE)
    assert abs(got - expected) / expected > 0.9, "mutant must reproduce the 2x duration bug"
    assert abs(_peak_freq(buggy, SAMPLE_RATE) - 440.0) > 100.0, "mutant must reproduce the octave drop"
