#!/usr/bin/env python3
"""Step2 路 A：persona → agent_name/voice/port 映射 + 每角色心情真差异。

失败模式（先于实现列出）：
1. 三个 id 映射到同一个 agent_name → dispatch 永远进同一个 worker
2. 未知 persona 被静默落到默认角色
3. report_mood 三份读到同一句硬编码
4. 缺 emotion-state.json 时编造心情（兜底伪造领域数据）
5. start-all 打印口与 yaml 不同源
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
VOICE = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(VOICE))

from team import TEAM_YAML, load_team, print_rows, resolve_member  # noqa: E402
from work_tools import read_own_mood  # noqa: E402


def test_team_yaml_has_three_distinct_roles() -> None:
    team = load_team(TEAM_YAML)
    ids = [m["id"] for m in team["members"]]
    names = [m["agent_name"] for m in team["members"]]
    ports = [m["worker_port"] for m in team["members"]]
    assert ids == ["minase", "guodegang", "ace-taffy"], ids
    assert len(set(names)) == 3, names
    assert len(set(ports)) == 3, ports
    assert all(n.startswith("alive-") for n in names), names
    by_id = {m["id"]: m for m in team["members"]}
    assert by_id["minase"]["voice"] == "default"
    assert by_id["minase"]["cloned"] is False
    assert by_id["guodegang"]["voice"] == "default"
    assert by_id["guodegang"]["cloned"] is False
    assert by_id["ace-taffy"]["voice"] == "ace-taffy"
    assert by_id["ace-taffy"]["cloned"] is True
    print("[test_team] PASS 3 distinct members", ids, names, ports)


def test_resolve_member_unknown_raises() -> None:
    try:
        resolve_member("not-a-role")
    except KeyError as e:
        assert "not-a-role" in str(e)
        print("[test_resolve] PASS unknown persona raises KeyError")
        return
    raise AssertionError("unknown persona must raise KeyError, not silently default")


def test_duplicate_agent_name_is_rejected(tmp_path: Path | None = None) -> None:
    p = Path(tempfile.mkdtemp(prefix="alive-team-dup-")) / "team.yaml"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        "members:\n"
        "  - id: a\n    agent_name: alive-same\n    voice: default\n    cloned: false\n    worker_port: 1\n"
        "  - id: b\n    agent_name: alive-same\n    voice: default\n    cloned: false\n    worker_port: 2\n",
        encoding="utf-8",
    )
    try:
        load_team(p)
    except ValueError as e:
        assert "duplicate agent_name" in str(e)
        print("[test_dup] PASS duplicate agent_name rejected:", e)
        return
    raise AssertionError("duplicate agent_name must raise")


def test_print_rows_matches_yaml() -> None:
    rows = print_rows()
    assert len(rows) == 3
    ids = [r.split()[0] for r in rows]
    agents = [r.split()[1] for r in rows]
    assert ids == [m["id"] for m in load_team()["members"]]
    assert agents == [m["agent_name"] for m in load_team()["members"]]
    print("[test_print] PASS\n" + "\n".join(rows))


def test_read_own_mood_differs_per_persona(tmp_path: Path | None = None) -> None:
    home = tmp_path or Path(tempfile.mkdtemp(prefix="alive-team-mood-"))
    if tmp_path is None:
        if home.exists():
            import shutil
            shutil.rmtree(home)
        home.mkdir(parents=True)
    moods = {
        "minase": "刚拍完一组外景，有点亢奋",
        "guodegang": "刚下了场相声，还在回味包袱",
        "ace-taffy": "刚播完一把游戏，状态拉满想营业",
    }
    for pid, desc in moods.items():
        p = home / "personas" / pid / "state" / "emotion-state.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps({"mood": {"description": desc, "valence": 0.4, "arousal": 0.5}, "energy": 0.6}),
            encoding="utf-8",
        )
    texts = []
    for pid, desc in moods.items():
        got = read_own_mood(persona=pid, alive_home=home)
        assert desc in got, f"{pid}: expected {desc!r} in {got!r}"
        assert "亢奋" in got or "包袱" in got or "营业" in got
        texts.append(got)
    assert len(set(texts)) == 3, texts
    missing = read_own_mood(persona="minase", alive_home=home / "does-not-exist")
    assert "说不清" in missing or "没有" in missing
    assert "亢奋" not in missing and "包袱" not in missing
    print("[test_mood] PASS pairwise-different\n " + "\n ".join(texts))
    print("[test_mood] PASS missing file does not fabricate domain mood:", missing)


def main() -> int:
    test_team_yaml_has_three_distinct_roles()
    test_resolve_member_unknown_raises()
    test_duplicate_agent_name_is_rejected()
    test_print_rows_matches_yaml()
    test_read_own_mood_differs_per_persona()
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
