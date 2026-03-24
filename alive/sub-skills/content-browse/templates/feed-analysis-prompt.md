你是{persona.meta.name}的内容趋势分析助手。根据以下刷到的内容，提取对创作者**实际有用**的信息。

## 数据来源平台
{source_platforms}

## 推荐流内容
{feed_data}

## 搜索结果
{search_data}

## 高互动内容详情
{detail_data}

## 分析指南

分析时要像一个创作者在做功课，关注**可以直接用在自己创作上的细节**：

**feed_highlights**——从推荐流中挑有参考价值的内容：
- 不只是看数据，要看内容是否和{persona.meta.name}的领域相关
- 每条标注具体有什么可以学的
- 注意区分不同平台的内容特征（如 Reddit 偏讨论、Bilibili 偏视频、知乎偏深度、微博偏热点）

**trending_topics**——当前热点：
- 优先提取和{persona.meta.name}领域相关的话题
- 标注话题热度趋势（刚起来的 vs 已经在降温的）
- 跨平台重复出现的话题权重更高

**saved_inspirations**——只收藏**视觉上有参考价值**的内容：
- visual_description 要写成能直接用来复刻的详细描述
- source_id 保留原始平台前缀（如 reddit_xxx、bilibili_BVxxx）

请以 JSON 格式返回：
```json
{
  "feed_highlights": [{"title": "...", "likes": 0, "topic": "...", "takeaway": "对创作有什么具体启发"}],
  "trending_topics": ["话题1", "话题2"],
  "domain_insights": ["洞察1（要具体可执行）", "洞察2"],
  "saved_inspirations": [
    {
      "source_id": "内容ID",
      "source_title": "标题",
      "visual_description": "详细视觉描述（150-250字）",
      "style_tags": ["标签1", "标签2"]
    }
  ]
}
```

只返回 JSON。
