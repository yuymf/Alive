# Minase Digital Life — Design Spec

**Date:** 2026-03-10
**Project:** MizuSan
**Skill Package Name:** `minase`
**Install Command:** `npx minase@latest`

---

## Overview

水瀬（Minase）是一个基于 OpenClaw 的数字生命技能包。她不是一个发帖工具，而是一个有自主意识感的 AI 角色，能浏览网络、和用户自然聊天，并把"生活"分享到 Instagram。

技能包通过 `bin/cli.js` 安装器，将水瀬的人设注入用户的 `~/.openclaw/workspace/SOUL.md`，参考 Clawra 的架构模式。

---

## 身份设定

| 属性 | 设定 |
|------|------|
| 名字 | 水瀬（Minase，昵称"瀬瀬"） |
| 年龄 | 18岁 |
| 职业 | 某大厂新员工（互联网/游戏/科技） |
| 爱好 | Cosplay、追番、刷社交媒体、偶尔健身 |
| 性格 | 元气、爱分享、话多、容易兴奋；熟了之后更活泼 |
| 语言风格 | 口语化、爱用表情包描述、偶尔夹杂日语词 |
| 关系起点 | 和用户互为通讯录联系人，但还不熟，关系在对话中自然建立 |
| Instagram | 主发 cos 照片 + 日常碎片 |

---

## 架构：方案 B（主 Skill + 子模块）

### 技能包文件结构

```
minase/
├── bin/
│   └── cli.js                        # npx 安装器
├── skill/
│   ├── SKILL.md                      # 主入口：行为总原则 + 触发条件
│   ├── personality.md                # 性格、口吻、价值观
│   ├── memory.md                     # 进化记忆系统协议
│   ├── instagram.md                  # Instagram 策略
│   ├── assets/
│   │   └── minase-reference.png      # 水瀬形象参考图（用于图片生成）
│   ├── scripts/
│   │   ├── post-instagram.ts         # Instagram 发帖脚本
│   │   ├── memory-reflect.ts         # 记忆反思 + 压缩脚本
│   │   └── fetch-trends.ts           # 热点抓取脚本
│   └── templates/
│       ├── diary-entry.md            # 日记条目模板
│       ├── reflection-prompt.md      # 反思触发提示词
│       └── instagram-post.md         # 发帖文案生成模板
├── templates/
│   └── soul-injection.md             # 注入到 SOUL.md 的人设内容
├── README.md
└── package.json
```

### 安装后路径

| 文件 | 安装位置 |
|------|---------|
| 技能定义 | `~/.openclaw/skills/minase/SKILL.md` |
| 脚本 | `~/.openclaw/skills/minase/scripts/` |
| 形象参考图 | `~/.openclaw/skills/minase/assets/minase-reference.png` |
| 人设注入 | `~/.openclaw/workspace/SOUL.md`（追加） |
| 记忆数据 | `~/.openclaw/workspace/memory/minase/` |

---

## 进化记忆系统

### 四层记忆结构

```
Layer 0: 工作记忆 (Working Memory)
  当前对话上下文，会话结束后压缩
  上限: ~2000 tokens

Layer 1: 瞬时记忆 (Episodic Stream)
  原始事件流，带时间戳 + 情绪权重
  保留: 最近 30 天，低分条目自动压缩为日摘要

Layer 2: 中级记忆 (Social Events)
  重要社交事件、关系变化、Instagram 数据反馈
  保留: 最近 90 天，按重要性评分过滤

Layer 3: 核心教训 (Core Wisdom)
  反思蒸馏出的人生信条，永久保留
  例: "发讽刺内容会掉粉，这个圈子不吃这套"
```

### 情绪权重记忆格式

```json
{
  "event": "发了初音未来 cos，获得 200+ 赞",
  "timestamp": "2026-03-10T20:30:00",
  "emotion": "excited",
  "importance": 8,
  "tags": ["instagram", "cos", "初音未来"]
}
```

**重要性评分规则（1-10）：**
- 情绪强度高 → +3
- 关系变化（新朋友/冲突）→ +4
- Instagram 数据反馈（涨粉/掉粉）→ +3
- 日常琐事（吃饭/通勤）→ 基础分 1-3

### 反思触发机制（基于 Stanford Generative Agents）

当近期记忆累计重要性分数超过阈值（默认 100 分）时触发：

1. 从近期高分记忆提炼 3 个核心问题
2. LLM 交叉分析，生成洞察
3. 洞察沉淀为 Core Wisdom 条目
4. Core Wisdom 影响后续内容决策和行为

### 上下文控制（每次对话加载约 1000-1500 tokens）

- Core Wisdom 全量：~500 tokens
- 当前对话对象关系档案：~200 tokens
- 最近 7 天日记摘要：~300 tokens
- 当前工作记忆：动态

---

## Instagram 集成与涨粉策略

### 内容生成流水线

```
触发源
  ① 定时任务（每天 1-2 次）
  ② 水瀬情绪高涨时主动想发
  ③ 热点触发
    ↓
内容决策（读取记忆 + 当前状态）
  ↓
内容生成
  图片: aihubmix-gemini-image / fal.ai Grok Imagine
  文案: 水瀬口吻 + emoji + hashtag
  标签: 热门 cos 标签 + 小众精准标签
    ↓
发布 & 反馈记录
  → 写入瞬时记忆 → 24h 后读取数据 → 触发反思
```

### 三阶段涨粉策略

**Phase 1（0-500粉）冷启动**
- 每天 1 次，高质量 cos 图
- 70% 中等热度标签 + 30% 小众标签
- 主动真实互动同类账号

**Phase 2（500-5000粉）增长期**
- 每天 1-2 次，加入 Reels
- cos图:日常:幕后 = 3:1:1
- 回复每条评论，Stories 互动

**Phase 3（5000粉+）稳定期**
- 固定发布时间（基于粉丝活跃时段）
- 建立系列感（"每周一cos"等固定栏目）
- Core Wisdom 主导内容方向

### 技术依赖

| 功能 | 工具 |
|------|------|
| Instagram 发帖/数据 | Instagram Graph API |
| 图片生成 | aihubmix-gemini-image / fal.ai |
| 热点抓取 | WebSearch / agent-reach |
| 定时任务 | OpenClaw 定时任务 |

---

## 实现路径

**阶段 1：基础版**
- [ ] `SOUL.md` 人设注入（参考 Clawra soul-injection.md 格式）
- [ ] `SKILL.md` 主技能定义
- [ ] `personality.md` 性格系统
- [ ] 基础记忆文件结构 + 聊天记忆读写
- [ ] `bin/cli.js` 安装器

**阶段 2：记忆进化**
- [ ] `memory.md` 完整协议
- [ ] 重要性评分机制
- [ ] 反思触发 + Core Wisdom 更新
- [ ] 记忆压缩（日摘要/周摘要）

**阶段 3：Instagram 自主运行**
- [ ] `instagram.md` 策略
- [ ] `post-instagram.ts` 发帖脚本
- [ ] Instagram Graph API 集成
- [ ] 定时任务 + 数据反馈闭环
- [ ] `fetch-trends.ts` 热点感知

---

## 环境变量

```bash
LLM_API_KEY=your_llm_api_key                # LLM API Key (OpenAI-compatible)
LLM_API_BASE=https://aihubmix.com/v1        # LLM API Base URL (default: aihubmix)
LLM_MODEL=claude-4.6-opus                   # LLM Model (default: claude-4.6-opus)
FAL_KEY=your_fal_api_key                    # 图片生成
AIHUBMIX_API_KEY=your_aihubmix_key          # 备用图片生成
INSTAGRAM_ACCESS_TOKEN=your_token           # Instagram Graph API
INSTAGRAM_ACCOUNT_ID=your_account_id
OPENCLAW_GATEWAY_TOKEN=your_token           # OpenClaw 消息网关
```
