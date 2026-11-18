#!/usr/bin/env python3
"""流式 transducer 尾部右上下文 flush（Step3-P0, t_0b114497）。

为什么存在：sherpa-onnx streaming zipformer 以固定 chunk + 右上下文 lookahead
解码，`is_ready()` 要等够一个 chunk 的后续帧才为 True。话音结束时最后 ~320ms
音频帧（末二字「状态」）还卡在编码器右上下文缓冲里；flush 时 `decode_all()`
的 `while is_ready()` 一次都不成立 ⇒ 终句确定性停在「…磁盘」，coverage 0.885。

`accept_waveform` 喂零帧（真实波形帧，不是 input_finished() 这类 API 捷径）
把右上下文补满，最后一个 chunk 变成 ready，再交给 `decode_all()` 解出末字。
增量 20ms 步 + 上限：一旦 ready 立刻停，避免多解纯静音 chunk 拖延迟。
"""
from __future__ import annotations

import numpy as np

STEP_MS = 20  # 与客户端推流帧长一致


def flush_tail_pad(rec, stream, pad_ms: float, *, sample_rate: int = 16000,
                    step_ms: int = STEP_MS) -> int:
    """喂尾部静音直到最后一个 encoder chunk ready；返回实际喂入的步数。

    `pad_ms <= 0` 是刻意保留的反例开关：等价于修复前行为（终句截断），
    供 `test_step3_tail_flush.py` 做击穿对照，生产默认 400。
    """
    max_steps = max(0, int(pad_ms / step_ms))
    if max_steps == 0:
        return 0
    pad = np.zeros(int(sample_rate * step_ms / 1000), dtype=np.float32)
    fed = 0
    for _ in range(max_steps):
        if rec.is_ready(stream):
            break
        stream.accept_waveform(sample_rate, pad)
        fed += 1
    return fed
