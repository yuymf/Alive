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

【生成质量控制】
- 标签数量限制：强制限制为4-5个，初稿阶段须插入1-2个高热度通勤词（如#早八穿搭 #松弛感穿搭 #穿撂感通勤），不得仅用冷门标签凑数
- BGM描述：禁止输出「推荐使用节奏鲜明的EDM」类空话套话，BGM字段须写明具体氛围词（如「鼓点带感的中毒循环」「清晨通勤BGM」），不得留空
- 英文专有名词改写：英文专有名词（如thousands of hours）必须改写为中文口语表达（如成千上万小时的训练），保持中文语感连贯
- 正文最低行数要求：小红书图文≥8行，抖音脚本≥12行（不含空行和动作标注行）
- 每50字内须出现一个具体信息点（数据/场景/情绪三选一），禁止连续2句以上无信息量的过渡句（如「你知道吗」「其实」「话说回来」）
- 正文必须包含至少1个「时间锚点」（如「上周」「三分钟前」「第二局」）或「具体数字」（如「5次」「第9分钟」），禁止通篇模糊描述
- Title口语开场：禁止以「穿得松弛点」「要/应该」等说教口吻开头，默认用「讲真」「真的」「说实话」等真实语气开场
- 字幕结尾明确化：分镜末尾「字幕弹出核心信息」必须写明具体文案内容，不得留空或写「字幕弹出核心信息」等模糊占位
- 跨平台一致性自检：生成内容包后，自动比对小红书与抖音版本中的时间/人物/事件等关键信息，发现矛盾则标记警告

请严格按照以上写作规范和爆款思维框架，生成一条完整的 {{platform_label}} 内容草稿。

{{output_format}}

{{extra_context}}
