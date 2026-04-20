<!--
@file ops/topic-generator-content.md
@consumers alive/scripts/ops/topic-generator.ts :: buildContentPrompt
@available-vars
  persona_description  : 人设描述（一句话）
  persona_block        : 多行 "你是... / 当前以... / 声线：... / 语感模式：... / 标志性语录：..."
  platform             : "xhs" | "douyin"
  platform_label       : "小红书图文" | "小红书视频脚本" | "抖音视频脚本"
  platform_style       : 运营配置里的平台风格字符串
  trend_keyword        : 热点关键词
  trend_platform       : 热点来源平台
  trend_velocity       : "2.7"
  trend_hook_angle     : 切入角度
  identity_mode        : 身份模式 key
  identity_label       : 身份中文名
  voice_style          : 声线风格
  identity_voice       : 身份语感模式
  sample_lines         : 标志性语录 block
  trend_intel          : 完整的「热点情报」block（已排好版）
  viral_framework      : 「爆款思维框架」block
  guidelines           : 平台写作规范 block
  prohibitions         : 「绝对禁止」block
  output_format        : 输出 JSON schema / 格式说明 block
  extra_context        : 额外补充上下文（可为空）
-->
【角色】
{{persona_block}}

【创作任务】
借势热点「{{trend_keyword}}」创作一条{{platform_label}}内容，目标是做出这条热点下最有人格辨识度、最容易引发互动的内容。

{{trend_intel}}

{{viral_framework}}

{{guidelines}}

{{prohibitions}}

请严格按照以上写作规范和爆款思维框架，生成一条完整的 {{platform_label}} 内容草稿。

{{output_format}}

{{extra_context}}
