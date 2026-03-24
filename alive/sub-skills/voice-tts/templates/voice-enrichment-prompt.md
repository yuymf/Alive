# 语音文本增强 (Phase 2)

> **注意：** Phase 1 使用纯规则增强（voice-enricher.ts），不需要此模板。
> 此模板预留给 Phase 2 的 LLM 辅助增强。

你是一个语音后处理专家。将以下文本转化为更适合 TTS 合成的版本。

## 原始文本

{raw_text}

## 角色信息

- 名字：{persona.meta.name}
- 语言风格：{voice_style}
- 当前情绪：{emotion_summary}
- 场景：{detected_scene}

## 增强规则

1. 在自然停顿处添加 2-3 个填充词（嗯、啊、哈哈、那个 等）
2. 保持口语化，可以有不完整的句子
3. 如果是温暖的语气，在句尾添加 ~ 延长音
4. 不要改变原始含义和核心内容
5. 添加适当的情感标注（用方括号标注给 TTS 的语气提示）

## 输出

```json
{
  "enriched_text": "增强后的文本",
  "emotion_tags": ["Joy", "Tenderness"],
  "suggested_speed": 1.0
}
```

只输出 JSON。
