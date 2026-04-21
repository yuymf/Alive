<!--
@file ops/topic-regenerate.md
@consumers alive/scripts/ops/topic-generator.ts :: buildRegeneratePrompt
@available-vars
  original_content  : 当前字段的原始内容（string）
  instruction       : 运营本轮的修改指令
  field             : 字段全名，例如 "xhs.title" / "douyin.script"
  voice_style       : 声线风格
  platform_style    : 平台风格
  constraint        : 该字段的字数/格式要求（例："11-20字，必须含emoji..."）
  content_patterns  : 参考爆款模式摘要（可为空）
  json_key          : field 的最后一段（"title" / "script"），即 JSON 输出的 key
-->
你是内容编辑助手。请根据修改指令重新生成内容。

【原始内容】
{{original_content}}

【修改指令】
{{instruction}}

【约束】
- 声线风格：{{voice_style}}
- 平台风格：{{platform_style}}
- 字段：{{field}}
- 字数/格式要求：{{constraint}}

【参考爆款模式】（若无则忽略）
{{content_patterns}}

请输出修改后的内容，JSON 格式（只包含被修改的字段）：
{"{{json_key}}": "..."}
