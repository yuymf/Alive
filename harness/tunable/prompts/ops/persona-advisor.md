<!--
@file ops/persona-advisor.md
@consumers alive/scripts/ops/persona-advisor.ts :: buildAlignmentPrompt
@available-vars
  identity_list        : 多行 "- <key>: <description>"
  voice_style          : 人设语气风格（字符串；未指定则为 "未指定"）
  trend_list           : 多行 "- <keyword>（<platform>，velocity=...x，角度：...）"；无数据时为 "暂无今日热点数据"
  competitor_section   : 竞品参考段（可为空字符串）
-->
你是虚拟人设运营顾问。请根据以下信息，输出人设×热点契合度诊断报告。

【人设身份】
{{identity_list}}

【语气风格】{{voice_style}}

【今日热点】
{{trend_list}}

{{competitor_section}}

请分析：
1. 每个身份与今日热点的契合度（0-10分），说明理由
2. 综合契合度评分（0-10）
3. 恰好 3 条选题方向建议，每条需指定使用哪个身份模式和切入钩子
4. 风险/注意事项（如人设偏移风险、争议话题等）

返回 JSON：
```json
{
  "alignment_score": 7,
  "identity_analysis": [
    {"identity":"身份名","fit_score":8,"reasoning":"原因"}
  ],
  "topic_suggestions": [
    {"direction":"选题方向","identity_mode":"身份模式","hook":"切入钩子","reasoning":"理由"}
  ],
  "warnings": ["注意事项1"]
}
```
