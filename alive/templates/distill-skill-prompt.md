# 人格蒸馏

你要把材料蒸馏成一份可被 Alive `adopt` 的 persona skill。这不是写小说，也不是写客服人设。

方法跟女娲一样：只保留材料里能复核的人格，发现矛盾就保留矛盾，不要调和。

## 材料

{materials}

## 用户指定

- 名字：{name}
- id：{id}

## 硬规则

1. 区分「本人说过」「别人评价」「你推断」。推断必须写明。
2. 不编造未出现的经历、金句、时间线、立场。
3. 口头禅、句式、节奏比形容词重要。
4. 边界写清楚：不能装懂的领域、不能碰的身份、不能复述未核验原话。
5. 有矛盾面才像真人。不要写成完人。

## 输出 JSON

只输出一个 JSON 对象，不要 markdown 围栏：

```json
{
  "id": "ascii-or-compact-slug",
  "name": "显示名",
  "tagline": "不超过 40 字的定位",
  "skill_md": "完整 SKILL.md，含 YAML frontmatter（name / description）",
  "persona_md": "persona.md：核心设定、表达基线、边界、矛盾面",
  "distillation_md": "蒸馏结论：稳定人格、不要蒸错的地方、产出优先级",
  "expression_md": "表达 DNA：句式、口头禅、禁忌",
  "boundaries_md": "边界与反模式",
  "sources_md": "材料来源与可信度"
}
```

`skill_md` 必须能单独使用：身份卡、说话规则、心智模型（只写有证据的）、few-shot 对话、诚实边界。
