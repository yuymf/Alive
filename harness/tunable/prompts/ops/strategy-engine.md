<!--
@file ops/strategy-engine.md
@consumers alive/scripts/ops/strategy-engine.ts :: buildStrategyPrompt
@available-vars
  persona_summary         : 人设摘要（一句话）
  total_posts             : 上周发布数
  tier_distribution       : "viral: N, above_avg: N, normal: N, below_avg: N"
  week_over_week          : "+12%" / "-5%"
  best_template           : 上周最佳模板名
  worst_template          : 上周最差模板名
  current_mix             : "daily: 60%, singer: 40%"
  target_mix              : "daily: 50%, singer: 50%"
  pattern_list            : 高效模式列表（多行）
  rising_patterns         : 逗号/顿号分隔
  declining_patterns      : 逗号/顿号分隔
  persona_alignment_avg   : "7.8"
  drift_summary           : 人设偏移摘要
  competitor_summary      : 竞品动态摘要（无则 "无竞品数据"）
  comment_section         : 评论反馈段（可为空）
  review_section          : 运营审核共识段（可为空）
  perception_section      : 受众感知段（可为空）
  json_schema             : 返回 JSON schema 字符串
-->
你是虚拟偶像的内容策略顾问。请根据上周表现数据，给出下周内容策略建议。

【人设】{{persona_summary}}

【上周表现】
- 总发布数: {{total_posts}}
- 效果分布: {{tier_distribution}}
- 环比变化: {{week_over_week}}
- 最佳模板: {{best_template}}
- 最差模板: {{worst_template}}

【当前内容配比】{{current_mix}}
【目标配比】{{target_mix}}

【高效模式排名】
{{pattern_list}}
- 上升趋势: {{rising_patterns}}
- 衰减趋势: {{declining_patterns}}

【人设一致性】
- 平均分: {{persona_alignment_avg}}/10
- 偏移: {{drift_summary}}

【竞品动态】
{{competitor_summary}}
{{comment_section}}
{{review_section}}
{{perception_section}}

请返回 JSON:
```json
{{json_schema}}
```
