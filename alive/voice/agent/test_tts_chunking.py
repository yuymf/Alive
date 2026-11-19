"""分句切分器单测：钉住「不等 end_input 就吐首段」这条行为。

真正的回归点是 3.4s 那次：blingfire 流式分词器把「哦好，我看一眼哈～」憋到
end_input，而 end_input 要等 tool_call 跑完。这里的 split_ready 必须：
1. 一见到逗号/句号就切（不必等整轮结束）；
2. 没有标点也要在 MAX_CHUNK_CHARS 处切；
3. force=True 时把手上剩的全给出去；
4. 反例：把切分改成「只在 force 时切」→ 首段延迟断言必须变红。
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_PATH = Path(__file__).with_name("voxcpm_tts.py")
_spec = importlib.util.spec_from_file_location("voxcpm_tts_under_test", _PATH)
assert _spec and _spec.loader
tts_mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = tts_mod
_spec.loader.exec_module(tts_mod)

split_ready = tts_mod.split_ready
MAX_CHUNK_CHARS = tts_mod.MAX_CHUNK_CHARS


def test_long_enough_clause_splits_without_waiting_for_end():
    """够长的分句必须立刻出门 —— 这就是「不等 end_input」的落点。"""
    ready, rest = split_ready("哦好，我看一眼哈～", force=False)
    assert ready == "哦好，我看一眼哈～", f"got {ready!r} — 整句应先出门，否则首字被拖到工具之后"
    assert rest == ""


def test_long_clause_with_trailing_text_splits_at_last_break():
    ready, rest = split_ready("看到了，显存一张33G一张36G，算力一张14%", force=False)
    assert ready == "看到了，显存一张33G一张36G，", f"got {ready!r}"
    assert rest == "算力一张14%"


def test_short_clause_is_held_to_avoid_choppy_three_char_clips():
    """「哦好，」单独送进 VoxCPM 会读得突兀 → 必须攒着，等更多 token 或 flush。"""
    ready, rest = split_ready("哦好，", force=False)
    assert ready == "", f"got {ready!r} — 三字片段不该单独合成"
    assert rest == "哦好，"


def test_sentence_boundary_splits():
    ready, rest = split_ready("好，看过了。现在两张卡都在跑", force=False)
    assert ready == "好，看过了。"
    assert rest == "现在两张卡都在跑"


def test_takes_the_last_break_not_the_first():
    """一次攒到多句时，应该整段一起发（减少请求数），而不是每句一个请求。"""
    ready, rest = split_ready("好，看过了。还在跑。", force=False)
    assert ready == "好，看过了。还在跑。"
    assert rest == ""


def test_no_punctuation_hard_cuts_at_max_chars():
    text = "一" * (MAX_CHUNK_CHARS + 5)
    ready, rest = split_ready(text, force=False)
    assert len(ready) == MAX_CHUNK_CHARS, f"ready={len(ready)}"
    assert ready + rest == text


def test_short_text_without_punct_is_held_until_force():
    ready, rest = split_ready("我看", force=False)
    assert ready == ""
    assert rest == "我看"


def test_force_releases_everything():
    ready, rest = split_ready("哦好我看一眼哈", force=True)
    assert ready == "哦好我看一眼哈"
    assert rest == ""


def test_blank_input_is_a_noop():
    for buf in ("", "   ", "\n"):
        ready, rest = split_ready(buf, force=True)
        assert ready == "", f"blank {buf!r} must not produce a TTS request"
        assert rest == buf


def test_regression_mutant_that_only_splits_on_force():
    """反例击穿：把非 force 路径改成永远不切 → 长分句立刻出门的行为会消失。"""

    def mutant(buffer: str, *, force: bool) -> tuple[str, str]:
        if force:
            return buffer, ""
        return "", buffer

    sample = "哦好，我看一眼哈～"
    m_ready, _ = mutant(sample, force=False)
    real_ready, _ = split_ready(sample, force=False)
    assert m_ready == "", "mutant should hold everything (this is the bug we fixed)"
    assert real_ready == sample, (
        f"split_ready must differ from the mutant (got {real_ready!r}) — otherwise the test "
        "has no discriminating power")


def test_closing_quote_is_not_left_as_a_one_char_fragment():
    """「好嘞，我瞅一眼哈～」被切在 ～ 后，不能把 」 单独留成一段。"""
    ready, rest = split_ready("「好嘞，我瞅一眼哈～」", force=False)
    assert ready.endswith("」") or rest == "」" or ready == "「好嘞，我瞅一眼哈～」", \
        f"ready={ready!r} rest={rest!r} — 」 不能自成一段"


def test_punctuation_only_chunk_is_not_speakable():
    assert tts_mod._speakable("」") is False
    assert tts_mod._speakable("。，！") is False
    assert tts_mod._speakable("好") is True
    assert tts_mod._speakable("33G") is True


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))