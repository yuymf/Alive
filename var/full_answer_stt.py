#!/usr/bin/env python3
"""第三口径交叉验证：整轮录音（不限前 6s）经同一批式 whisper STT 回听，数完整回答字数。

目的：排除「8s 日志窗只抓到首句」的歧义（上一卡卡面口径争议）。
改前/改后都用同一 STT 端点、同一 wav 采样率、同一字数函数。
"""
from __future__ import annotations

import importlib.util
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EV = ROOT / "var/voice-evidence/t_b2d062f6"
spec = importlib.util.spec_from_file_location("lat_harness", ROOT / "alive/voice/latency_e2e.py")
h = importlib.util.module_from_spec(spec)
sys.modules["lat_harness"] = h
spec.loader.exec_module(h)


def cjk_len(s):
    return sum(1 for ch in (s or "") if not ch.isspace())


def measure(rel_dir):
    out = []
    for p in sorted((EV / rel_dir).glob("latency_*.wav")):
        if "_first6s" in p.name:
            continue
        try:
            txt = h.stt_wav(p.read_bytes())
            out.append({"file": p.name, "chars": cjk_len(txt), "text": txt})
        except Exception as exc:
            out.append({"file": p.name, "error": repr(exc)})
    return out


def main():
    res = {}
    for label, rel in (("before", "final_before"), ("after", "final_steady")):
        rows = measure(rel)
        res[label] = rows
        chars = [r["chars"] for r in rows if "chars" in r]
        print(f"{label}: n={len(chars)} chars={chars} median={statistics.median(chars) if chars else None}")
        for r in rows:
            print(f"   {r['file']}: {r.get('chars', r.get('error'))}  {r.get('text','')[:60]!r}")
    b = [r["chars"] for r in res["before"] if "chars" in r]
    a = [r["chars"] for r in res["after"] if "chars" in r]
    if b and a:
        mb, ma = statistics.median(b), statistics.median(a)
        print(f"\n整轮完整回答字数中位: 改前 {mb} -> 改后 {ma} "
              f"({'未下降' if ma >= mb else '下降!'})")
        print(f"相对差: {abs(ma-mb)/mb:.1%}")
    (EV / "full_answer_stt.json").write_text(
        json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nwritten: {EV / 'full_answer_stt.json'}")


if __name__ == "__main__":
    main()
