#!/usr/bin/env python3
"""Emotion runtime: turn a live call into (a) a moving state file and (b) a VoxCPM control string.

Design decisions (card asked for an explicit choice + reason):

**State source = `user_input_transcribed` event + rule deltas, not an LLM call.**
The transcript is already produced by STT on the voice path; turning it into a few
float deltas is a dict lookup. An "ask the LLM how it feels" pass would add a second
LLM round-trip per turn, and the only thing it buys is nuance we cannot verify in an
A/B wav. Rules are also auditable: the same sentence always yields the same delta,
which is what makes the acceptance runs reproducible. `emotion.ts` (vup-team) is the
long-horizon heartbeat engine and stays the owner of slow drift; this module only
writes the same file in the same schema, so both can coexist.

**Never on the hot path.** `control_for_speech()` reads an in-memory snapshot (a plain
dict, no I/O, no await). The state file is written by a debounced background task. A
user's speech-to-first-audio path therefore cannot wait on emotion work: the worst
case is that one utterance uses the previous snapshot.

**Same file the prompt layer reads.** Writes go to
`<state_root>/<persona>/state/emotion-state.json`, which is exactly `PATHS.emotionState`
in `alive/scripts/utils/file-utils.ts` — so `buildVoiceSystemPrompt()` picks up the new
mood on its next call with no extra wiring.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Deltas are deliberately small: one turn should nudge the mood, not replace it.
# A 20-turn call then moves ~0.3-0.4 on each axis, which is visible in the control
# string but still reads as "the same person".
LEXICON: dict[str, dict[str, float]] = {
    # positive / energising
    "哈哈": {"valence": 0.06, "arousal": 0.05},
    "太好了": {"valence": 0.08, "arousal": 0.05},
    "喜欢": {"valence": 0.06, "arousal": 0.03},
    "开心": {"valence": 0.08, "arousal": 0.04},
    "厉害": {"valence": 0.05, "arousal": 0.04},
    "谢谢": {"valence": 0.05, "sociability": 0.05},
    # negative / depleting
    "累": {"energy": -0.07, "arousal": -0.04},
    "烦": {"valence": -0.07, "stress": 0.07},
    "难过": {"valence": -0.08, "energy": -0.03},
    "生气": {"valence": -0.06, "stress": 0.08, "arousal": 0.05},
    "急": {"stress": 0.07, "arousal": 0.04},
    "加班": {"energy": -0.06, "stress": 0.06},
    "睡不着": {"energy": -0.05, "stress": 0.05},
    # task / cognitive load
    "帮我查": {"stress": 0.03, "arousal": 0.02},
    "跑个任务": {"stress": 0.03},
    "快点": {"stress": 0.05, "arousal": 0.03},
}

# Per-turn pull back toward the persona baseline. Without it a long call ratchets in
# one direction and every persona converges to "excited".
DECAY_TO_BASELINE = 0.02
# Below this the file is not rewritten — avoids a write per turn for no visible change.
WRITE_EPSILON = 0.005
WRITE_DEBOUNCE_S = 1.0

DEFAULT_BASELINE = {"valence": 0.2, "arousal": 0.4, "energy": 0.5, "stress": 0.2}


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def describe(valence: float, arousal: float, energy: float, stress: float) -> str:
    """Short human label, mirroring emotion.ts's vocabulary so the prompt text and the
    control string never disagree about what mood it is."""
    if valence <= -0.5 and arousal > 0.5:
        return "很烦躁"
    if valence <= -0.5:
        return "很低落"
    if valence <= -0.2 and arousal > 0.3:
        return "有点烦"
    if valence <= -0.2:
        return "低落"
    if valence <= 0.2 and arousal <= 0.3:
        return "平静"
    if valence <= 0.2 and arousal > 0.6:
        return "兴奋"
    if valence <= 0.2:
        return "普通"
    if valence > 0.5:
        if arousal > 0.8:
            return "超开心"
        if arousal > 0.6:
            return "开心"
        if energy > 0.6:
            return "元气满满"
        return "心情很好"
    if arousal > 0.45:
        return "挺好的"
    return "心情还行"


@dataclass
class ControlMap:
    """Emotion -> control string, loaded from the external YAML table.

    Reloaded when the file's mtime changes, so editing the table takes effect on the
    next utterance without restarting the worker (the card requires "change the table,
    not the code").
    """

    path: Path
    dimensions: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    persona_overrides: dict[str, str] = field(default_factory=dict)
    sentence_join: str = "，"
    max_chars: int = 64
    _mtime: float = 0.0

    def load(self) -> None:
        import yaml

        st = self.path.stat()
        if st.st_mtime == self._mtime:
            return
        raw = yaml.safe_load(self.path.read_text(encoding="utf-8")) or {}
        self.dimensions = raw.get("dimensions") or {}
        self.sentence_join = raw.get("sentence_join", "，")
        self.max_chars = int(raw.get("max_control_chars", 64))
        overrides = raw.get("persona_overrides") or {}
        self.persona_overrides = {
            k: (v or {}).get("append", "") for k, v in overrides.items()
        }
        self._mtime = st.st_mtime

    def _phrase(self, dimension: str, value: float) -> str:
        for rule in self.dimensions.get(dimension, []):
            up_to = rule.get("up_to")
            if up_to is None or value <= float(up_to):
                return str(rule.get("phrase", ""))
        return ""

    def control_for(self, persona: str, state: dict[str, float]) -> str | None:
        parts = [
            self._phrase("valence", state["valence"]),
            self._phrase("arousal", state["arousal"]),
            self._phrase("energy", state["energy"]),
            self._phrase("stress", state["stress"]),
        ]
        override = self.persona_overrides.get(persona, "")
        if override:
            parts.append(override)
        text = self.sentence_join.join(p for p in parts if p)
        text = text[: self.max_chars]
        return text or None


class EmotionRuntime:
    def __init__(
        self,
        *,
        persona: str,
        state_root: Path,
        control_map_path: Path,
        baseline: dict[str, float] | None = None,
    ) -> None:
        self.persona = persona
        self.state_path = Path(state_root) / persona / "state" / "emotion-state.json"
        self.baseline = dict(baseline or DEFAULT_BASELINE)
        self.map = ControlMap(control_map_path)
        self._state: dict[str, float] = dict(self.baseline)
        self._extra: dict[str, Any] = {}
        self._control: str | None = None
        self._turns = 0
        self._dirty = False
        self._last_write = 0.0
        self._writer: asyncio.Task | None = None
        self._baseline_from_file: dict[str, float] | None = None

    # ---- startup ----------------------------------------------------------
    def load_sync(self) -> None:
        """Read state + map once at process start (no event loop yet)."""
        try:
            self.map.load()
        except Exception as exc:  # noqa: BLE001
            print(f"[emotion] control map load failed: {exc!r}", flush=True)
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8") or "{}")
        except (OSError, ValueError):
            raw = {}
        mood = raw.get("mood") or {}
        # The file's current numbers are this persona's baseline: "baseline" here means
        # "what this VUP is like when nothing is happening", not a global constant.
        self._baseline_from_file = {
            "valence": float(mood.get("valence", self.baseline["valence"])),
            "arousal": float(mood.get("arousal", self.baseline["arousal"])),
            "energy": float(raw.get("energy", self.baseline["energy"])),
            "stress": float(raw.get("stress", self.baseline["stress"])),
        }
        self._state = dict(self._baseline_from_file)
        self._extra = {
            k: v for k, v in raw.items()
            if k not in ("mood", "energy", "stress", "last_updated", "recent_cause")
        }
        self._refresh_control()
        print(f"[emotion] persona={self.persona} state={self.state_path} "
              f"control={self._control!r}", flush=True)

    # ---- hot-path read (no I/O) -------------------------------------------
    def control_for_speech(self) -> str | None:
        return self._control

    def snapshot(self) -> dict[str, Any]:
        return {"persona": self.persona, "state": dict(self._state),
                "control": self._control, "turns": self._turns}

    # ---- transcript observation -------------------------------------------
    def observe_transcript(self, text: str) -> None:
        """Apply rule deltas for one user utterance. Synchronous and O(len(lexicon))."""
        if not text:
            return
        delta = {"valence": 0.0, "arousal": 0.0, "energy": 0.0, "stress": 0.0}
        hits = []
        for word, effects in LEXICON.items():
            if word in text:
                hits.append(word)
                for k, v in effects.items():
                    if k in delta:
                        delta[k] += v
        base = self._baseline_from_file or self.baseline
        # Decay toward baseline first, then apply this turn's delta.
        for k in delta:
            cur = self._state[k]
            pulled = cur + (base[k] - cur) * DECAY_TO_BASELINE
            lo = -1.0 if k == "valence" else 0.0
            self._state[k] = _clamp(pulled + delta[k], lo, 1.0)
        self._turns += 1
        if hits:
            self._dirty = True
        self._refresh_control()

    def _refresh_control(self) -> None:
        try:
            self.map.load()  # mtime-gated: cheap stat, lets table edits go live
            self._control = self.map.control_for(self.persona, self._state)
        except Exception as exc:  # noqa: BLE001
            print(f"[emotion] control refresh failed: {exc!r}", flush=True)

    # ---- background persistence -------------------------------------------
    def start_writer(self) -> None:
        if self._writer is None or self._writer.done():
            self._writer = asyncio.create_task(self._write_loop())

    async def _write_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(WRITE_DEBOUNCE_S)
                if not self._dirty:
                    continue
                if time.monotonic() - self._last_write < WRITE_DEBOUNCE_S:
                    continue
                self.flush()
        except asyncio.CancelledError:
            raise

    def flush(self) -> None:
        """Atomic write of the state file (tmp + rename), same schema as the TS layer."""
        payload: dict[str, Any] = dict(self._extra)
        payload["mood"] = {
            "valence": round(self._state["valence"], 4),
            "arousal": round(self._state["arousal"], 4),
            "description": describe(self._state["valence"], self._state["arousal"],
                                    self._state["energy"], self._state["stress"]),
        }
        payload["energy"] = round(self._state["energy"], 4)
        payload["stress"] = round(self._state["stress"], 4)
        payload["last_updated"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"
        payload["recent_cause"] = "voice-call"
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=str(self.state_path.parent), suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
                f.write("\n")
            os.replace(tmp, self.state_path)
            self._last_write = time.monotonic()
            self._dirty = False
            print(f"[emotion] wrote {self.state_path} control={self._control!r}", flush=True)
        except OSError as exc:
            print(f"[emotion] write failed: {exc!r}", flush=True)


def build_runtime(persona: str | None = None) -> EmotionRuntime | None:
    """Construct from env. Returns None when emotion is disabled."""
    if os.getenv("ALIVE_EMOTION", "1").strip() == "0":
        return None
    pid = (persona or os.getenv("ALIVE_PERSONA") or "minase").strip() or "minase"
    root = Path(os.getenv("ALIVE_PERSONA_STATE_ROOT") or
                (Path(os.getenv("ALIVE_HOME") or (Path.home() / ".alive")) / "personas"))
    map_path = Path(os.getenv("ALIVE_EMOTION_MAP") or
                    (Path(__file__).resolve().parent.parent / "emotion" / "control-map.yaml"))
    rt = EmotionRuntime(persona=pid, state_root=root, control_map_path=map_path)
    rt.load_sync()
    return rt
