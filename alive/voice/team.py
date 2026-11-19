#!/usr/bin/env python3
"""Load alive/voice/team.yaml (Path A mapping). Tiny parser — schema is fixed."""
from __future__ import annotations

from pathlib import Path

TEAM_YAML = Path(__file__).resolve().parent / "team.yaml"
_REQUIRED = {"id", "agent_name", "voice", "cloned", "worker_port"}


def load_team(path: Path | str | None = None) -> dict:
    src = Path(path or TEAM_YAML)
    members: list[dict] = []
    cur: dict | None = None
    for raw in src.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        s = line.strip()
        if s in ("members:", "---"):
            continue
        if s.startswith("- "):
            if cur:
                members.append(cur)
            cur = {}
            s = s[2:].strip()
            if not s:
                continue
        if cur is None or ":" not in s:
            continue
        key, val = s.split(":", 1)
        key, val = key.strip(), val.strip().strip('"').strip("'")
        if key == "cloned":
            cur[key] = val.lower() == "true"
        elif key == "worker_port":
            cur[key] = int(val)
        else:
            cur[key] = val
    if cur:
        members.append(cur)
    for member in members:
        missing = _REQUIRED - member.keys()
        if missing:
            raise ValueError(f"team member missing {missing}: {member}")
    names = [m["agent_name"] for m in members]
    if len(names) != len(set(names)):
        raise ValueError(f"duplicate agent_name in team.yaml: {names}")
    ids = [m["id"] for m in members]
    if len(ids) != len(set(ids)):
        raise ValueError(f"duplicate id in team.yaml: {ids}")
    return {"members": members}


def resolve_member(persona: str, path: Path | str | None = None) -> dict:
    wanted = (persona or "").strip()
    for member in load_team(path)["members"]:
        if member["id"] == wanted or member["agent_name"] == wanted:
            return member
    raise KeyError(wanted)


def print_rows(path: Path | str | None = None) -> list[str]:
    rows = []
    for member in load_team(path)["members"]:
        cloned = "1" if member["cloned"] else "0"
        rows.append(
            f"{member['id']} {member['agent_name']} {member['voice']} "
            f"{member['worker_port']} {cloned}"
        )
    return rows


def main() -> int:
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "print"
    if cmd == "print":
        sys.stdout.write("\n".join(print_rows()) + "\n")
        return 0
    sys.stderr.write("usage: team.py print\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
