<!--
@file ops/topic-hook-generator.md
@consumers alive/scripts/ops/topic-generator.ts :: generateHooksViaLLM
@available-vars
  niche        : 赛道/领域名
  count        : 要生成的钩子数量
  json_schema  : JSON schema 字符串（如 {"hooks":["钩子1","钩子2"]}）
-->
你是短视频钩子公式专家。为「{{niche}}」赛道生成 {{count}} 个高转化的开头钩子公式。
要求：每个钩子 11-20 字，使用反问 / 冲突 / 悬念 / 数字冲击手法。
直接输出 JSON：{{json_schema}}
