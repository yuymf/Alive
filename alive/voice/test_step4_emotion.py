#!/usr/bin/env python3
"""Step4 guards: emotion state source + acoustic control channel.

These are the tests that must fail if the feature is faked. Each one targets a
specific way "emotion" could look alive without being alive:

  * state file rewritten but the numbers never move (static content)
  * control string identical for all personas (isolation theatre)
  * control computed on the hot path (await/file I/O between speech and first audio)
  * mapping table hardcoded in .py (card invariant 4: change table, not code)
  * server accepting `control` and ignoring it (prefix never reaches the model)
  * control prefix ending up in the spoken audio instead of acting as a style cue

Run: cd alive/voice/agent && ../../.venv-voice/bin/python -m pytest ../test_step4_emotion.py -q
"""
from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parent / "agent"
VOICE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(AGENT_DIR))

import emotion_runtime as er  # noqa: E402


MAP_PATH = VOICE_DIR / "emotion" / "control-map.yaml"


def _state_root(tmp_path: Path) -> Path:
    return tmp_path


def _runtime(tmp_path: Path, persona: str = "minase") -> er.EmotionRuntime:
    rt = er.EmotionRuntime(persona=persona, state_root=_state_root(tmp_path),
                           control_map_path=MAP_PATH)
    rt.load_sync()
    return rt


# ---------------------------------------------------------------- control map

def test_control_map_covers_all_four_dimensions():
    cmap = er.ControlMap(MAP_PATH)
    cmap.load()
    for dim in ("valence", "arousal", "energy", "stress"):
        assert cmap.dimensions.get(dim), f"{dim} 缺少映射规则（卡面不变量 4）"
        # every dimension needs a catch-all, otherwise out-of-range values yield ''
        assert cmap.dimensions[dim][-1].get("up_to") is None, f"{dim} 缺兜底规则"


def test_each_dimension_value_produces_a_distinct_control():
    """Every bucket in the table must be reachable and yield a different string.

    This is the guard for "表里每个值都要能复现出一条不同 md5 的 wav": if two buckets
    collapse to the same sentence, two very different moods produce identical audio and
    the table is lying about its resolution.
    """
    cmap = er.ControlMap(MAP_PATH)
    cmap.load()
    base = {"valence": 0.2, "arousal": 0.4, "energy": 0.5, "stress": 0.2}
    for dim, rules in cmap.dimensions.items():
        seen = {}
        for rule in rules:
            up_to = rule.get("up_to")
            # Probe just inside this bucket: up_to-ε lands above the previous rule's
            # threshold and at/below this one, which is the only value that must map here.
            probe = dict(base)
            probe[dim] = (float(up_to) - 0.01) if up_to is not None else 0.99
            phrase = cmap._phrase(dim, probe[dim])
            assert phrase, f"{dim} 在 {probe[dim]} 处无短语"
            assert phrase not in seen, f"{dim} 两个桶撞成同一句 {phrase!r}"
            seen[phrase] = probe[dim]


def test_persona_override_makes_each_vup_distinct():
    """minase / guodegang / ace-taffy must not share one control string."""
    state = {"valence": 0.45, "arousal": 0.5, "energy": 0.55, "stress": 0.2}
    cmap = er.ControlMap(MAP_PATH)
    cmap.load()
    controls = {p: cmap.control_for(p, state)
                for p in ("minase", "guodegang", "ace-taffy")}
    assert all(controls.values()), controls
    assert len(set(controls.values())) == 3, f"三个 persona 控制串撞了: {controls}"


def test_missing_map_file_does_not_raise():
    """A broken/missing table must degrade to "no control", never break the call."""
    cmap = er.ControlMap(Path("/nonexistent/control-map.yaml"))
    with pytest.raises(OSError):
        cmap.load()          # load itself is allowed to fail...
    assert cmap.control_for("minase", er.DEFAULT_BASELINE) is None  # ...and stays inert


def test_table_change_takes_effect_without_restart(tmp_path):
    """Card invariant 4: edit the table, get a new control string, no code change."""
    table = tmp_path / "map.yaml"
    table.write_text(
        "dimensions:\n"
        "  valence: [{up_to: null, phrase: 'AAA'}]\n"
        "  arousal: [{up_to: null, phrase: 'BBB'}]\n"
        "  energy: [{up_to: null, phrase: 'CCC'}]\n"
        "  stress: [{up_to: null, phrase: 'DDD'}]\n",
        encoding="utf-8",
    )
    rt = er.EmotionRuntime(persona="minase", state_root=tmp_path,
                           control_map_path=table)
    rt.load_sync()
    assert rt.control_for_speech() == "AAA，BBB，CCC，DDD"

    time.sleep(1.1)  # mtime granularity: some filesystems only resolve to the second
    table.write_text(
        "dimensions:\n"
        "  valence: [{up_to: null, phrase: 'EEE'}]\n"
        "  arousal: [{up_to: null, phrase: 'FFF'}]\n"
        "  energy: [{up_to: null, phrase: 'GGG'}]\n"
        "  stress: [{up_to: null, phrase: 'HHH'}]\n",
        encoding="utf-8",
    )
    rt.observe_transcript("随便说一句")
    assert rt.control_for_speech() == "EEE，FFF，GGG，HHH"


# -------------------------------------------------------------- hot-path guard

def test_control_read_touches_no_filesystem(tmp_path, monkeypatch):
    """The synth path calls control_for_speech() per utterance. It must be pure memory.

    Both filesystem surfaces it could plausibly reach are replaced with objects that
    explode: the control map (reloading it) and the state path (re-reading the json).
    Patching is instance/class-local — a global ``pathlib.Path.stat`` patch would also
    break pytest's own traceback rendering and turn a red test into INTERNALERROR.
    """
    rt = _runtime(tmp_path)

    class _Explode:
        def __getattr__(self, name):
            def boom(*a, **k):
                raise AssertionError(f"control_for_speech 触碰了文件系统 (Path.{name})")
            return boom

    def boom_load(*a, **k):
        raise AssertionError("control_for_speech 重新加载了控制串映射表")

    monkeypatch.setattr(er.ControlMap, "load", boom_load)
    rt.state_path = _Explode()  # type: ignore[assignment]
    for _ in range(50):
        assert rt.control_for_speech() is not None


def test_control_read_is_fast_enough_for_hot_path(tmp_path):
    """One call must be orders of magnitude below the 1.773s first-audio budget."""
    rt = _runtime(tmp_path)
    n = 2000
    t0 = time.perf_counter()
    for _ in range(n):
        rt.control_for_speech()
    per_call_us = (time.perf_counter() - t0) / n * 1e6
    assert per_call_us < 50, f"control_for_speech 每次 {per_call_us:.1f}µs，太慢"


# ------------------------------------------------------------- state movement

def test_transcript_moves_state_and_control(tmp_path):
    """The whole point: a call changes the numbers AND the resulting control string."""
    rt = _runtime(tmp_path)
    before = rt.snapshot()
    for _ in range(8):
        rt.observe_transcript("今天太累了，还在加班，好烦")
    after = rt.snapshot()
    st_b, st_a = before["state"], after["state"]
    assert st_a["stress"] > st_b["stress"], (st_b, st_a)
    assert st_a["energy"] < st_b["energy"], (st_b, st_a)
    assert st_a["valence"] < st_b["valence"], (st_b, st_a)
    assert before["control"] != after["control"], "状态变了但控制串没变"


def test_positive_transcript_moves_the_other_way(tmp_path):
    rt = _runtime(tmp_path)
    b = rt.snapshot()["state"]
    for _ in range(8):
        rt.observe_transcript("哈哈哈太好了，我真的很开心，谢谢你")
    a = rt.snapshot()["state"]
    assert a["valence"] > b["valence"], (b, a)
    assert a["arousal"] > b["arousal"], (b, a)


def test_state_decays_back_toward_baseline(tmp_path):
    """Without decay every long call ratchets to an extreme and stays there."""
    rt = _runtime(tmp_path)
    for _ in range(10):
        rt.observe_transcript("累死了好烦")
    peak = rt.snapshot()["state"]["stress"]
    for _ in range(40):
        rt.observe_transcript("嗯")   # no lexicon hits: decay only
    assert rt.snapshot()["state"]["stress"] < peak


def test_written_file_matches_schema_and_mtime_advances(tmp_path):
    """Invariant 1: mtime forward AND content changed, in the TS layer's schema."""
    rt = _runtime(tmp_path)
    rt.observe_transcript("好累，在加班")
    rt.flush()
    path = rt.state_path
    assert path.exists(), path
    first = path.stat()
    payload = json.loads(path.read_text(encoding="utf-8"))
    for key in ("mood", "energy", "stress", "last_updated", "recent_cause"):
        assert key in payload, f"缺 {key}，:8766 的 hydrateEmotionState 会读不到"
    assert set(payload["mood"]) >= {"valence", "arousal", "description"}

    time.sleep(0.01)
    for _ in range(5):
        rt.observe_transcript("太开心了哈哈哈")
    rt.flush()
    second = path.stat()
    assert second.st_mtime_ns > first.st_mtime_ns, "mtime 没前进"
    assert json.loads(path.read_text(encoding="utf-8")) != payload, "内容没变"


def test_personas_never_write_each_other(tmp_path):
    """Invariant 3: three personas, three files, no cross-write."""
    m = _runtime(tmp_path, "minase")
    g = _runtime(tmp_path, "guodegang")
    a = _runtime(tmp_path, "ace-taffy")
    m.observe_transcript("太烦了，累死我了")
    g.observe_transcript("哈哈哈太好了")
    a.observe_transcript("有点烦")
    for rt in (m, g, a):
        rt.flush()
    files = {p.parent.parent.name: p for p in (tmp_path).glob("*/state/emotion-state.json")}
    assert set(files) == {"minase", "guodegang", "ace-taffy"}, files
    states = {name: json.loads(p.read_text(encoding="utf-8")) for name, p in files.items()}
    # minase got the negative sentence, guodegang the positive one — opposite directions.
    assert states["minase"]["stress"] > states["guodegang"]["stress"]
    assert states["guodegang"]["mood"]["valence"] > states["minase"]["mood"]["valence"]


def test_runtime_reads_baseline_from_existing_state(tmp_path):
    """A persona's file baseline is its own, not a global constant."""
    p = tmp_path / "guodegang" / "state" / "emotion-state.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({
        "mood": {"valence": 0.4, "arousal": 0.5, "description": "刚下了场相声"},
        "energy": 0.6, "stress": 0.2, "creativity": 0.5, "sociability": 0.5,
        "recent_cause": "vup-team-step2",
    }, ensure_ascii=False), encoding="utf-8")
    rt = er.EmotionRuntime(persona="guodegang", state_root=tmp_path,
                           control_map_path=MAP_PATH)
    rt.load_sync()
    assert rt.snapshot()["state"]["energy"] == pytest.approx(0.6)
    assert rt.snapshot()["state"]["valence"] == pytest.approx(0.4)


def test_disabled_by_env(monkeypatch):
    monkeypatch.setenv("ALIVE_EMOTION", "0")
    assert er.build_runtime() is None


# ------------------------------------------------------------------- server

def _load_server(path: Path):
    spec = importlib.util.spec_from_file_location("voxcpm_server_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _voice_dir(tmp_path: Path, name: str, *, with_prompt: bool) -> Path:
    d = tmp_path / name
    d.mkdir(parents=True)
    # 40ms of silence is enough: these tests never load the real model.
    import struct
    import wave
    wav = tmp_path / "ref.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(struct.pack("<" + "h" * 960, *([0] * 960)))
    (d / "ref.wav").write_bytes(wav.read_bytes())
    if with_prompt:
        (d / "prompt.txt").write_text("示例台词", encoding="utf-8")
    return d


def test_server_control_prefix_reaches_the_model(tmp_path, monkeypatch):
    """`control` must become a `(control)text` prefix — that is the only channel."""
    monkeypatch.setenv("VOICE_DIR_OVERRIDE", str(tmp_path))
    monkeypatch.setenv("ALIVE_HOME", str(tmp_path))
    server = _load_server(VOICE_DIR / "voxcpm" / "server.py")
    server.VOICE_DIR = tmp_path

    assert server._final_text("你好", None) == "你好"
    assert server._final_text("你好", "  ") == "你好"
    assert server._final_text("你好", "开心，语速稍快") == "(开心，语速稍快)你好"

    body = server.SpeechIn(input="你好", control="开心，语速稍快")
    assert body.control == "开心，语速稍快"


def test_server_drops_prompt_text_when_control_is_set(tmp_path, monkeypatch):
    """Upstream forbids control + continuation. Reference-only keeps the timbre."""
    monkeypatch.setenv("ALIVE_HOME", str(tmp_path))
    server = _load_server(VOICE_DIR / "voxcpm" / "server.py")
    _voice_dir(tmp_path, "ace-taffy", with_prompt=True)
    server.VOICE_DIR = tmp_path   # _voice_paths() appends the voice name itself

    cont = server._voice_kwargs("ace-taffy")
    assert "prompt_text" in cont and "prompt_wav_path" in cont
    ref = server._voice_kwargs("ace-taffy", reference_only=True)
    assert "prompt_text" not in ref and "prompt_wav_path" not in ref
    assert ref["reference_wav_path"].endswith("ref.wav")


def test_server_mock_distinguishes_controls(tmp_path, monkeypatch):
    """If the mock returned the same silence for every control, every A/B md5 check in
    CI would pass while the plumbing was broken."""
    monkeypatch.setenv("ALIVE_HOME", str(tmp_path))
    monkeypatch.setenv("VOXCPM_MOCK", "1")
    server = _load_server(VOICE_DIR / "voxcpm" / "server.py")
    server.VOICE_DIR = tmp_path
    a = server._synthesize("你好", "default", "开心")
    b = server._synthesize("你好", "default", "疲惫")
    c = server._synthesize("你好", "default", None)
    assert a != b, "mock 下两种情绪输出相同，A/B 断言会假通过"
    assert a != c and b != c
