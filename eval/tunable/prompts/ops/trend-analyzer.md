<!--
@file ops/trend-analyzer.md
@consumers alive/scripts/ops/trend-analyzer.ts :: buildRelevancePrompt
@available-vars
  trend_list            : 多行 "- <keyword> (<platform>, 来源=..., velocity=..., priority=..., rank=...)"
  persona_identities    : 人设身份摘要字符串
  topic_count           : 最多选几个话题（数字）
  velocity_requirement  : 速度门槛语句（冷启动 / 低速 / 正常 三态）
  json_schema           : 返回 JSON schema 字符串
-->
你是一个内容运营分析师。以下是今日平台趋势信号（包含三种来源）：

来源说明：
- 搜索：用户主动搜索命中的高互动内容关联 tag —— 代表真实用户需求
- 赛道 Tag：搜索与竞品分析中验证的高互动内容 tag —— 代表算法认可的赛道
- 热榜：平台编辑型热搜/热榜 —— 公共议题曝光，不一定适合做赛道内容

{{trend_list}}

虚拟人设身份：{{persona_identities}}

请从以上趋势信号中筛选出最多 {{topic_count}} 个可蹭的话题，要求：
1. 与虚拟人的某个身份相关，或可借势切入
2. {{velocity_requirement}}
3. 避免政治敏感、负面争议话题
4. 尽量让选中话题覆盖不同身份（identity_mode），避免全部集中在同一身份
5. 如果没有合适的话题，返回空数组 {"topics":[]}
6. 避免标题党/误导性话题：对比标题与描述，如果标题字面意思与描述事实不符（如标题暗示"已变"，描述说"无此政策"），不要选择该话题。如果话题标记了⚠️疑似标题党，需要格外谨慎。对于标记了[无描述，无法核实事实]的话题，也要审慎评估，优先选择有描述佐证的话题。如果某个话题可能存在争议但无法确认，在 hook_angle 中注明"⚠️ 需核实事实"。
7. 跳过标记为📢广告的话题，不要选择广告内容。
8. 【重要】当相关性接近时，优先选择"搜索"和"赛道 Tag"来源的信号，它们代表真实用户互动和算法验证。"热榜"只作为补充，不要让热榜压过赛道 tag。tag 型关键词（如 #电竞女孩）优先保留原貌。
9. 按 priority 分数从高到低优先选择。
10. 【多样性】如果选择了 3 个以上话题，确保至少包含 1 个"热榜"来源的话题（作为公共议题补充），以及至少 2 个"搜索"或"赛道 Tag"来源的话题。

对每个筛选出的话题，给出：
- keyword: 必须与上方列表中的某个话题关键词完全一致（不要缩写或改写）
- platform: 来源平台（必须与上方列表一致）
- velocity_score: 速度分
- hook_angle: 用什么角度切入（结合人设）
- identity_mode: 使用哪个身份，只能是以下四选一：esports（电竞解说）/ singer（歌手）/ racer（赛车手）/ daily（日常生活）

以 JSON 对象返回，格式：
