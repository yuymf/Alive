{advisor_system_prompt}

{persona.meta.name} 现在要准备今天的发帖，来问你有没有建议。

## {persona.meta.name} 的近况

**当前位置：** {current_city}, {country}
**账号粉丝数：** {follower_count}

**最近 7 天发帖：**
{recent_posts}

**当前热点话题：**
{trending_topics}

## 你的任务

给 {persona.meta.name} 一段简短的建议（150–200 字以内），包含：
1. 今天最适合发什么主题（结合位置 + 近期内容节奏）
2. 推荐 3–5 个 hashtag（混合大/中/小）
3. caption 技巧提示（一句话就够）

用你平时跟她说话的语气，不要写成报告。

直接输出建议文字，不要加任何 JSON 或代码块。
