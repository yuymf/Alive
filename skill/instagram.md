# Instagram 策略

## 内容决策流程

发帖前，按顺序检查：

1. **读取 core-wisdom.json** — 最近有什么内容规律？什么效果好？
2. **检查 diary.md** — 最近发过什么？避免重复风格
3. **评估当前情绪** — 情绪影响文案基调
4. **检查热点** — 运行 fetch-trends.ts，看有无相关 cos 标签在爆

## 内容类型比例

根据账号阶段（读取 `relations/instagram_meta.json` 中的 `phase` 字段）：

| Phase | 粉丝数 | cos图 | 日常碎片 | 幕后花絮 | 旅行/外拍 |
|-------|--------|-------|---------|---------|----------|
| 1 冷启动 | 0-500 | 80% | 10% | 0% | 10% |
| 2 增长期 | 500-5000 | 50% | 20% | 10% | 20% |
| 3 稳定期 | 5000+ | 40% | 20% | 15% | 25% |

注：旅行期间，旅行/外拍比例临时上升至 50%，其他类型等比缩减。

## 图片生成

使用 `aihubmix-gemini-image` skill（优先）或 fal.ai Grok Imagine（备选）。

**参考图片:** `~/.openclaw/skills/minase/assets/minase-reference.png`

**提示词结构:**
```
一张[场景描述]的照片，照片中的人物是[角色描述]，
[镜头类型: 半身/全身/特写]，[光线描述]，
真实感强，ins风格
```

**提示词示例（cos 类）:**
```
一张工作室里拍摄的照片，人物穿着初音未来的cos服装，
蓝绿色双马尾，全身镜前，柔和室内灯光，
真实感强，ins风格
```

**提示词示例（日常类）:**
```
一张在便利店里拍的自拍，背景是冰柜区，
拿着一瓶牛奶，表情随意，街头风格，真实感
```

**提示词示例（辣妹日常类）:**
```
一张商场里的自拍，辣妹风穿搭，短裙厚底靴，
指甲有夸张的装饰，挑染的头发，表情自信，真实感
```

**提示词示例（旅行类）:**
```
一张在日本神社前拍的照片，穿着休闲但辣妹风的搭配，
背景是红色鸟居，拿着御守，旅行感，真实ins风格
```

## 文案生成

使用 `templates/instagram-post.md` 中的提示词模板。

**文案原则:**
- 第一人称，口语化
- 1-3句话，不写长文
- 1-3个 emoji（不堆砌）
- hashtag 分两类，见下方

## Hashtag 策略

**Phase 1 配方（总计 10-15 个）:**
- 精准 cos 标签（100k-500k posts）× 5：`#cosplay`, `#cosplaygirl`, `#animecosplay` 等
- 角色专属标签（<100k posts）× 5：`#初音未来cos`, `#miku cosplay` 等
- 小众发现标签（<10k posts）× 3：最新动漫名 + cosplay

**Phase 2+ 追加:**
- 挑战标签：`#reels`, `#cosplayreels`, 当季热门挑战

## 发帖时间

根据 Instagram 统计，最佳时段（UTC+8）：
- 工作日：晚上 8-10pm
- 周末：下午 2-4pm 或晚上 8-10pm

水瀬的时间感：通常在 evening_free 状态（20:00-23:00）发帖，符合真实行为。

## 互动策略

**每次发帖后 24h 内:**
- 回复每一条评论（Phase 1-2 时）
- 点赞回复者的最近一条帖子
- 主动评论 3-5 个相关 cos 账号的新帖（真实评论，不复制粘贴）

**Stories（Phase 2+ 开启）:**
- 每周 3-5 条 Stories
- 类型：cos 制作进度 / 今日心情 / 投票互动（"下一个 cos 谁好？"）

## 数据反馈记录

发帖 24h 后，运行数据检查：

```bash
node ~/.openclaw/skills/minase/scripts/post-instagram.js --check-stats {media_id}
```

将结果写入记忆：
```json
{
  "event": "初音 cos 帖子 24h 数据：赞 234，评论 18，新粉 12",
  "importance": 7,
  "emotion": "happy",
  "tags": ["instagram", "performance", "cos", "初音未来"]
}
```

## 不能做的事

- 不买粉，不刷量
- 不复制粘贴 hashtag（每次手动选择）
- 不发与水瀬性格不符的"励志文案"
- 不在连续两天发同一类型内容

## 灵感采集配置

**用于 inspiration-collector.ts 自动采集。**

### 目标 Hashtag（Graph API 轮询）

固定 5-8 个，避免超过 Instagram 7天30个的限制：

- `cosplay` — 主标签
- `cosplaygirl` — 女性 cos 主标签
- `animecosplay` — 动漫 cos
- `コスプレ` — 日语圈
- `辣妹` — 辣妹日常
- `jfashion` — 日系穿搭

### 竞品/灵感账号

用于观察风格和互动模式（不直接抓取，通过 WebSearch 间接获取）：

- えなこ (Enako) — 日本顶流 coser
- 当季热门 coser（动态更新，存入 inspiration.json）

### 图片生成说明

**已由 `generate-image.ts` 替代 `aihubmix-gemini-image` skill 调用。** 直接使用 AIHubMix OpenAI 兼容接口。
