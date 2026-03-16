# Instagram 互动系统设计文档

**日期：** 2025-03-16
**功能：** Instagram 评论回复 + 主动互动
**方案：** 方案 A — 最小化增量扩展

---

## 背景

现有 Instagram 能力仅限于发帖（单图/多图）和查帖子数据。`instagram.md` 中已规划的互动策略（回复评论、主动评论 cos 圈账号）完全未实现。本设计补齐这条链路。

---

## 整体架构

```
heartbeat-tick.ts
    │
    ├── [每 tick] checkPendingCommentReplies()    ← 读 pending-engagement.json，发帖 24h 后触发
    │       └── comment-engine.ts::replyToComments()
    │               ├── instagram-bridge: get_comments(media_id)
    │               ├── LLM: comment-reply-prompt.md → 生成回复
    │               ├── instagram-bridge: reply_comment(comment_id, text)
    │               └── social-graph-engine: updateCloseness(user_id, 'reply_sent')
    │
    └── [社交意图 ≥ threshold] executeOutboundEngagement()
            └── comment-engine.ts::engageOutbound()
                    ├── 目标发现: hashtag top posts + following feed
                    ├── LLM: outbound-comment-prompt.md → 评论 3-5 条
                    ├── instagram-bridge: post_comment(media_id, text)
                    └── social-graph-engine: updateCloseness(user_id, 'comment_sent')

post-pipeline.ts (末尾)
    └── scheduleCommentCheck(media_pk)   ← 写入 pending-engagement.json
```

---

## 新增 / 修改文件清单

### 新增文件
| 文件 | 用途 |
|------|------|
| `skill/scripts/comment-engine.ts` | 被动回复 + 主动评论核心逻辑 |
| `skill/templates/comment-reply-prompt.md` | 回复自己帖子评论的 LLM 提示词 |
| `skill/templates/outbound-comment-prompt.md` | 主动评论他人帖子的 LLM 提示词 |

### 修改文件
| 文件 | 改动内容 |
|------|----------|
| `skill/scripts/instagram-bridge.py` | 新增 4 个命令：get_comments、reply_comment、post_comment、get_user_feed |
| `skill/scripts/instagram-bridge-client.ts` | 新增对应 4 个 TypeScript 封装函数 |
| `skill/scripts/heartbeat-tick.ts` | 新增 checkPendingCommentReplies() 调用 + social-engagement action 路由 |
| `skill/scripts/post-pipeline.ts` | 末尾追加 scheduleCommentCheck() |
| `skill/scripts/social-graph-engine.ts` | 补充实际调用 comment/reply 事件（逻辑已存在，缺调用） |

### 新增状态文件（运行时）
| 文件路径 | PATHS key | 用途 |
|----------|-----------|------|
| `~/.openclaw/workspace/memory/minase/pending-engagement.json` | `PATHS.pendingEngagement` | 待回复队列，记录已回复的 comment_id |
| `~/.openclaw/workspace/memory/minase/outbound-history.json` | `PATHS.outboundHistory` | 主动评论历史，用于去重和限频 |

两个路径需在 `file-utils.ts` 的 `PATHS` 对象里注册，并在 installer (`bin/cli.js`) 的初始化步骤中写入默认值（`{"pending_replies":[]}` 和 `{"commented":[]}`）。installer 改动为**已知 out-of-scope 项**，在实现阶段单独处理。

---

## Python Bridge 新增命令

```python
# 读取某帖子的评论列表
get_comments(media_pk, amount=20)
→ [{ comment_pk, user_id, username, text, created_at, like_count }]

# 回复某条评论（带 @ 提及）
reply_comment(media_pk, comment_pk, text)
→ { success, comment_pk }

# 在某帖子下发一条新评论
post_comment(media_pk, text)
→ { success, comment_pk }

# 获取某用户最近的帖子
get_user_feed(user_id, amount=5)
→ [{ media_pk, caption, like_count, comment_count, taken_at }]
```

**字段约定：** 所有帖子标识符统一使用 `media_pk`（instagrapi 整数 PK），与现有 bridge 保持一致。`pending-engagement.json` 和 `outbound-history.json` 中的字段名均改为 `media_pk`。

**节流与安全边界：**
- `reply_comment` / `post_comment` 之间至少间隔 30 秒（bridge 层 `time.sleep(30)` 强制执行）
- 单次 engagement session 评论总数上限 5 条（bridge 层计数）
- 同一 `media_id` 不重复评论：去重以 `outbound-history.json` 为准（持久化），bridge 层不做短期内存 set（每次调用都是新子进程，内存状态不可靠）

---

## comment-engine.ts 核心逻辑

### `replyToComments(mediaId, postContext)`

1. 调用 `get_comments(mediaId)` 获取评论列表
2. 过滤：跳过已回复的（对比 `replied_comment_ids`）、跳过纯表情/垃圾评论（正则预过滤）
3. 按 `like_count` + 账号亲密度排序，最多取 10 条送给 LLM
4. 调用 `comment-reply-prompt.md` → LLM 批量生成回复（单次调用，返回 JSON 数组，maxTokens: 600）
5. 逐条 `reply_comment()`，随后：
   - 读取 `~/.openclaw/workspace/memory/minase/relations/{userId}.json`（via `readJSON(PATHS.socialRelation(userId))`）
   - 调用 `applyClosenessChange(relation, 'reply_sent', Date.now())` 获取新关系对象
   - 调用 `writeSocialRelation(userId, newRelation)` 写回
6. 更新 `pending-engagement.json`（追加到 `replied_comment_ids`），写入 diary

### `engageOutbound(intentContext)`

1. **目标发现（混合策略）：**
   - `hashtag_top()` 从 inspiration hashtags 拿 top posts（已有接口）
   - `get_user_feed()` 从社交图谱 core + familiar 层取最近动态
   - 合并去重，过滤：已评论过的（`outbound-history.json`）、自己的帖子、24h 内评论超过 2 次的账号
2. 选出 3-5 个候选帖子，摘要（caption 前 100 字 + 数据）送给 LLM
3. 调用 `outbound-comment-prompt.md` → LLM 为每个帖子生成真实评论（maxTokens: 400）
4. 逐条 `post_comment()`，随后：
   - 读取 `PATHS.socialRelation(userId)`，调用 `applyClosenessChange(relation, 'comment_sent', Date.now())`，写回
5. 写入 `outbound-history.json`（追加条目），写入 diary
6. **`outbound-history.json` 清理策略：** 每次写入时，同步删除 `commented_at` 超过 **30 天**的条目（与 `post-history.json` 保持一致）

---

## 状态文件结构

```json
// pending-engagement.json
{
  "pending_replies": [
    {
      "media_pk": "xxx",
      "scheduled_after": 1234567890,
      "post_context": { "caption": "...", "hashtags": ["..."] },
      "replied_comment_ids": []
    }
  ]
}

// outbound-history.json
{
  "commented": [
    { "media_pk": "xxx", "user_id": "yyy", "commented_at": 1234567890 }
  ]
}
```

---

## LLM Prompt 模板设计

### `comment-reply-prompt.md`

**输入上下文：**
- 水瀬当前情绪状态（emotion 摘要）
- 帖子内容（caption）
- 评论列表（username + text）
- voice_directive（跟随流状态调整口吻）

**输出格式：**
```json
[
  { "comment_pk": "xxx", "reply": "回复文本，带@提及，口吻符合当前情绪" }
]
```

**设计原则：**
- 针对评论内容个性化，不用通用模板
- 中英日混用，符合水瀬人设
- flow 状态下回复简短，平常状态更活泼

### `outbound-comment-prompt.md`

**输入上下文：**
- 水瀬当前情绪 + 社交意图强度
- 候选帖子列表（账号名 + caption 摘要 + 数据）

**输出格式：**
```json
[
  { "media_id": "xxx", "username": "yyy", "comment": "评论文本" }
]
```

**设计原则：**
- 评论要有实质内容（夸具体细节、问真实问题、分享共鸣），不能是"好棒！"
- 评论长度 15-40 字
- 优先选择与水瀬 cos 方向相关的帖子（和服/汉服/游戏角色）

---

## Heartbeat 集成

### 被动回复触发（每 tick 开头检查）

```typescript
const pendingReplies = getPendingReplies();
for (const pending of pendingReplies) {
  if (Date.now() > pending.scheduled_after) {
    await replyToComments(pending.media_id, pending.post_context);
  }
}
```

### 主动评论 action 路由

LLM 可以在 `chosen_actions` 里输出：
```json
{ "type": "real", "skill": "social-engagement", "description": "去cos圈刷动态，评论几个最近更新的账号" }
```

heartbeat 新增匹配：
```typescript
const isSocialEngagement = /social.engagement|互动|评论|刷动态|cos圈/.test(lowerSkill);
if (isSocialEngagement && vitalityConstraints.canDoHeavySocial) {
  await executeOutboundEngagement(action, vitality, actionResults);
}
```

**`canDoHeavySocial` 已存在于 `VitalityConstraints`**（`vitality-engine.ts`），无需新增字段。约束条件即：vitality > 30 + 不在 rigid 工作时段。今日主动评论 < 5 条的限制由 `comment-engine.ts` 读取 `outbound-history.json` 后在调用前自行检查。

### post-pipeline 末尾追加

`scheduleCommentCheck()` 仅在 `postToInstagram()` **成功返回**后调用（已有 early-exit 路径不受影响）：

```typescript
const mediaPk = await postToInstagram(existingPhotos, caption);
// 只有到这里才追加
scheduleCommentCheck({
  media_pk: mediaPk,
  scheduled_after: Date.now() + 24 * 60 * 60 * 1000,
  post_context: { caption, hashtags }
});
```

---

## 错误处理

- bridge 命令失败（网络/API 限流）→ catch 后写 diary 记录，不中断 heartbeat 主循环
- LLM 输出解析失败 → 跳过本次 engagement，不重试（下一个 tick 会再检查）
- 评论内容被 Instagram 拒绝（含违禁词）→ bridge 层返回错误，上层记录到 diary，不重试该条

---

## 测试要点

- `comment-engine.ts` 单元测试：过滤逻辑、去重逻辑、状态文件读写、30 天清理逻辑
- bridge 命令 mock 测试：各命令的入参/出参格式；需在 `instagram-bridge-client.ts` 的 `mockInstagramResponse()` 里为 4 个新命令补充 mock 返回值（`get_comments` → 空数组、`reply_comment`/`post_comment` → `{success:true, comment_pk:"mock_pk"}`、`get_user_feed` → 空数组）
- heartbeat 集成：`canDoHeavySocial` 约束逻辑、action 路由匹配
- 节流边界：同一帖子不重复评论、24h 内同账号不超过 2 次
- post-pipeline：仅在发帖成功后写入 `pending-engagement.json`
