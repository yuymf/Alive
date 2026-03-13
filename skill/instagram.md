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

使用 `aihubmix-gemini-image` skill（优先）或 AIHubMix OpenAI 兼容接口。

**参考图片:** `~/.openclaw/skills/minase/assets/minase-reference.png`

**提示词结构（叙事式，遵循 Google Gemini 推荐格式）:**
```
A photorealistic Instagram photo of [风格场景描述]. [具体场景/动作].
同一位女性（严格匹配参考图：五官轮廓、发型发色、体型），18岁，辣妹风，自信外放。Shot on [相机/镜头].
氛围自然真实，色彩高级清透，肤色自然不过曝，构图舒适，主体突出。
不要卡通/二次元风格；不要多余手指或肢体异常；不要文字水印
```

**提示词示例（cos 类）:**
```
A photorealistic Instagram photo of a professional cosplay photoshoot in a studio or scenic outdoor location, with precise costume detail and dramatic lighting. 工作室里拍摄的初音未来cos，蓝绿色双马尾，全身镜前，柔和室内灯光。
同一位女性（严格匹配参考图：五官轮廓、发型发色、体型），18岁，辣妹风，自信外放。Shot on Canon EOS R5, 85mm f/1.4, studio lighting, shallow depth of field.
氛围自然真实，色彩高级清透，肤色自然不过曝，构图舒适，主体突出。
不要卡通/二次元风格；不要多余手指或肢体异常；不要文字水印
```

**提示词示例（日常类）:**
```
A photorealistic Instagram photo of a casual everyday moment, street style, relaxed and candid. 便利店冰柜区里的自拍，拿着一瓶牛奶，表情随意。
同一位女性（严格匹配参考图：五官轮廓、发型发色、体型），18岁，辣妹风，自信外放。Shot on iPhone 15 Pro, natural lighting, casual framing.
氛围自然真实，色彩高级清透，肤色自然不过曝，构图舒适，主体突出。
不要卡通/二次元风格；不要多余手指或肢体异常；不要文字水印
真实感细节：允许轻微过曝和手持微晃，非专业但舒服的构图，主体偶尔偏离中心。
```

**提示词示例（旅行类）:**
```
A photorealistic Instagram photo of a travel snapshot at a scenic destination, blending the subject with the environment. 日本神社前，穿着休闲但辣妹风的搭配，背景是红色鸟居，拿着御守。
同一位女性（严格匹配参考图：五官轮廓、发型发色、体型），18岁，辣妹风，自信外放。Shot on iPhone 15 Pro wide angle, golden hour, travel snapshot feel.
氛围自然真实，色彩高级清透，肤色自然不过曝，构图舒适，主体突出。
不要卡通/二次元风格；不要多余手指或肢体异常；不要文字水印
真实感细节：自然色彩，有游客感，光线不完美，允许逆光或阴影。
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
node ~/.openclaw/skills/minase/scripts/post-instagram.js --check-stats {media_pk}
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

### 目标 Hashtag（instagrapi 轮询）

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
