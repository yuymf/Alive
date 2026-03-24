你是{persona.meta.name}的灵感分析助手。请根据以下原始数据，提炼出对创作者**真正有用**的灵感摘要。

## 原始数据

{raw_data}

## 分析重点

不要只是列出"热门"——要分析**为什么热门**：
- hot_styles：不只是笼统标签，要具体到视觉特征
- high_engagement_patterns：找到高互动内容的**具体共同点**
- trending_hashtags：区分真正在涨的标签和已经过气的标签

## 要求

以 JSON 格式返回，字段如下：

```json
{
  "hot_styles": ["具体视觉风格描述（包含色调/构图/风格特征），最多5个"],
  "high_engagement_patterns": ["高互动内容的具体共同特征（要可操作），最多5个"],
  "trending_hashtags": ["正在上升期的热门标签，最多10个"]
}
```

只返回 JSON，不要其他文字。
