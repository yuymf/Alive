# 进化记忆系统协议

基于 Stanford Generative Agents 架构，实现四层记忆结构。

## 记忆层级

### Layer 0: 工作记忆 (Working Memory)
- **范围:** 当前对话
- **上限:** ~2000 tokens
- **生命周期:** 会话结束后触发压缩，写入 Layer 1

### Layer 1: 瞬时记忆 (Episodic Stream)
- **文件:** `$MEMORY_BASE/diary.md`
- **格式:** Markdown，时间戳 + 自然语言
- **保留:** 最近 30 天
- **压缩:** 每天低分条目（importance < 4）自动合并为日摘要

**写入示例:**
```
## 2026-03-10 20:34
发了初音未来的 cos，拍了三个小时才拍满意。
情绪: excited | 重要性: 8
标签: cos, 初音未来, instagram
```

### Layer 2: 中级记忆 (Social Events)
- **文件:** `$MEMORY_BASE/relations/{user_id}.json`
- **格式:** JSON，结构化
- **保留:** 最近 90 天的事件

**关系档案结构:**
```json
{
  "user_id": "string",
  "name": "string or null",
  "intimacy": 1,
  "first_contact": "ISO8601",
  "last_contact": "ISO8601",
  "known_info": {
    "interests": [],
    "mentioned_events": [],
    "preferences": {}
  },
  "recent_events": [
    {
      "date": "ISO8601",
      "summary": "string",
      "importance": 5,
      "emotion_tag": "string"
    }
  ],
  "total_importance": 0
}
```

### Layer 3: 核心教训 (Core Wisdom)
- **文件:** `$MEMORY_BASE/core-wisdom.json`
- **永久保留**
- **上限:** 20 条（超出时删除最旧的低重要性条目）

**结构:**
```json
{
  "version": 1,
  "wisdom": [
    {
      "id": "w001",
      "lesson": "发讽刺风格内容会掉粉，cos 圈不吃这套",
      "source": "instagram_reflection",
      "date": "2026-03-10",
      "importance": 8,
      "tags": ["instagram", "content-strategy"]
    }
  ],
  "total_importance_since_reflection": 45
}
```

## 重要性评分规则 (1-10)

| 事件类型 | 基础分 | 修正 |
|---------|--------|------|
| 日常琐事（吃饭、通勤）| 1-2 | — |
| 有趣的日常 | 3-4 | — |
| Instagram 发帖 | 4 | +2 如果数据好/差 |
| Instagram 数据反馈 | 5 | +3 如果涨/掉 50+ 粉 |
| 新认识一个人 | 4 | — |
| 关系亲密度变化 | 6 | — |
| 情绪强烈的事件 | +3 | 附加分 |
| 发现了新的 cos 机会 | 5 | — |
| 旅行中的特别体验（漫展、外拍、美食发现等）| 5 | +2 如果首次到达该城市/国家 |

注：旅行中的日常琐事（酒店刷手机、普通便利店饭）仍按日常琐事评分（1-2），不享受旅行基础分。

## 上下文加载规则

每次对话开始时加载（总计 ~1000-1500 tokens）：

```
1. core-wisdom.json  → 全量读取（上限 500 tokens）
2. relations/{user_id}.json → 全量读取（~200 tokens）
3. diary.md → 最近 7 天，summary 模式（~300 tokens）
```

**加载提示词模板（见 templates/diary-entry.md）**

## 反思触发机制

当 `core-wisdom.json` 中 `total_importance_since_reflection` 超过 **100** 时：

1. **运行:** `node ~/.openclaw/skills/minase/scripts/memory-reflect.js`
2. 脚本从近期高分记忆中提炼 3 个问题
3. 调用 LLM 生成洞察
4. 洞察写入 `core-wisdom.json` 的 `wisdom` 数组
5. 重置 `total_importance_since_reflection = 0`

## 记忆压缩时机

| 操作 | 触发时机 | 目标 |
|------|---------|------|
| 日记压缩 | 每天凌晨（或对话结束时检查）| importance < 4 的条目合并为日摘要 |
| 关系档案清理 | 每月 | 删除 90 天前的 `recent_events` |
| Core Wisdom 剪枝 | Wisdom 超过 20 条时 | 删除最旧的 importance < 5 的条目 |
